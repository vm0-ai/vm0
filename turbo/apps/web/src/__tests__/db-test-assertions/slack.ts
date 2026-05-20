import { and, eq, count } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackUserAgentPreferences } from "@vm0/db/schema/slack-user-agent-preference";

export async function findTestSlackOrgInstallation(workspaceId: string) {
  initServices();
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
  initServices();
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
  initServices();
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
  initServices();
  return globalThis.services.db
    .select()
    .from(slackOrgConnections)
    .where(eq(slackOrgConnections.vm0UserId, vm0UserId));
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
  initServices();
  const [row] = await globalThis.services.db
    .select({ count: count() })
    .from(slackOrgConnections)
    .where(eq(slackOrgConnections.vm0UserId, vm0UserId));
  return row?.count ?? 0;
}

/**
 * @why-db-direct Per-user agent preference has no API for reads; inspecting it
 * is the only way to assert that /zero switch persisted the right row.
 */
export async function findSlackUserAgentPreference(
  vm0UserId: string,
  orgId: string,
): Promise<typeof slackUserAgentPreferences.$inferSelect | undefined> {
  initServices();
  const [row] = await globalThis.services.db
    .select()
    .from(slackUserAgentPreferences)
    .where(
      and(
        eq(slackUserAgentPreferences.vm0UserId, vm0UserId),
        eq(slackUserAgentPreferences.orgId, orgId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * @why-db-direct Seeds an existing agent override so tests can verify that
 * subsequent modal submissions correctly overwrite or clear it.
 */
export async function seedSlackUserAgentPreference(opts: {
  vm0UserId: string;
  orgId: string;
  composeId: string | null;
}): Promise<void> {
  initServices();
  await globalThis.services.db
    .insert(slackUserAgentPreferences)
    .values({
      vm0UserId: opts.vm0UserId,
      orgId: opts.orgId,
      selectedComposeId: opts.composeId,
    })
    .onConflictDoUpdate({
      target: [
        slackUserAgentPreferences.vm0UserId,
        slackUserAgentPreferences.orgId,
      ],
      set: {
        selectedComposeId: opts.composeId,
        updatedAt: new Date(),
      },
    });
}
