import { describe, expect, it } from "vitest";
import {
  deriveUsageEventIdempotencyKey,
  encodeUuidName,
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

    expect(key).toBe("5d36263d-9612-5c7f-b905-0960e7e53988");
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
});
