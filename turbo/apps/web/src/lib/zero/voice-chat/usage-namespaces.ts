// Frozen UUID v5 namespace + helper for voice-chat realtime usage idempotency
// keys. The hardcoded constant was derived once via
// `uuidv5("vm0:voice-chat:usage:v1", uuid.NIL)` and pinned forever — every
// existing `usage_event.idempotency_key` row stored for a voice-chat realtime
// event is hashed against this exact value, so a change here would silently
// re-bill all historical events on the next replay.
//
// Hand-rolled v5 instead of adding the `uuid` package: this is the only call
// site that needs deterministic UUIDs, and the spec is short enough that a
// dependency bump is not worth the value.

import { createHash } from "node:crypto";

const VOICE_CHAT_USAGE_NAMESPACE = "dd3f7425-aa8f-56d0-87cb-6158c8c621de";

interface UsageIdempotencyKeyParts {
  readonly voiceChatSessionId: string;
  readonly providerEventId: string;
  readonly category: string;
}

export function buildUsageIdempotencyKey(
  parts: UsageIdempotencyKeyParts,
): string {
  const name = `${parts.voiceChatSessionId}:${parts.providerEventId}:${parts.category}`;
  return uuidv5(name, VOICE_CHAT_USAGE_NAMESPACE);
}

// RFC 4122 v5: SHA-1(namespace_bytes || name_bytes); take first 16 bytes;
// set version (octet 6 high nibble = 5) and variant (octet 8 high two bits =
// 10). Equivalent to `uuid` package's `v5(name, namespace)`.
function uuidv5(name: string, namespaceUuid: string): string {
  const hash = createHash("sha1");
  hash.update(parseUuidBytes(namespaceUuid));
  hash.update(Buffer.from(name, "utf8"));
  const bytes = hash.digest().subarray(0, 16);
  // Version: top 4 bits of octet 6 = 0101 (5)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  // Variant: top 2 bits of octet 8 = 10
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return formatUuid(bytes);
}

function parseUuidBytes(uuid: string): Buffer {
  // 8-4-4-4-12 hex with dashes; strip and decode.
  const hex = uuid.replace(/-/gu, "");
  if (hex.length !== 32 || !/^[0-9a-f]+$/iu.test(hex)) {
    throw new Error(`invalid uuid: ${uuid}`);
  }
  return Buffer.from(hex, "hex");
}

function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
