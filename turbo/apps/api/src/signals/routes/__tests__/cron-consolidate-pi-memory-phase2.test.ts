import { cronConsolidatePiMemoryPhase2Contract } from "@okouai/api-contracts/contracts/cron";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { cronConsolidatePiMemoryPhase2Routes } from "../cron-consolidate-pi-memory-phase2";

const context = testContext();
const CRON_SECRET = "test-pi-memory-phase2-secret";

function apiClient() {
  return setupApp({
    context,
    routes: cronConsolidatePiMemoryPhase2Routes,
  })(cronConsolidatePiMemoryPhase2Contract);
}

function cronHeaders(secret = CRON_SECRET) {
  return { authorization: `Bearer ${secret}` };
}

describe("POST /api/cron/consolidate-pi-memory-phase2", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", CRON_SECRET);
    mockEnv("PI_MEMORY_BACKGROUND_WORKERS_ENABLED", "false");
  });

  it("authenticates before the disabled breaker", async () => {
    const response = await accept(
      apiClient().consolidate({
        headers: cronHeaders("invalid-secret"),
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { code: "UNAUTHORIZED", message: "Invalid cron secret" },
    });
  });

  it("returns all-zero counters when disabled", async () => {
    const response = await accept(
      apiClient().consolidate({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      claimed: 0,
      noWork: 0,
      noDiff: 0,
      published: 0,
      conflicted: 0,
      stale: 0,
      failed: 0,
    });
  });
});
