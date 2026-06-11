# Decision log

A running, chronological record of how I worked this challenge — the steps I
took, the order I took them in, and *why*. The point is to show my thinking and
my workflow, not just the final diff.

Two parts:
- **Workflow log** — what I did, step by step, newest entries appended at the bottom.
- **Per-bug decisions** — for each bug: what was broken, my diagnosis, what I
  asked the AI, where the AI was wrong or incomplete, what I verified myself.

---

## Workflow log

### 1 — Ran `/init` in Claude Code (2026-06-10)
**What:** First action on the repo was running Claude Code's `/init`, which
analyzes the codebase and writes a `CLAUDE.md`.

**Why:** Before touching any code I wanted a shared, accurate map of the repo
that both I and the AI work from. `/init` forces an explicit read of the README,
package scripts, tsconfig, the grading workflow, and the `src/lib` source. That
surfaced the things most likely to trip up a careless fix:
- the hard constraint that `src/__tests__/pipeline.test.ts` and
  `.github/workflows/grade.yml` must stay unmodified (the grader checks them),
- the exact build/test/lint/typecheck commands the CI gate runs,
- the architecture detail that the mock streaming client is driven by a per-run
  call counter, so the truncation/429 fixes hinge on *calling it again*.

Front-loading that context means every later AI interaction is grounded in how
this repo actually behaves, instead of the model guessing. It also gives me a
written reference to check the AI's later suggestions against.

### 2 — Set up this decision log + cross-session persistence (2026-06-10)
**What:** Turned `DECISIONS.md` into a living workflow log (this file) and added
an instruction to `CLAUDE.md` telling every future Claude session to keep it
updated as work proceeds.

**Why:** I want the reasoning captured as I go, not reconstructed at the end. The
persistence matters because Claude Code starts fresh each window with no memory
of past sessions — but it *does* auto-load `CLAUDE.md` at the start of every
session in this repo. Putting the "maintain DECISIONS.md" instruction there means
a new window picks the habit back up automatically.

### 3 — Ran the gate commands and triaged the failures (2026-06-10)
**What:** Installed with `npm ci`, then ran all four gate checks. `typecheck`,
`lint`, and `build` are green; only `npm test` fails — 4 cases across the 3 bugs.
Before changing anything I read `pipeline.ts`, the (protected) test, plus
`anthropic-mock.ts` and `extract-json.ts`, and mapped each failure to a line:
- Bug 1 → `pipeline.ts:43`, the fire-and-forget `void advanceToNextStage().catch(...)`.
- Bug 2 → `pipeline.ts:33-34`, a single `mockStream` call; truncated text makes
  `extractJson` throw at `extract-json.ts:11`.
- Bug 3a → same single call; `transient-429-twice` throws at `anthropic-mock.ts:31`.
- Bug 3b → `pipeline.ts:38`, the `attempt < 50` loop that always returns `ok`.

**Why:** I wanted the real error output and to confirm *which* checks fail rather
than assume. Knowing only the tests fail lets me focus entirely on `pipeline.ts`
behaviour. I'm deliberately fixing one bug at a time and re-running just that
bug's test after each change, so every fix is independently verified and I never
conflate two changes.

