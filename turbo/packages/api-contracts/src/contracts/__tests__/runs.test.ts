import { describe, expect, it } from "vitest";

import {
  claudeToolEntrySchema,
  networkLogEntrySchema,
  unifiedRunRequestSchema,
} from "../runs";

describe("Claude tool entry contract", () => {
  it("accepts single Claude tool names", () => {
    expect(claudeToolEntrySchema.safeParse("Bash").success).toBe(true);
    expect(claudeToolEntrySchema.safeParse("mcp__github__search").success).toBe(
      true,
    );
  });

  it("rejects ambiguous Claude tool entries", () => {
    for (const tool of ["", "   ", "Bash,Read", "--help", " -x"]) {
      expect(claudeToolEntrySchema.safeParse(tool).success).toBe(false);
    }
  });
});

describe("unified run request contract", () => {
  it("rejects checkpoint resume requests", () => {
    expect(
      unifiedRunRequestSchema.safeParse({
        checkpointId: "11111111-1111-4111-8111-111111111111",
        prompt: "resume from checkpoint",
      }).success,
    ).toBe(false);
  });
});

describe("network log model catalog cache telemetry", () => {
  const baseEntry = {
    timestamp: "2026-07-27T12:00:00.000Z",
    type: "http",
  };

  it("accepts bounded cache outcome fields", () => {
    expect(
      networkLogEntrySchema.safeParse({
        ...baseEntry,
        model_catalog_cache_status: "model_catalog_revalidated_200_same",
        model_catalog_cache_upstream_encoding: "br",
        model_catalog_cache_bypass_reason: "response_cache_control",
        model_catalog_cache_entry_age_ms: 61_000,
        model_catalog_cache_validation_latency_ms: 1700,
        model_catalog_cache_eviction_count: 1,
        model_catalog_prefetch_role: "inflight_consumer",
      }).success,
    ).toBe(true);
  });

  it("rejects cache outcome values outside the declared vocabulary", () => {
    expect(
      networkLogEntrySchema.safeParse({
        ...baseEntry,
        model_catalog_cache_status: "credential-specific-value",
      }).success,
    ).toBe(false);
    expect(
      networkLogEntrySchema.safeParse({
        ...baseEntry,
        model_catalog_cache_upstream_encoding: "gzip",
      }).success,
    ).toBe(false);
    expect(
      networkLogEntrySchema.safeParse({
        ...baseEntry,
        model_catalog_cache_bypass_reason: "provider-body-details",
      }).success,
    ).toBe(false);
    expect(
      networkLogEntrySchema.safeParse({
        ...baseEntry,
        model_catalog_prefetch_role: "account-specific-value",
      }).success,
    ).toBe(false);
  });

  it("rejects cache telemetry numbers outside their bounds", () => {
    for (const invalidEntry of [
      { model_catalog_cache_entry_age_ms: -1 },
      { model_catalog_cache_entry_age_ms: 1.5 },
      { model_catalog_cache_entry_age_ms: 2_147_483_648 },
      { model_catalog_cache_validation_latency_ms: -1 },
      { model_catalog_cache_validation_latency_ms: Number.POSITIVE_INFINITY },
      { model_catalog_cache_eviction_count: -1 },
      { model_catalog_cache_eviction_count: 1.5 },
      { model_catalog_cache_eviction_count: 33 },
    ]) {
      expect(
        networkLogEntrySchema.safeParse({
          ...baseEntry,
          ...invalidEntry,
        }).success,
      ).toBe(false);
    }
  });
});

describe("network log connector diagnostic identity", () => {
  it("preserves the canonical connector slug", () => {
    expect(
      networkLogEntrySchema.parse({
        timestamp: "2026-07-30T03:00:00.000Z",
        connector_diagnostic_slug: "github",
      }).connector_diagnostic_slug,
    ).toBe("github");
  });
});
