// Warm Roslyn server — precise, type-resolved C# references/callers/impls.
// Loads LedgerFlow.sln once, keeps the semantic model warm, live-updates changed .cs files,
// serves queries on http://127.0.0.1:47616. Managed by the Node codegraph daemon.
using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Build.Locator;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Text;

MSBuildLocator.RegisterDefaults();
await RoslynServer.Run();

static class RoslynServer
{
    // Project-agnostic: the daemon passes these via environment when spawning us.
    static readonly string SLN = Environment.GetEnvironmentVariable("CODEGRAPH_SLN") ?? "";
    static readonly string ROOT = Environment.GetEnvironmentVariable("CODEGRAPH_ROOT")
        ?? (string.IsNullOrEmpty(SLN) ? "." : Path.GetDirectoryName(SLN));
    static readonly int PORT = int.TryParse(Environment.GetEnvironmentVariable("CODEGRAPH_ROSLYN_PORT"), out var p) ? p : 47616;

    static volatile Solution _solution;
    static readonly object _lock = new();
    static readonly Dictionary<string, DocumentId> _docByPath = new(StringComparer.OrdinalIgnoreCase);
    static volatile bool _ready = false;
    static volatile bool _structuralDirty = false;
    static DateTime _loadedAt;

    public static async Task Run()
    {
        if (string.IsNullOrEmpty(SLN)) { Console.Error.WriteLine("[roslyn] no CODEGRAPH_SLN — nothing to do"); return; }
        var listener = new HttpListener();
        listener.Prefixes.Add($"http://127.0.0.1:{PORT}/");
        listener.Start();
        _ = Task.Run(Load);
        Watch();
        while (true)
        {
            var ctx = await listener.GetContextAsync();
            _ = Task.Run(() => Handle(ctx));
        }
    }

    static async Task Load()
    {
        var t0 = DateTime.UtcNow;
        var ws = MSBuildWorkspace.Create();
        ws.WorkspaceFailed += (s, e) => { };
        var sol = await ws.OpenSolutionAsync(SLN);
        lock (_lock)
        {
            _solution = sol;
            _docByPath.Clear();
            foreach (var p in sol.Projects) foreach (var d in p.Documents)
                if (d.FilePath != null) _docByPath[d.FilePath] = d.Id;
            _structuralDirty = false;
            _loadedAt = DateTime.UtcNow;
            _ready = true;
        }
        Console.WriteLine($"[roslyn] loaded {sol.Projects.Count()} projects, {_docByPath.Count} docs in {(DateTime.UtcNow - t0).TotalSeconds:F1}s");
    }

