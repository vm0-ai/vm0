import { sql } from "drizzle-orm";
import { FeatureSwitchKey } from "@vm0/api-contracts/feature-switch-key";

/**
 * Round-2 fused read of per-user context: timezone + capture quota from
 * org_members_metadata, feature-switch overrides from user_feature_switches.
 * One round-trip instead of two — each CTE is a primary-key lookup and the
 * outer SELECT uses scalar subselects so missing rows surface as NULL.
 */
interface RunUserContext {
  timezone: string | null;
  overrides: Partial<Record<FeatureSwitchKey, boolean>> | undefined;
  captureNetworkBodiesRemaining: number;
}

export async function loadRunUserContext(
  orgId: string,
  userId: string,
): Promise<RunUserContext> {
  const db = globalThis.services.db;

  const { rows } = await db.execute<{
    timezone: string | null;
    capture_network_bodies_remaining: number | null;
    switches: Record<string, boolean> | null;
  }>(sql`
    WITH prefs AS (
      SELECT timezone, capture_network_bodies_remaining
      FROM org_members_metadata
      WHERE org_id = ${orgId} AND user_id = ${userId}
      LIMIT 1
    ),
    fs AS (
      SELECT switches
      FROM user_feature_switches
      WHERE org_id = ${orgId} AND user_id = ${userId}
      LIMIT 1
    )
    SELECT
      (SELECT timezone FROM prefs) AS timezone,
      (SELECT capture_network_bodies_remaining FROM prefs)
        AS capture_network_bodies_remaining,
      (SELECT switches FROM fs) AS switches
  `);

  const row = rows[0];
  const switches = row?.switches ?? null;
  const overrides =
    switches && Object.keys(switches).length > 0
      ? (switches as Partial<Record<FeatureSwitchKey, boolean>>)
      : undefined;

  return {
    timezone: row?.timezone ?? null,
    overrides,
    captureNetworkBodiesRemaining: row?.capture_network_bodies_remaining ?? 0,
  };
}
