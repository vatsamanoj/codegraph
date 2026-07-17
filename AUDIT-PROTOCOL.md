# The Codegraph Audit Protocol

A lightweight ritual that makes codegraph **compound in value** and keeps you (or your AI agent) honest about how much it actually helped. Run it on any non-trivial code task — a bug hunt, a feature, an impact analysis, a refactor.

The idea in one line: **every time codegraph *can't* answer something and you fall back to grep/read, ask whether that was a real gap — and if it was, close it — then report what the tool saved.** Do that for a few weeks and codegraph fits your codebase like it was written for it.

## The loop

**1. Codegraph-first navigation.** Take every lookup hop to codegraph before anything else:

```
cg text "<a string from the task/bug report>"   # concept → the enclosing symbol
cg callers <symbol> --precise                    # who calls it (type-exact)
cg refs <symbol> --precise                       # every reference
cg impact <symbol>                               # refs + seams + change checklist
```

Grep is legitimate for exactly **one** thing: the *first* unknown string, when you don't yet have a symbol. The moment `cg text` hands you an enclosing symbol, pivot to `cg` — don't keep grepping through symbol hops out of habit.

**2. Log the fallbacks.** Each time you drop to grep / file-reading / manual reasoning *because codegraph couldn't answer*, note it as a **miss** and why.

**3. Triage each miss:**
- **Legitimate** — codegraph structurally shouldn't answer it: the first unknown string, a judgment call, designing a novel fix. Not a failure; don't build anything.
- **Fixable gap** — codegraph *should* have been able to answer and didn't. A candidate for a new capability.

**4. Close real gaps (deliberately, not reflexively).** For a fixable gap that is **general and will recur**, add the capability to codegraph, test it against the exact miss that exposed it, and document it. Resist building a bespoke feature for a one-off — over-fitting the tool is its own failure mode. (`cg text` itself came out of this step: the gap was "codegraph indexes identifiers, so a string concept like a CSS class or UI label had no answer, and a grep hit didn't tell you *which function you were in*.")

**5. Emit a scorecard.** Close the task with a short, honest report:

```
Codegraph Audit — <task>
 Hops: N → codegraph a | fallback b   (legitimate x, gap y)
 Assist ratio: a/N%      Reasoning that no tool replaces: <diagnosis / fix design / judgment>
 Gap → mechanism: <none | added cg <feature>, tested>
 Precision win: <e.g. cg --precise gave 8 real callers vs grep's ~29 name-matches>
 Est. tokens saved vs no-codegraph: ~k     Round-trips saved: ~r
```

## Making the numbers honest

- **Assist ratio and the reasoning split are *counted*, not estimated** — hops are countable. Report a low ratio plainly; inflating it defeats the point.
- **Token/time figures are *estimates* from a fixed unit-cost model** — label them as estimates, don't imply instrumented precision. A reasonable default model (tune it to your setup):

  | Operation | ~tokens | round-trips |
  |---|---|---|
  | `cg` query (text/refs/callers/impact) | 250 | 1 |
  | grep, file list | 150 | 1 |
  | grep, content (moderate) | 600 | 1 |
  | read a targeted slice of a file | 700 | 1 |
  | read a whole file just to find the enclosing function | 1500 | 1 |

  A symbol hop that `cg text`/`callers` answers typically replaces *a grep plus a read-to-find-the-enclosing-function* — on the order of **1.5–2k tokens saved per hop**. Report **time as round-trips avoided** (a latency proxy), not invented minutes.
- **Precision is a distinct win from speed.** `--precise` removing false positives that grep would surface is a *correctness* gain — worth reporting even when the token delta is small.

## Why every codegraph user benefits

- **The tool compounds.** Gaps become features instead of recurring friction, so codegraph converges on *your* codebase's real navigation patterns.
- **Honest ROI.** You get a running, auditable picture of where codegraph earns its keep — and where your own judgment did the work — instead of taking either on faith.
- **It resists two opposite failure modes at once:** grepping by reflex when a symbol query is faster, *and* over-building the tool for one-offs.

Keep a running ledger (one row per task: date, assist ratio, gap, mechanism, estimated savings) if you want to watch the ROI curve over time.