    static void Watch()
    {
        var w = new FileSystemWatcher(ROOT, "*.cs") { IncludeSubdirectories = true, EnableRaisingEvents = true,
            NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName };
        void Changed(object s, FileSystemEventArgs e)
        {
            if (e.FullPath.Contains(@"\bin\") || e.FullPath.Contains(@"\obj\")) return;
            lock (_lock)
            {
                if (_solution == null) return;
                if (_docByPath.TryGetValue(e.FullPath, out var id) && File.Exists(e.FullPath))
                {
                    try { _solution = _solution.WithDocumentText(id, SourceText.From(File.ReadAllText(e.FullPath))); } catch { }
                }
                else _structuralDirty = true;   // new/removed file -> needs /reindex for full accuracy
            }
        }
        w.Changed += Changed; w.Created += Changed; w.Deleted += Changed;
        w.Renamed += (s, e) => { lock (_lock) _structuralDirty = true; };
    }

    static async Task Handle(HttpListenerContext ctx)
    {
        try
        {
            var path = ctx.Request.Url!.AbsolutePath;
            var name = ctx.Request.QueryString["name"] ?? "";
            object result;
            if (path == "/status")
                result = new { ready = _ready, dirty = _structuralDirty, docs = _docByPath.Count, loadedAt = _loadedAt, pid = Environment.ProcessId, port = PORT };
            else if (path == "/reindex") { await Load(); result = new { reindexed = true, docs = _docByPath.Count }; }
            else if (!_ready) result = new { error = "warming up — solution still loading" };
            else if (path == "/def") result = await Def(name);
            else if (path == "/refs") result = await Refs(name);
            else if (path == "/callers") result = await Callers(name);
            else if (path == "/impl") result = await Impls(name);
            else { ctx.Response.StatusCode = 404; result = new { }; }
            var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(result));
            ctx.Response.ContentType = "application/json";
            await ctx.Response.OutputStream.WriteAsync(bytes);
        }
        catch (Exception ex) { try { ctx.Response.StatusCode = 500; var b = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { error = ex.Message })); await ctx.Response.OutputStream.WriteAsync(b); } catch { } }
        finally { try { ctx.Response.Close(); } catch { } }
    }

    static async Task<IEnumerable<ISymbol>> Find(string name)
        => await SymbolFinder.FindSourceDeclarationsAsync(_solution, name, false);

    static object Loc(Location l, string kind = null)
    { var ls = l.GetLineSpan(); return new { file = ls.Path, line = ls.StartLinePosition.Line + 1, kind }; }

    static async Task<object> Def(string name)
    {
        var syms = await Find(name);
        var res = syms.SelectMany(s => s.Locations.Where(l => l.IsInSource).Select(l => Loc(l, $"{s.Kind}:{s.ContainingType?.Name ?? s.ContainingNamespace?.Name}")));
        return new { name, precise = true, results = res.ToList() };
    }

    static async Task<object> Refs(string name)
    {
        var sol = _solution; var syms = (await Find(name)).ToList();
        var seen = new HashSet<string>(); var res = new List<object>();
        foreach (var sym in syms)
            foreach (var r in await SymbolFinder.FindReferencesAsync(sym, sol))
                foreach (var loc in r.Locations)
                {
                    var ls = loc.Location.GetLineSpan(); var key = ls.Path + ":" + ls.StartLinePosition.Line;
                    if (seen.Add(key)) res.Add(new { file = ls.Path, line = ls.StartLinePosition.Line + 1, sym = r.Definition.ContainingType?.Name + "." + r.Definition.Name });
                }
        return new { name, precise = true, symbolsMatched = syms.Count, results = res };
    }

    static async Task<object> Callers(string name)
    {
        var sol = _solution; var syms = (await Find(name)).Where(s => s.Kind == SymbolKind.Method).ToList();
        var res = new List<object>();
        foreach (var sym in syms)
            foreach (var c in await SymbolFinder.FindCallersAsync(sym, sol))
                foreach (var l in c.Locations)
                { var ls = l.GetLineSpan(); res.Add(new { file = ls.Path, line = ls.StartLinePosition.Line + 1, caller = c.CallingSymbol.ContainingType?.Name + "." + c.CallingSymbol.Name }); }
        return new { name, precise = true, results = res };
    }

    static async Task<object> Impls(string name)
    {
        var sol = _solution; var syms = await Find(name); var res = new List<object>();
        foreach (var sym in syms)
        {
            if (sym is INamedTypeSymbol t)
            {
                foreach (var d in await SymbolFinder.FindImplementationsAsync(t, sol)) res.AddRange(d.Locations.Where(l => l.IsInSource).Select(l => Loc(l, "impl")));
                foreach (var d in await SymbolFinder.FindDerivedClassesAsync(t, sol)) res.AddRange(d.Locations.Where(l => l.IsInSource).Select(l => Loc(l, "derived")));
            }
            else if (sym.IsVirtual || sym.IsAbstract)
                foreach (var o in await SymbolFinder.FindOverridesAsync(sym, sol)) res.AddRange(o.Locations.Where(l => l.IsInSource).Select(l => Loc(l, "override")));
        }
        return new { name, precise = true, results = res };
    }
}
