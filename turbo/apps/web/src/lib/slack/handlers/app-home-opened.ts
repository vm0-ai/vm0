import { eq, and } from "drizzle-orm";
import { slackInstallations } from "../../../db/schema/slack-installation";
import { slackUserLinks } from "../../../db/schema/slack-user-link";
import { slackBindings } from "../../../db/schema/slack-binding";
import { decryptCredentialValue } from "../../crypto/secrets-encryption";
import { env } from "../../../env";
import {
  createSlackClient,
  publishAppHome,
  buildAppHomeView,
  postMessage,
  buildWelcomeMessage,
} from "../index";
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

  await refreshAppHome(client, context.workspaceId, context.userId);
}

/**
 * Refresh the App Home tab for a user
 *
 * Reusable by other handlers (e.g. after disconnect) to update the Home tab.
 */
export async function refreshAppHome(
  client: ReturnType<typeof createSlackClient>,
  workspaceId: string,
  userId: string,
): Promise<void> {
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

  // Get user's bindings
  const bindings = await globalThis.services.db
    .select({
      id: slackBindings.id,
      agentName: slackBindings.agentName,
      description: slackBindings.description,
      enabled: slackBindings.enabled,
    })
    .from(slackBindings)
    .where(eq(slackBindings.slackUserLinkId, userLink.id));

  // Build and publish home view
  const view = buildAppHomeView({
    isLinked: true,
    vm0UserId: userLink.vm0UserId,
    bindings,
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

  // 4. Fetch user's agent bindings
  const bindings = await globalThis.services.db
    .select({
      agentName: slackBindings.agentName,
      description: slackBindings.description,
    })
    .from(slackBindings)
    .where(eq(slackBindings.slackUserLinkId, userLink.id));

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
    { blocks: buildWelcomeMessage(bindings) },
  );
}
