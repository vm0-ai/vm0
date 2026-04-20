import { eq, and } from "drizzle-orm";
import { FeatureSwitchKey, isFeatureEnabled } from "@vm0/core";
import { slackOrgInstallations } from "../../../../db/schema/slack-org-installation";
import { slackOrgConnections } from "../../../../db/schema/slack-org-connection";
import { decryptSecretValue } from "../../../shared/crypto/secrets-encryption";
import { env } from "../../../../env";
import { getUserEmail } from "../../../auth/get-user-email";
import {
  createSlackClient,
  publishAppHome,
  postMessage,
} from "../../slack/client";
import { buildAppHomeView, buildWelcomeMessage } from "../../slack/blocks";
import {
  resolveDefaultComposeId,
  resolveEffectiveComposeId,
  getUserAgentPreference,
  getWorkspaceAgent,
  buildOrgConnectUrl,
} from "./shared";

interface OrgAppHomeContext {
  workspaceId: string;
  userId: string;
}

/**
 * Handle app_home_opened event for org-aware Slack.
 */
export async function handleOrgAppHomeOpened(
  context: OrgAppHomeContext,
): Promise<void> {
  const { SECRETS_ENCRYPTION_KEY } = env();

  const [installation] = await globalThis.services.db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, context.workspaceId))
    .limit(1);

  if (!installation) {
    return;
  }

  const botToken = decryptSecretValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);

  await refreshOrgAppHome(client, installation, context.userId);
}

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
    // Show the Switch button only when both (a) there's a default to switch
    // from/to and (b) the feature is enabled for this org.
    canSwitch =
      Boolean(defaultComposeId) &&
      isFeatureEnabled(FeatureSwitchKey.SlackAgentSwitch, { orgId });
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

interface OrgMessagesTabContext {
  workspaceId: string;
  userId: string;
  channelId: string;
}

/**
 * Handle messages tab opened for org-aware Slack.
 * Sends one-time welcome message to connected users.
 */
export async function handleOrgMessagesTabOpened(
  context: OrgMessagesTabContext,
): Promise<void> {
  const { SECRETS_ENCRYPTION_KEY } = env();

  const [installation] = await globalThis.services.db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, context.workspaceId))
    .limit(1);

  if (!installation) {
    return;
  }

  // Check connection
  const [connection] = await globalThis.services.db
    .select({ id: slackOrgConnections.id })
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.slackUserId, context.userId),
        eq(slackOrgConnections.slackWorkspaceId, context.workspaceId),
      ),
    )
    .limit(1);

  if (!connection) {
    return;
  }

  // Atomic flag: only send welcome once
  const updated = await globalThis.services.db
    .update(slackOrgConnections)
    .set({ dmWelcomeSent: true })
    .where(
      and(
        eq(slackOrgConnections.id, connection.id),
        eq(slackOrgConnections.dmWelcomeSent, false),
      ),
    );

  if (updated.rowCount === 0) {
    return;
  }

  // Get agent name
  let agentName: string | undefined;
  if (installation.orgId) {
    const composeId = await resolveDefaultComposeId(installation.orgId);
    if (composeId) {
      const agent = await getWorkspaceAgent(composeId);
      agentName = agent?.displayName ?? agent?.name;
    }
  }

  const botToken = decryptSecretValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);

  await postMessage(
    client,
    context.channelId,
    "Hi! I'm Zero. I can connect you to AI agents to help with your tasks.",
    { blocks: buildWelcomeMessage(agentName) },
  );
}
