import { and, eq, sql } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { slackOrgInstallations } from "../../db/schema/slack-org-installation";
import { slackOrgConnections } from "../../db/schema/slack-org-connection";

export async function findTestSlackOrgInstallation(workspaceId: string) {
  const [row] = await globalThis.services.db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId))
    .limit(1);
  return row;
}

export async function findTestSlackOrgConnections(
  slackUserId: string,
  workspaceId: string,
) {
  return globalThis.services.db
    .select()
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.slackUserId, slackUserId),
        eq(slackOrgConnections.slackWorkspaceId, workspaceId),
      ),
    );
}

export async function findTestSlackOrgConnection(
  slackUserId: string,
  workspaceId: string,
) {
  const [row] = await globalThis.services.db
    .select()
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.slackUserId, slackUserId),
        eq(slackOrgConnections.slackWorkspaceId, workspaceId),
      ),
    );
  return row;
}

export async function findTestSlackOrgConnectionsByVm0UserId(
  vm0UserId: string,
) {
  return globalThis.services.db
    .select()
    .from(slackOrgConnections)
    .where(eq(slackOrgConnections.vm0UserId, vm0UserId));
}

/**
 * Count Slack org installations for a workspace.
 */
export async function countSlackOrgInstallations(
  workspaceId: string,
): Promise<number> {
  initServices();
  const rows = await globalThis.services.db
    .select({ id: slackOrgInstallations.slackWorkspaceId })
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId));
  return rows.length;
}

/**
 * Count Slack org connections for a workspace.
 */
export async function countSlackOrgConnections(
  workspaceId: string,
): Promise<number> {
  initServices();
  const rows = await globalThis.services.db
    .select({ id: slackOrgConnections.id })
    .from(slackOrgConnections)
    .where(eq(slackOrgConnections.slackWorkspaceId, workspaceId));
  return rows.length;
}

/**
 * Count rows in slack_org_connections where vm0_user_id matches.
 */
export async function countSlackConnectionRows(
  vm0UserId: string,
): Promise<number> {
  const rows = await globalThis.services.db.execute(
    sql`SELECT COUNT(*)::int AS count FROM slack_org_connections WHERE vm0_user_id = ${vm0UserId}`,
  );
  return (rows.rows[0] as { count: number }).count;
}
