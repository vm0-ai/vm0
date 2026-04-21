import { eq, sql } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { pushSubscriptions } from "../../db/schema/push-subscription";
import { voiceChatSessions, voiceChatEvents } from "../../db/schema/voice-chat";

/**
 * Count rows in a table where user_id matches.
 * Mirror of countOrgRows for user-scoped deletion verification.
 */
export async function countUserRows(
  tableName:
    | "agent_runs"
    | "agent_run_queue"
    | "agent_composes"
    | "storages"
    | "secrets"
    | "model_providers"
    | "connectors"
    | "user_platform_connectors"
    | "variables"
    | "usage_daily"
    | "export_jobs"
    | "zero_agent_schedules"
    | "cli_tokens"
    | "compose_jobs"
    | "connector_sessions"
    | "device_codes"
    | "org_members_cache"
    | "org_members_metadata"
    | "user_cache"
    | "users",
  userId: string,
): Promise<number> {
  const columnName = tableName === "users" ? "id" : "user_id";
  const rows = await globalThis.services.db.execute(
    sql`SELECT COUNT(*)::int AS count FROM ${sql.identifier(tableName)} WHERE ${sql.identifier(columnName)} = ${userId}`,
  );
  return (rows.rows[0] as { count: number }).count;
}

/**
 * Query push subscriptions for the given endpoint directly from the DB.
 * Returns the matching rows (empty array means the subscription was deleted).
 */
export async function getPushSubscriptionsByEndpoint(
  endpoint: string,
): Promise<Array<{ id: string; endpoint: string }>> {
  initServices();
  return globalThis.services.db
    .select({ id: pushSubscriptions.id, endpoint: pushSubscriptions.endpoint })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, endpoint));
}

/**
 * Read a voice-chat session's status field.
 */
export async function getTestVoiceChatSessionStatus(
  id: string,
): Promise<string | undefined> {
  initServices();
  const [row] = await globalThis.services.db
    .select({ status: voiceChatSessions.status })
    .from(voiceChatSessions)
    .where(eq(voiceChatSessions.id, id));
  return row?.status;
}

/**
 * Read a voice-chat session's lastHeartbeatAt timestamp.
 */
export async function getTestVoiceChatSessionHeartbeat(
  id: string,
): Promise<Date | undefined> {
  initServices();
  const [row] = await globalThis.services.db
    .select({ lastHeartbeatAt: voiceChatSessions.lastHeartbeatAt })
    .from(voiceChatSessions)
    .where(eq(voiceChatSessions.id, id));
  return row?.lastHeartbeatAt;
}

/**
 * Read voice-chat events for a session.
 */
export async function getTestVoiceChatEvents(
  sessionId: string,
): Promise<Array<{ type: string; source: string; content: string | null }>> {
  initServices();
  return globalThis.services.db
    .select({
      type: voiceChatEvents.type,
      source: voiceChatEvents.source,
      content: voiceChatEvents.content,
    })
    .from(voiceChatEvents)
    .where(eq(voiceChatEvents.sessionId, sessionId));
}
