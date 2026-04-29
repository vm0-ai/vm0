import { describe, expect, it } from "vitest";
import {
  deriveUsageEventIdempotencyKey,
  encodeUuidName,
  parseCliOptions,
  planUsageEventsForSourceRow,
  splitCreditsForSourceRow,
  uuidV5,
  type CreditPricingRow,
  type CreditUsageSourceRow,
} from "./backfill";

const createdAt = new Date("2026-04-01T00:00:00.000Z");
const processedAt = new Date("2026-04-01T00:01:00.000Z");

function sourceRow(
  overrides: Partial<CreditUsageSourceRow> = {},
): CreditUsageSourceRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222",
    resultUuid: null,
    messageId: "message-1",
    orgId: "org_test",
    userId: "user_test",
    model: "claude-sonnet-4-20250514",
    modelProvider: "anthropic",
    inputTokens: 10,
    outputTokens: 30,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    creditsCharged: 7,
    status: "processed",
    createdAt,
    processedAt,
    ...overrides,
  };
}

function pricing(overrides: Partial<CreditPricingRow> = {}): CreditPricingRow {
  return {
    model: "claude-sonnet-4-20250514",
    modelProvider: "anthropic",
    inputTokenPrice: 100_000,
    outputTokenPrice: 200_000,
    cacheReadTokenPrice: 50_000,
    cacheCreationTokenPrice: 300_000,
    ...overrides,
  };
}

