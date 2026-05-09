// Frozen UUID v5 namespace + helper for voice-chat realtime usage idempotency
// keys. The hardcoded constant was derived once via
// `uuidv5("vm0:voice-chat:usage:v1", uuid.NIL)` and pinned forever — every
// existing `usage_event.idempotency_key` row stored for a voice-chat realtime
// event is hashed against this exact value, so a change here would silently
// re-bill all historical events on the next replay.

import { v5 as uuidv5 } from "uuid";

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
