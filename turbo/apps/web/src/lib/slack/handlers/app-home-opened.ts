import { eq, and } from "drizzle-orm";
import { slackInstallations } from "../../../db/schema/slack-installation";
import { slackUserLinks } from "../../../db/schema/slack-user-link";
import { agentComposes } from "../../../db/schema/agent-compose";
import { decryptCredentialValue } from "../../crypto/secrets-encryption";
import { env } from "../../../env";
import { getUserEmail } from "../../auth/get-user-email";
import { createSlackClient, publishAppHome, postMessage } from "../client";
import { buildAppHomeView, buildWelcomeMessage } from "../blocks";
import { buildLoginUrl } from "./shared";

interface AppHomeOpenedContext {
  workspaceId: string;
  userId: string;
}

/**
 * Handle an app_home_opened event from Slack
 *
 * Publishes the Home tab with account status, linked agents, and help info.
 */
export async function handleAppHomeOpened(
  context: AppHomeOpenedContext,
): Promise<void> {
  const { SECRETS_ENCRYPTION_KEY } = env();

  // 1. Get workspace installation
  const [installation] = await globalThis.services.db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, context.workspaceId))
    .limit(1);

  if (!installation) {
    return;
  }

  // Decrypt bot token
  const botToken = decryptCredentialValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);

  await refreshAppHome(client, installation, context.userId);
}

/**
 * Refresh the App Home tab for a user
 *
 * Reusable by other handlers (e.g. after disconnect) to update the Home tab.
 */
export async function refreshAppHome(
  client: ReturnType<typeof createSlackClient>,
  installation: typeof slackInstallations.$inferSelect,
  userId: string,
): Promise<void> {
  const workspaceId = installation.slackWorkspaceId;

  // Check if user is linked
  const [userLink] = await globalThis.services.db
    .select()
    .from(slackUserLinks)
    .where(
      and(
        eq(slackUserLinks.slackUserId, userId),
        eq(slackUserLinks.slackWorkspaceId, workspaceId),
      ),
    )
    .limit(1);

  if (!userLink) {
    // User not linked — show login prompt
    const loginUrl = buildLoginUrl(workspaceId, userId, "");
    const view = buildAppHomeView({
      isLinked: false,
      loginUrl,
    });
    await publishAppHome(client, userId, view);
    return;
  }

  // Get workspace agent name
  const [compose] = await globalThis.services.db
    .select({ name: agentComposes.name })
    .from(agentComposes)
    .where(eq(agentComposes.id, installation.defaultComposeId))
    .limit(1);
  const agentName = compose?.name;

  // Fetch user email for display
  const userEmail = await getUserEmail(userLink.vm0UserId);

  // Build and publish home view
  const isAdmin = installation.adminSlackUserId === userId;
  const view = buildAppHomeView({
    isLinked: true,
    vm0UserId: userLink.vm0UserId,
    userEmail,
    agentName,
    isAdmin,
  });
  await publishAppHome(client, userId, view);
}

interface MessagesTabOpenedContext {
  workspaceId: string;
  userId: string;
  channelId: string;
}

/**
 * Handle an app_home_opened event with tab === "messages"
 *
 * Sends a one-time welcome message to linked users when they first open
 * the Messages tab. Uses an atomic UPDATE to prevent duplicate sends.
 * Unlinked users are skipped — they already get a login prompt on first DM.
 */
export async function handleMessagesTabOpened(
  context: MessagesTabOpenedContext,
): Promise<void> {
  const { SECRETS_ENCRYPTION_KEY } = env();

  // 1. Get workspace installation
  const [installation] = await globalThis.services.db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, context.workspaceId))
    .limit(1);

  if (!installation) {
    return;
  }

  // 2. Check if user is linked (unlinked users skip — they get a login prompt on first DM)
  const [userLink] = await globalThis.services.db
    .select({ id: slackUserLinks.id })
    .from(slackUserLinks)
    .where(
      and(
        eq(slackUserLinks.slackUserId, context.userId),
        eq(slackUserLinks.slackWorkspaceId, context.workspaceId),
      ),
    )
    .limit(1);

  if (!userLink) {
    return;
  }

  // 3. Atomic UPDATE — only sets dm_welcome_sent if it was false
  const updated = await globalThis.services.db
    .update(slackUserLinks)
    .set({ dmWelcomeSent: true })
    .where(
      and(
        eq(slackUserLinks.id, userLink.id),
        eq(slackUserLinks.dmWelcomeSent, false),
      ),
    );

  if (updated.rowCount === 0) {
    // Already sent — skip
    return;
  }

  // 4. Get workspace agent name
  const [compose] = await globalThis.services.db
    .select({ name: agentComposes.name })
    .from(agentComposes)
    .where(eq(agentComposes.id, installation.defaultComposeId))
    .limit(1);

  // 5. Send welcome message
  const botToken = decryptCredentialValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);

  await postMessage(
    client,
    context.channelId,
    "Hi! I'm VM0. I can connect you to AI agents to help with your tasks.",
    { blocks: buildWelcomeMessage(compose?.name) },
  );
}
