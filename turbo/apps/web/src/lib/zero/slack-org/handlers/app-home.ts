import { eq, and } from "drizzle-orm";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { getUserEmail } from "../../../auth/get-user-email";
import { createSlackClient, publishAppHome } from "../../slack/client";
import { buildAppHomeView } from "../../slack/blocks";
import {
  resolveDefaultComposeId,
  resolveEffectiveComposeId,
  getUserAgentPreference,
  getWorkspaceAgent,
  buildOrgConnectUrl,
} from "./shared";

/**
 * Refresh the App Home tab for an org-aware Slack workspace.
 */
export async function refreshOrgAppHome(
  client: ReturnType<typeof createSlackClient>,
  installation: typeof slackOrgInstallations.$inferSelect,
  slackUserId: string,
): Promise<void> {
  const workspaceId = installation.slackWorkspaceId;

  // Check if user is connected
  const [connection] = await globalThis.services.db
    .select()
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.slackUserId, slackUserId),
        eq(slackOrgConnections.slackWorkspaceId, workspaceId),
      ),
    )
    .limit(1);

  if (!connection) {
    // User not connected — show connect prompt
    const connectUrl = buildOrgConnectUrl(workspaceId, slackUserId, "");
    const view = buildAppHomeView({
      isLinked: false,
      loginUrl: connectUrl,
    });
    await publishAppHome(client, slackUserId, view);
    return;
  }

  // Resolve the agent currently active for THIS user (override or org default).
  let agentName: string | undefined;
  let isOverrideActive = false;
  let canSwitch = false;
  if (installation.orgId) {
    const orgId = installation.orgId;
    const [effectiveComposeId, overrideComposeId, defaultComposeId] =
      await Promise.all([
        resolveEffectiveComposeId(connection.vm0UserId, orgId),
        getUserAgentPreference(connection.vm0UserId, orgId),
        resolveDefaultComposeId(orgId),
      ]);

    if (effectiveComposeId) {
      const agent = await getWorkspaceAgent(effectiveComposeId);
      agentName = agent?.displayName ?? agent?.name;
    }
    isOverrideActive = Boolean(
      overrideComposeId && overrideComposeId !== defaultComposeId,
    );
    canSwitch = Boolean(defaultComposeId);
  }

  // Get user email for display
  const userEmail = await getUserEmail(connection.vm0UserId);

  const view = buildAppHomeView({
    isLinked: true,
    vm0UserId: connection.vm0UserId,
    userEmail,
    agentName,
    isOverrideActive,
    canSwitch,
  });
  await publishAppHome(client, slackUserId, view);
}
