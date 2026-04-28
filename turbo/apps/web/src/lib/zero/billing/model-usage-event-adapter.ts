import { createHash } from "crypto";
import {
  MODEL_USAGE_KIND,
  TOKEN_CATEGORY_CACHE_CREATION,
  TOKEN_CATEGORY_CACHE_READ,
  TOKEN_CATEGORY_INPUT,
  TOKEN_CATEGORY_OUTPUT,
} from "./model-usage-categories";

type LegacyModelUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

type ModelUsageTokenQuantity = {
  category: string;
  quantity: number;
};

type ModelUsageEventDraft = ModelUsageTokenQuantity & {
  idempotencyKey: string;
  kind: typeof MODEL_USAGE_KIND;
  provider: string;
};

const MODEL_USAGE_EVENT_IDEMPOTENCY_PREFIX = "vm0:model-usage-event:v1";

export function getPositiveModelUsageTokenQuantities(
  usage: LegacyModelUsage,
): ModelUsageTokenQuantity[] {
  return [
    { category: TOKEN_CATEGORY_INPUT, quantity: usage.input_tokens ?? 0 },
    { category: TOKEN_CATEGORY_OUTPUT, quantity: usage.output_tokens ?? 0 },
    {
      category: TOKEN_CATEGORY_CACHE_READ,
      quantity: usage.cache_read_input_tokens ?? 0,
    },
    {
      category: TOKEN_CATEGORY_CACHE_CREATION,
      quantity: usage.cache_creation_input_tokens ?? 0,
    },
  ].filter((item) => {
    return item.quantity > 0;
  });
}

export function buildModelUsageEventDrafts(params: {
  runId: string;
  messageId: string;
  provider: string;
  usage: LegacyModelUsage;
}): ModelUsageEventDraft[] {
  return getPositiveModelUsageTokenQuantities(params.usage).map((item) => {
    return {
      idempotencyKey: deriveModelUsageEventIdempotencyKey({
        runId: params.runId,
        messageId: params.messageId,
        category: item.category,
      }),
      kind: MODEL_USAGE_KIND,
      provider: params.provider,
      category: item.category,
      quantity: item.quantity,
    };
  });
}

function deriveModelUsageEventIdempotencyKey(params: {
  runId: string;
  messageId: string;
  category: string;
}): string {
  return deterministicUuid([params.runId, params.messageId, params.category]);
}

function deterministicUuid(parts: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(MODEL_USAGE_EVENT_IDEMPOTENCY_PREFIX);

  for (const part of parts) {
    hash.update("\0");
    hash.update(String(Buffer.byteLength(part)));
    hash.update(":");
    hash.update(part);
  }

  const bytes = Uint8Array.from(hash.digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Buffer.from(bytes).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