describe("credit_usage usage_event backfill helpers", () => {
  it("defaults CLI options to dry-run mode", () => {
    expect(parseCliOptions([])).toEqual({
      migrate: false,
      batchSize: 500,
      orgId: undefined,
      limit: undefined,
      failOnAnomaly: false,
    });
  });

  it("parses scoped write options and rejects non-positive numeric options", () => {
    expect(
      parseCliOptions([
        "--migrate",
        "--org-id=org_test",
        "--limit=10",
        "--batch-size=25",
        "--fail-on-anomaly",
      ]),
    ).toEqual({
      migrate: true,
      batchSize: 25,
      orgId: "org_test",
      limit: 10,
      failOnAnomaly: true,
    });

    expect(() => {
      parseCliOptions(["--limit=0"]);
    }).toThrow("--limit must be a positive safe integer");

    expect(() => {
      parseCliOptions(["--batch-size=1001"]);
    }).toThrow("--batch-size must be <= 1000");

    expect(() => {
      parseCliOptions(["--org-id="]);
    }).toThrow("--org-id must not be blank");
  });

  it("encodes UUID names with byte-length-prefixed parts", () => {
    expect(encodeUuidName(["run-123", "msg-456", "tokens.input"])).toBe(
      "7:run-123\0" + "7:msg-456\0" + "12:tokens.input",
    );
  });

  it("matches Python UUIDv5 output used by the model usage producer", () => {
    expect(
      uuidV5(
        "18a22204-d25e-4170-8973-86477f864bfb",
        encodeUuidName(["run-123", "msg-456", "tokens.input"]),
      ),
    ).toBe("1f58e71b-bb06-5114-984c-64021c8a5626");
  });

  it("uses producer-compatible idempotency keys for message_id rows", () => {
    const key = deriveUsageEventIdempotencyKey(
      sourceRow({
        runId: "550e8400-e29b-41d4-a716-446655440000",
        messageId: "message-1",
      }),
      "tokens.output",
    );

    expect(key).toBe("1604578e-1def-5c7d-8de5-2a7dc31b0f73");
  });

  it("uses a distinct deterministic shape for result_uuid rows", () => {
    const key = deriveUsageEventIdempotencyKey(
      sourceRow({
        id: "source-id",
        messageId: null,
        resultUuid: "result-id",
      }),
      "tokens.cache_read",
    );

    expect(key).toBe("ded013ae-7871-500f-812b-a53ba9025393");
  });

  it("uses source identity for message_id rows whose run_id was deleted", () => {
    const first = deriveUsageEventIdempotencyKey(
      sourceRow({
        id: "source-a",
        runId: null,
        messageId: "message-1",
      }),
      "tokens.input",
    );
    const second = deriveUsageEventIdempotencyKey(
      sourceRow({
        id: "source-b",
        runId: null,
        messageId: "message-1",
      }),
      "tokens.input",
    );

    expect(first).toBe("13fc02e4-35af-524f-ad90-bda3b933fd5a");
    expect(second).toBe("cf184e09-7a22-5a68-b7ec-21c2f795a7e6");
  });

  it("uses credit_pricing split when it matches the source total", () => {
    const split = splitCreditsForSourceRow(
      sourceRow({ inputTokens: 1, outputTokens: 2, creditsCharged: 3 }),
      pricing({
        inputTokenPrice: 1_000_000,
        outputTokenPrice: 1_000_000,
      }),
    );

    expect(split.strategy).toBe("pricing");
    expect(split.creditsByCategory.get("tokens.input")).toBe(1);
    expect(split.creditsByCategory.get("tokens.output")).toBe(2);
  });

  it("falls back to deterministic token allocation when pricing mismatches", () => {
    const split = splitCreditsForSourceRow(
      sourceRow({ inputTokens: 10, outputTokens: 30, creditsCharged: 7 }),
      pricing({ inputTokenPrice: 1, outputTokenPrice: 1 }),
    );

    expect(split.strategy).toBe("token-allocation");
    expect(split.warning?.code).toBe("pricing_mismatch");
    expect(split.creditsByCategory.get("tokens.input")).toBe(2);
    expect(split.creditsByCategory.get("tokens.output")).toBe(5);
  });

  it("falls back to deterministic token allocation when pricing is missing", () => {
    const split = splitCreditsForSourceRow(
      sourceRow({ inputTokens: 10, outputTokens: 30, creditsCharged: 7 }),
      undefined,
    );

    expect(split.strategy).toBe("token-allocation");
    expect(split.warning?.code).toBe("missing_credit_pricing");
    expect(split.creditsByCategory.get("tokens.input")).toBe(2);
    expect(split.creditsByCategory.get("tokens.output")).toBe(5);
  });

  it("allocates high safe integer totals without floating point drift", () => {
    const split = splitCreditsForSourceRow(
      sourceRow({
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: 1,
        creditsCharged: Number.MAX_SAFE_INTEGER,
      }),
      undefined,
    );

    expect(split.strategy).toBe("token-allocation");
    expect(split.creditsByCategory.get("tokens.input")).toBe(
      Number.MAX_SAFE_INTEGER - 1,
    );
    expect(split.creditsByCategory.get("tokens.output")).toBe(1);
  });

  it("allocates zero credits across all positive categories", () => {
    const { events, split } = planUsageEventsForSourceRow(
      sourceRow({
        inputTokens: 10,
        outputTokens: 30,
        creditsCharged: 0,
      }),
      undefined,
    );

    expect(split.strategy).toBe("token-allocation");
    expect(events).toHaveLength(2);
    expect(
      events.map((event) => {
        return event.creditsCharged;
      }),
    ).toEqual([0, 0]);
  });

  it("keeps NULL credits as NULL on every generated event", () => {
    const { events, split } = planUsageEventsForSourceRow(
      sourceRow({
        inputTokens: 10,
        outputTokens: 30,
        creditsCharged: null,
      }),
      pricing(),
    );

    expect(split.strategy).toBe("null");
    expect(events).toHaveLength(2);
    expect(
      events.map((event) => {
        return event.creditsCharged;
      }),
    ).toEqual([null, null]);
  });

  it("assigns the full source credits to a single positive category", () => {
    const { events, split } = planUsageEventsForSourceRow(
      sourceRow({
        inputTokens: 0,
        outputTokens: 42,
        creditsCharged: 9,
      }),
      undefined,
    );

    expect(split.strategy).toBe("single");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: "tokens.output",
      quantity: 42,
      creditsCharged: 9,
      status: "processed",
      provider: "claude-sonnet-4-20250514",
    });
  });

  it("rejects provider values that cannot fit usage_event.provider", () => {
    expect(() => {
      planUsageEventsForSourceRow(
        sourceRow({ model: "x".repeat(101) }),
        pricing(),
      );
    }).toThrow("source model is too long");
  });

  it("rejects negative token quantities", () => {
    expect(() => {
      planUsageEventsForSourceRow(
        sourceRow({ inputTokens: -1, outputTokens: 5 }),
        pricing(),
      );
    }).toThrow("negative token quantity");
  });

  it("rejects negative source credits", () => {
    expect(() => {
      planUsageEventsForSourceRow(
        sourceRow({ inputTokens: 1, outputTokens: 2, creditsCharged: -1 }),
        pricing(),
      );
    }).toThrow("source credits_charged is negative");
  });

  it("rejects unsafe source numbers", () => {
    expect(() => {
      planUsageEventsForSourceRow(
        sourceRow({ inputTokens: Number.MAX_SAFE_INTEGER + 1 }),
        pricing(),
      );
    }).toThrow("source inputTokens is not a safe integer");

    expect(() => {
      planUsageEventsForSourceRow(
        sourceRow({ creditsCharged: Number.MAX_SAFE_INTEGER + 1 }),
        pricing(),
      );
    }).toThrow("source credits_charged is not a safe integer");
  });

  it("rejects negative credit pricing", () => {
    expect(() => {
      planUsageEventsForSourceRow(
        sourceRow({ inputTokens: 1, outputTokens: 2, creditsCharged: 1 }),
        pricing({ inputTokenPrice: -1 }),
      );
    }).toThrow("negative credit pricing");
  });

  it("rejects unsafe credit pricing", () => {
    expect(() => {
      planUsageEventsForSourceRow(
        sourceRow({ inputTokens: 1, outputTokens: 2, creditsCharged: 1 }),
        pricing({ inputTokenPrice: Number.MAX_SAFE_INTEGER + 1 }),
      );
    }).toThrow("credit pricing for tokens.input is not a safe integer");
  });

  it("rejects source rows with no positive token categories", () => {
    expect(() => {
      planUsageEventsForSourceRow(
        sourceRow({
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        }),
        pricing(),
      );
    }).toThrow("source row has no positive token categories");
  });
});
