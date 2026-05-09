// Server-side helper that converts a browser-reported voice-chat realtime
// usage event into one or more `usage_event` rows, settles via
// `processOrgUsageEvents`, and surfaces the post-settlement credit state.
//
// Per Epic #12128 Plan D: the browser is the only source of usage signal —
// missed events are accepted operational overhead. Idempotency is provided
// by deterministic UUID v5 keys built from
// `(voiceChatSessionId, providerEventId, category)`, so duplicate browser
// reports collapse at the unique-index level rather than charging twice.

import { and, eq } from "drizzle-orm";

import { isApiError } from "@vm0/api-services/errors";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { voiceChatRealtimeSessions } from "@vm0/db/schema/voice-chat";

import { logger } from "../../shared/logger";
import { checkOrgCredits } from "../credit/check-org-credits";
import { processOrgUsageEvents } from "../credit/usage-event-service";
import {
  REALTIME_PROVIDER,
  REALTIME_TOKEN_CATEGORIES,
  TRANSCRIPTION_PROVIDER,
  TRANSCRIPTION_TOKEN_CATEGORIES,
} from "../billing/model-usage-categories";
import { buildUsageIdempotencyKey } from "./usage-namespaces";

const log = logger("zero:voice-chat:usage");

const MODEL_USAGE_KIND = "model";

type VoiceChatUsageEventType = "response.done" | "transcription.completed";

interface VoiceChatUsageTokens {
  readonly inputText?: number;
  readonly inputAudio?: number;
  readonly inputCachedText?: number;
  readonly inputCachedAudio?: number;
  readonly outputText?: number;
  readonly outputAudio?: number;
}

interface RecordRealtimeUsageInput {
  readonly voiceChatSessionId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly providerEventId: string;
  readonly eventType: VoiceChatUsageEventType;
  readonly tokens: VoiceChatUsageTokens;
}

interface RecordRealtimeUsageResult {
  readonly creditsExhausted: boolean;
  readonly rowsInserted: number;
}

interface CategoryRow {
  readonly category: string;
  readonly quantity: number;
}

// Map of body-field -> category name per provider. Order is irrelevant —
// the unique index is on `idempotencyKey`. Skipping zero/missing fields
// avoids inserting `quantity=0` rows that would consume processor cycles
// for no billing effect.
function buildRows(
  eventType: VoiceChatUsageEventType,
  tokens: VoiceChatUsageTokens,
): CategoryRow[] {
  if (eventType === "response.done") {
    const allowed = REALTIME_TOKEN_CATEGORIES;
    const candidates: CategoryRow[] = [
      { category: "tokens.input.text", quantity: tokens.inputText ?? 0 },
      { category: "tokens.input.audio", quantity: tokens.inputAudio ?? 0 },
      {
        category: "tokens.input.cached_text",
        quantity: tokens.inputCachedText ?? 0,
      },
      {
        category: "tokens.input.cached_audio",
        quantity: tokens.inputCachedAudio ?? 0,
      },
      { category: "tokens.output.text", quantity: tokens.outputText ?? 0 },
      { category: "tokens.output.audio", quantity: tokens.outputAudio ?? 0 },
    ];
    return candidates.filter((row) => {
      return (
        row.quantity > 0 &&
        (allowed as readonly string[]).includes(row.category)
      );
    });
  }
  // transcription.completed — only three categories valid; the route layer
  // also rejects `outputAudioTokens` upstream, but defend here too.
  const allowed = TRANSCRIPTION_TOKEN_CATEGORIES;
  const candidates: CategoryRow[] = [
    { category: "tokens.input.audio", quantity: tokens.inputAudio ?? 0 },
    { category: "tokens.input.text", quantity: tokens.inputText ?? 0 },
    { category: "tokens.output.text", quantity: tokens.outputText ?? 0 },
  ];
  return candidates.filter((row) => {
    return (
      row.quantity > 0 && (allowed as readonly string[]).includes(row.category)
    );
  });
}

function providerFor(eventType: VoiceChatUsageEventType): string {
  return eventType === "response.done"
    ? REALTIME_PROVIDER
    : TRANSCRIPTION_PROVIDER;
}

function isInsufficientCreditsError(error: unknown): boolean {
  return (
    isApiError(error) &&
    "code" in error &&
    (error as { code?: string }).code === "INSUFFICIENT_CREDITS"
  );
}

export async function recordRealtimeUsage(
  input: RecordRealtimeUsageInput,
): Promise<RecordRealtimeUsageResult> {
  const db = globalThis.services.db;

  const provider = providerFor(input.eventType);
  const rows = buildRows(input.eventType, input.tokens);

  if (rows.length === 0) {
    log.warn("usage event has no billable token fields — dropping", {
      voiceChatSessionId: input.voiceChatSessionId,
      providerEventId: input.providerEventId,
      eventType: input.eventType,
    });
    return { creditsExhausted: false, rowsInserted: 0 };
  }

  const insertValues = rows.map((row) => {
    return {
      runId: null,
      idempotencyKey: buildUsageIdempotencyKey({
        voiceChatSessionId: input.voiceChatSessionId,
        providerEventId: input.providerEventId,
        category: row.category,
      }),
      orgId: input.orgId,
      userId: input.userId,
      kind: MODEL_USAGE_KIND,
      provider,
      category: row.category,
      quantity: row.quantity,
    };
  });

  await db
    .insert(usageEvent)
    .values(insertValues)
    .onConflictDoNothing({ target: usageEvent.idempotencyKey });

  await processOrgUsageEvents(input.orgId);

  // Audit-only side effect: best-effort `last_usage_at` ping. The relay
  // session row may not exist (session-started POST can soft-fail), in
  // which case the UPDATE affects 0 rows and we move on.
  await db
    .update(voiceChatRealtimeSessions)
    .set({ lastUsageAt: new Date() })
    .where(
      and(
        eq(
          voiceChatRealtimeSessions.voiceChatSessionId,
          input.voiceChatSessionId,
        ),
        eq(voiceChatRealtimeSessions.status, "active"),
      ),
    );

  // Re-check credits to surface exhaustion to the browser. The settler may
  // have just consumed the last credit; the response flag is what triggers
  // client-side teardown.
  let creditsExhausted = false;
  try {
    await checkOrgCredits(input.orgId, input.userId, db);
  } catch (error) {
    if (isInsufficientCreditsError(error)) {
      creditsExhausted = true;
    } else {
      throw error;
    }
  }

  return { creditsExhausted, rowsInserted: rows.length };
}
