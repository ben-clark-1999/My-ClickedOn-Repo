# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working norm: keep DECISIONS.md updated

The author is maintaining `DECISIONS.md` as a living, chronological log of their
workflow and reasoning — it's part of what this challenge is graded on. As you
work in this repo, keep it current:

- Append a **Workflow log** entry whenever you take a meaningful step (running a
  command, choosing an approach, changing direction), with a short *what* and
  *why*. Newest entries go at the bottom.
- When a bug is fixed, fill in its **Per-bug decisions** record (symptom, root
  cause, fix and why, where the AI was wrong/incomplete, how it was verified).
- Write it in the author's first person ("I…"), matching the existing entries.

This instruction lives here so it survives across sessions — a new Claude window
auto-loads `CLAUDE.md`, sees this, and resumes the documentation habit.

## Working norm: explain before editing code

Before changing any code, explain first and wait for the author's go-ahead:

- State the **root cause**, the **exact change** you intend to make, and **why**.
- Then STOP. Do not edit, create, or apply a fix in the same turn — wait for the
  author to approve or adjust the approach.
- This is per step: one bug / one change at a time, each explained and approved
  before the code is touched.
- Investigation is exempt — reading files and running read-only commands (the
  gate checks, `git status`, etc.) don't need approval. Only code edits do. Edits
  the author has explicitly asked for are already approved.

Like the norm above, this lives here so the cadence survives across sessions: a
new Claude window auto-loads `CLAUDE.md` and picks it back up automatically.

## What this repo is

This is the ClickedOn "AI-Native Software Engineer" hiring challenge: a small, deliberately broken slice of a content-generation pipeline. The task is to fix three real bugs in `src/lib/pipeline.ts` so the gate tests pass, while keeping `typecheck`, `lint`, and `build` green. A GitHub Action named `grade` (`.github/workflows/grade.yml`) runs all four checks on every push to `main`.

## Hard constraints (the grader enforces these)

- **Do not edit `src/__tests__/pipeline.test.ts` or `.github/workflows/grade.yml`.** The grader checks both are unmodified; changing either disqualifies the submission. Fix the source, not the tests.
- **Do not game the tests.** Hard-coding return values, deleting logic, or otherwise passing without genuinely fixing the behavior is explicitly disqualifying. Find and fix the root cause.

## Commands

```bash
npm ci            # install (CI uses this)
npm test          # vitest run — the four gate tests
npm run typecheck # tsc --noEmit (strict, noUnusedLocals/Parameters on)
npm run lint      # eslint src
npm run build     # tsc -p tsconfig.json -> dist/
```

Run a single test file or case:

```bash
npx vitest run src/__tests__/pipeline.test.ts
npx vitest run -t "truncated stream"     # filter by test/describe name
```

`vitest.config.ts` sets a 5s `testTimeout` so a runaway loop fails the suite instead of hanging CI — treat a timeout as a bug in the revision loop, not a flaky test.

## Architecture

The graded logic lives entirely in `src/lib`. Everything else exists for context.

- **`src/lib/pipeline.ts`** — `generate(input)` runs one content-generation pass: stream a draft → `extractJson` → revise until `reviewPasses` → `advanceToNextStage`, returning `{ status: "ok" | "error", attempts }`. This is the only file you should need to change.
- **`src/lib/anthropic-mock.ts`** — deterministic, offline stand-in for the streaming Anthropic client. `mockStream(behavior, state)` is driven by `behavior` plus a per-run call counter (`state.calls`), so retries observe *different* results across calls:
  - `"ok"` → full fenced JSON every call.
  - `"truncate-once"` → first call returns JSON cut off mid-block (missing closing fence); later calls return full content. **Recovery means calling again**, not parsing the truncated text.
  - `"transient-429-twice"` → first two calls throw a `429` (`TransientError` with `.status`); the third succeeds. **Recovery means retrying**, with the same `state` so the counter advances.
- **`src/lib/extract-json.ts`** — pulls JSON from a ```` ```json ... ``` ```` fence; throws `"No fenced JSON block found"` on a truncated stream.
- **`src/api/generate.ts`** — illustrative HTTP handler showing how `generate` is called in production; not graded, no need to change.
- **`src/fixtures/deck.{full,truncated}.json`** — the `full`/`truncated` payloads the mock returns.

### The three bugs (per the README) and what the tests assert

1. **Silent hand-off failure** — `advanceToNextStage()` is fire-and-forget with its rejection swallowed, so a failed hand-off still returns `status: "ok"`. The test expects `status: "error"` when it rejects (so the hand-off must be awaited and its failure surfaced).
2. **Truncated stream crashes the run** — `extractJson` throws and kills the pass. The test expects recovery by re-calling `mockStream` (which returns full content on the retry).
3. **Transient 429s kill the run; revision loop can spin** — a single 429 takes everything down with no retry, and the revision loop is unbounded relative to the contract. Tests expect: retry through two 429s and succeed; and when review never passes, stop and return `status: "error"` with `attempts <= 3`. Note `MAX_REVISIONS = 3` is exported and is the intended bound (the current loop uses `< 50`).

The shipped code calls `mockStream` exactly once and never retries — both stream-level fixes hinge on calling it again with the same `state`.

## Bonus

The README invites adding one of your own tests covering an edge case. Put new tests in a separate file (e.g. `src/__tests__/`) — do **not** add them to the protected `pipeline.test.ts`.
