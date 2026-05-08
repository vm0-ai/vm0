import { and, eq } from "drizzle-orm";

import { initServices } from "../../lib/init-services";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { voiceChatRealtimeSessions } from "@vm0/db/schema/voice-chat";

/**
 * Read all `usage_event` rows for an org. Tests use this to verify the
 * `/api/zero/voice-chat/[id]/usage` route produced the expected number,
 * provider, category, and processing-status of billing rows after settlement.
 *
 * @why-db-direct The rule against direct DB access in tests is enforced
 * by `web/no-direct-db-in-tests`; this assertion helper centralises the
 * select so tests don't need their own — Plan D billing tests need to
 * observe the post-settlement ledger state to prove the route inserted
 * rows correctly. No API endpoint exposes this data.
 */
export async function getUsageEventsForOrg(orgId: string): Promise<
  ReadonlyArray<{
    id: string;
    provider: string;
    category: string;
    quantity: number;
    creditsCharged: number | null;
    status: string;
    billingError: string | null;
  }>
> {
  initServices();
  const rows = await globalThis.services.db
    .select({
      id: usageEvent.id,
      provider: usageEvent.provider,
      category: usageEvent.category,
      quantity: usageEvent.quantity,
      creditsCharged: usageEvent.creditsCharged,
      status: usageEvent.status,
      billingError: usageEvent.billingError,
    })
    .from(usageEvent)
    .where(eq(usageEvent.orgId, orgId));
  return rows;
}

/**
 * Read all `voice_chat_realtime_sessions` rows for a given voice-chat
 * session. Tests use this to verify session-started inserts a row,
 * /usage updates `last_usage_at`, and session-ended transitions the row
 * to status='ended'.
 *
 * @why-db-direct Same rationale as `getUsageEventsForOrg` — relay-session
 * audit rows are server-internal state with no public API surface.
 */
export async function getRelaySessionsForVoiceChatSession(
  voiceChatSessionId: string,
): Promise<
  ReadonlyArray<{
    id: string;
    status: string;
    provider: string;
    model: string;
    transcriptionModel: string | null;
    lastUsageAt: Date | null;
    endedAt: Date | null;
  }>
> {
  initServices();
  const rows = await globalThis.services.db
    .select({
      id: voiceChatRealtimeSessions.id,
      status: voiceChatRealtimeSessions.status,
      provider: voiceChatRealtimeSessions.provider,
      model: voiceChatRealtimeSessions.model,
      transcriptionModel: voiceChatRealtimeSessions.transcriptionModel,
      lastUsageAt: voiceChatRealtimeSessions.lastUsageAt,
      endedAt: voiceChatRealtimeSessions.endedAt,
    })
    .from(voiceChatRealtimeSessions)
    .where(
      eq(voiceChatRealtimeSessions.voiceChatSessionId, voiceChatSessionId),
    );
  return rows;
}

export async function getActiveRelaySession(
  voiceChatSessionId: string,
): Promise<
  | {
      id: string;
      status: string;
      lastUsageAt: Date | null;
      endedAt: Date | null;
    }
  | undefined
> {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      id: voiceChatRealtimeSessions.id,
      status: voiceChatRealtimeSessions.status,
      lastUsageAt: voiceChatRealtimeSessions.lastUsageAt,
      endedAt: voiceChatRealtimeSessions.endedAt,
    })
    .from(voiceChatRealtimeSessions)
    .where(
      and(
        eq(voiceChatRealtimeSessions.voiceChatSessionId, voiceChatSessionId),
        eq(voiceChatRealtimeSessions.status, "active"),
      ),
    )
    .limit(1);
  return row;
}

export async function getRelaySessionById(
  relaySessionId: string,
): Promise<{ id: string; status: string; endedAt: Date | null } | undefined> {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      id: voiceChatRealtimeSessions.id,
      status: voiceChatRealtimeSessions.status,
      endedAt: voiceChatRealtimeSessions.endedAt,
    })
    .from(voiceChatRealtimeSessions)
    .where(eq(voiceChatRealtimeSessions.id, relaySessionId))
    .limit(1);
  return row;
}
