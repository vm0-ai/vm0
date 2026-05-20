import { eq } from "drizzle-orm";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";

import { logger } from "../../shared/logger";
import { publishOrgAdminSignal } from "../realtime";

const log = logger("slack-org:connect");

/**
 * Remove a workspace installation and all associated data.
 *
 * Deletes: connections (cascades thread sessions) → installation.
 * Skips Slack API calls — the caller decides whether to refresh App Homes first.
 *
 * Returns true if an installation was deleted, false if none existed.
 */
export async function cleanupWorkspaceInstallation(
  workspaceId: string,
): Promise<boolean> {
  const db = globalThis.services.db;

  const [installation] = await db
    .select({
      slackWorkspaceId: slackOrgInstallations.slackWorkspaceId,
      orgId: slackOrgInstallations.orgId,
    })
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId))
    .limit(1);

  if (!installation) {
    return false;
  }

  // Delete all connections (cascades to thread sessions)
  await db
    .delete(slackOrgConnections)
    .where(eq(slackOrgConnections.slackWorkspaceId, workspaceId));

  // Delete the installation
  await db
    .delete(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId));

  log.info("Cleaned up workspace installation", { workspaceId });

  if (installation.orgId) {
    await publishOrgAdminSignal(installation.orgId, "slack:changed");
  }

  return true;
}
