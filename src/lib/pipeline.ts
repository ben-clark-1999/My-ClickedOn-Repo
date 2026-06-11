import { extractJson } from "./extract-json";
import { mockStream, type MockBehavior, type MockState } from "./anthropic-mock";

export interface GenerateInput {
  /** Drives the mock streaming client (see anthropic-mock.ts). */
  behavior: MockBehavior;
  /** Hands the finished draft to the next pipeline stage. May reject. */
  advanceToNextStage: () => Promise<void>;
  /** Returns true once the draft passes review. Scripted by callers/tests. */
  reviewPasses: (attempt: number) => boolean;
}

export interface GenerateResult {
  status: "ok" | "error";
  attempts: number;
}

const MAX_REVISIONS = 3;

/**
 * Runs one content-generation pass: stream a draft, extract it, revise until it
 * passes review, then hand off to the next stage.
 *
 * This is a faithful (stripped-down) reproduction of the real pipeline — and it
 * ships with three real bugs from that pipeline. Your job is to fix them so the
 * test suite passes. See the README for the symptoms. (Do not edit the tests.)
 */
export async function generate(input: GenerateInput): Promise<GenerateResult> {
  const state: MockState = { calls: 0 };

  // Stream the draft and pull its JSON out. The model call can fail transiently —
  // a dropped/truncated stream (no closing fence) or a rate-limit error — so retry
  // a bounded number of times. Each retry calls mockStream again with the SAME
  // state, advancing the per-run counter so we observe a fresh, recovered result
  // instead of re-reading the same failure.
  const MAX_STREAM_ATTEMPTS = 3;
  let extracted = false;
  for (let streamAttempt = 0; streamAttempt < MAX_STREAM_ATTEMPTS; streamAttempt++) {
    try {
      const text = await mockStream(input.behavior, state);
      extractJson(text); // throws on a truncated stream (no closing fence)
      extracted = true;
      break;
    } catch {
      // transient failure (truncated stream or rate limit) — try the model again
    }
  }
  if (!extracted) {
    return { status: "error", attempts: 0 };
  }

  // Revise until the draft passes review, but no more than MAX_REVISIONS times.
  // If it still hasn't passed after that, give up and report an error rather than
  // handing off (or spinning on) a draft that never met the bar.
  let attempt = 0;
  let passed = input.reviewPasses(attempt);
  while (!passed && attempt < MAX_REVISIONS) {
    attempt += 1;
    passed = input.reviewPasses(attempt);
  }
  if (!passed) {
    return { status: "error", attempts: attempt };
  }

  // Hand off to the next stage. A rejected hand-off must surface as an error,
  // so we await it (instead of fire-and-forget) and report failure to the caller.
  try {
    await input.advanceToNextStage();
  } catch {
    return { status: "error", attempts: attempt };
  }

  return { status: "ok", attempts: attempt };
}

export { MAX_REVISIONS };