### 4 — Captured the "explain before editing" cadence in CLAUDE.md (2026-06-10)
**What:** Added a second "Working norm" section to `CLAUDE.md` requiring that,
before any code change, the AI states the root cause + exact change + why, then
stops and waits for my go-ahead. (Also mirrored in Claude's project memory.)

**Why:** Earlier the AI bundled *explaining* Bug 1 with *fixing* it in one turn.
I want an explicit understand-and-approve checkpoint before code changes so I stay
in the driver's seat — that's the whole point of this challenge. Putting it in
`CLAUDE.md` means a fresh session auto-loads it, so the cadence survives across
windows instead of relying on one conversation's memory.

### 5 — Checkpointed on a feature branch, not main (2026-06-11)
**What:** Created `fix/pipeline-bugs`, committed the project docs and the Bug 1
fix as two separate commits, and pushed the branch. Left `main` untouched.

**Why:** `main` should stay green/deployable, and the `grade` action runs on every
push to `main` — pushing partial work (1 of 3 bugs fixed) would leave a red CI run
on `main`. Doing the work on a branch keeps `main`'s only `grade` run a passing one
(at merge time) and gives a clean, reviewable per-change history. That's standard
practice and the right signal for a challenge graded on workflow. I'll open a PR
and merge to `main` once all three bugs are fixed and the full gate is green locally.

### 6 — Implemented the bounded stream retry (Bug 2, and Bug 3a for free) (2026-06-11)
**What:** Replaced the single `mockStream` + `extractJson` call with a bounded
(3-attempt) retry loop that re-calls the model with the SAME `state` on any
failure. Verified Bug 2 in isolation (`truncated stream` passes), then ran the
whole suite: now 3/4 green (Bugs 1, 2, and 3a); typecheck/lint/build all clean.
Only Bug 3b (the unbounded revision loop) remains.

**Why:** Truncation and 429s are the same class of problem — a transient
model-call failure whose only recovery is to call again — so one retry mechanism
fixes both Bug 2 and Bug 3a. I checked Bug 2 alone first, then the full suite, to
confirm 3a flipped green as expected and nothing regressed.

---

## Per-bug decisions

### Bug 1: Silent hand-off failures
- Symptom: With a hand-off that rejects, `generate` still returned `status: "ok"`
  (test asserted `"error"`).
- Root cause: `pipeline.ts:43` did `void input.advanceToNextStage().catch(() => {})`
  — fire-and-forget, with the rejection explicitly swallowed. The function returned
  `"ok"` on the next line regardless of whether the hand-off actually succeeded.
- Fix and why this approach: `await` the hand-off inside a `try/catch` and return
  `{ status: "error", attempts }` if it rejects. Awaiting is the minimal change
  that makes the failure observable; the catch turns it into the contract's error
  result instead of an unhandled rejection.
- AI's contribution / where it was wrong: AI correctly identified the fire-and-forget
  pattern. I kept the catch binding-less (`catch {}`) so it stays lint/typecheck
  clean under `noUnusedLocals`/`noUnusedParameters`.
- Verified by: `npx vitest run -t "failed hand-off"` → 1 passed (3 skipped). The
  other bugs still fail, confirming this change is isolated to Bug 1.

### Bug 2: Truncated stream crashes the run
- Symptom: With `behavior: "truncate-once"`, `generate` threw `No fenced JSON block
  found` instead of returning a status — one dropped stream killed the whole run.
- Root cause: `mockStream` was called exactly once (`pipeline.ts:33`). The first
  `truncate-once` response is cut off with no closing ``` fence, so `extractJson`'s
  regex matched nothing and it threw (`extract-json.ts:10-11`); that throw was
  uncaught and propagated out of `generate`.
- Fix and why this approach: wrapped stream + extract in a bounded (3-attempt)
  retry loop. On failure it re-calls `mockStream` with the SAME `state`, so the
  per-run counter advances and the retry returns full content — recovery is
  "call again", per the mock's contract, not salvaging the truncated text. Bounded
  so a persistent failure can't spin past the 5s test timeout; it only proceeds
  when extraction actually succeeded (no gaming).
- AI's contribution / where it was wrong: AI proposed the retry. I had it use a
  dedicated `MAX_STREAM_ATTEMPTS` constant rather than reuse `MAX_REVISIONS` — "how
  many times to retry the model" and "how many times to revise a draft" are
  different bounds that shouldn't be coupled. I also confirmed reusing `state`
  (not a fresh one) is what actually makes the retry recover.
- Verified by: `npx vitest run -t "truncated stream"` passes; full `npm test` is
  now 3/4 (only Bug 3b left); typecheck/lint/build clean.

### Bug 3: Transient 429s kill the run / revision loop can spin
- Symptom:
- Root cause:
- Fix and why this approach:
- AI's contribution / where it was wrong:
- Verified by:
