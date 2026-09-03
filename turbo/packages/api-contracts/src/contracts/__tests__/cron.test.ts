import {
  cronConsolidatePiMemoryPhase2Contract,
  cronConsolidatePiMemoryPhase2ResponseSchema,
} from "../cron";
import { describe, expect, it } from "vitest";

describe("Pi memory cron contracts", () => {
  it("exports the exact Phase 2 route and content-free counter response", () => {
    expect(cronConsolidatePiMemoryPhase2Contract.consolidate.method).toBe(
      "GET",
    );
    expect(cronConsolidatePiMemoryPhase2Contract.consolidate.path).toBe(
      "/api/cron/consolidate-pi-memory-phase2",
    );

    const response = {
      success: true,
      claimed: 1,
      noWork: 0,
      noDiff: 0,
      published: 1,
      conflicted: 0,
      stale: 0,
      failed: 0,
    };
    expect(
      cronConsolidatePiMemoryPhase2ResponseSchema.safeParse(response).success,
    ).toBe(true);
    expect(
      cronConsolidatePiMemoryPhase2ResponseSchema.safeParse({
        ...response,
        publishedVersionId: "private-version-id",
      }).success,
    ).toBe(false);
  });
});
