import { describe, it, expect } from "vitest";
import { generate } from "../lib/pipeline";

// Bonus test (README: "add one test of your own that covers an edge case").
//
// The four gate tests only assert on generate()'s RETURN VALUE. None of them
// observe its side effects — so an implementation that fired off
// advanceToNextStage() before (or regardless of) the review check would pass
// every gate test while leaking an unreviewed draft into the next pipeline
// stage. This file pins down the side-effect contract: a failed run must not
// hand off, and a successful run hands off exactly once.

describe("Hand-off side effects", () => {
  it("never calls advanceToNextStage when review never passes", async () => {
    let handOffs = 0;
    const res = await generate({
      behavior: "ok",
      advanceToNextStage: async () => {
        handOffs += 1;
      },
      reviewPasses: () => false,
    });
    expect(res.status).toBe("error");
    expect(handOffs).toBe(0);
  });

  it("calls advanceToNextStage exactly once on a successful run", async () => {
    let handOffs = 0;
    const res = await generate({
      behavior: "ok",
      advanceToNextStage: async () => {
        handOffs += 1;
      },
      reviewPasses: () => true,
    });
    expect(res.status).toBe("ok");
    expect(handOffs).toBe(1);
  });
});
