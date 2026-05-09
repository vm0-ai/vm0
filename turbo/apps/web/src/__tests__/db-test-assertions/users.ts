import { eq, sql } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { pushSubscriptions } from "@vm0/db/schema/push-subscription";

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
