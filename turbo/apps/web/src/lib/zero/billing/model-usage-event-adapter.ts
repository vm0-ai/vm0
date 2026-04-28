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

// UUIDv5 namespace for legacy model-usage webhook idempotency keys. Do not
// change after release; changing it would make webhook retries insert new rows.
const MODEL_USAGE_EVENT_IDEMPOTENCY_NAMESPACE =
  "18a22204-d25e-4170-8973-86477f864bfb";

export function getPositiveModelUsageTokenQuantities(
  usage: LegacyModelUsage,
): ModelUsageTokenQuantity[] {
  // web_search_requests is intentionally not mapped yet: there is no
  // model usage_event category/pricing row for it, so current behavior is
  // no charge.
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
  return uuidV5(
    MODEL_USAGE_EVENT_IDEMPOTENCY_NAMESPACE,
    encodeUuidName([params.runId, params.messageId, params.category]),
  );
}

function encodeUuidName(parts: readonly string[]): string {
  return parts
    .map((part) => {
      return `${Buffer.byteLength(part)}:${part}`;
    })
    .join("\0");
}

function uuidV5(namespace: string, name: string): string {
  const namespaceBytes = Buffer.from(namespace.replaceAll("-", ""), "hex");
  const hash = createHash("sha1");
  hash.update(namespaceBytes);
  hash.update(name);

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
