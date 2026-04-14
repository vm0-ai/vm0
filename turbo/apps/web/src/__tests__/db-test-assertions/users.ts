import { eq, sql } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { users } from "../../db/schema/user";

/**
 * Read a full users row by userId.
 * Returns undefined if no row exists.
 */
export async function getUserRow(userId: string) {
  initServices();
  const [row] = await globalThis.services.db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row;
}

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
