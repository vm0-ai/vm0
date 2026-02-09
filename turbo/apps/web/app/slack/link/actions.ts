"use server";

import { getAuthProvider } from "../../../src/lib/auth/auth-provider";
import { eq, and } from "drizzle-orm";
import { initServices } from "../../../src/lib/init-services";
import { env } from "../../../src/env";
import { slackUserLinks } from "../../../src/db/schema/slack-user-link";
import { slackInstallations } from "../../../src/db/schema/slack-installation";
import { decryptCredentialValue } from "../../../src/lib/crypto/secrets-encryption";
import { createSlackClient, refreshAppHome } from "../../../src/lib/slack";
import {
  ensureScopeAndArtifact,
  getWorkspaceAgent,
} from "../../../src/lib/slack/handlers/shared";
import { getUserEmail } from "../../../src/lib/auth/get-user-email";
import { addPermission } from "../../../src/lib/agent/permission-service";
import { logger } from "../../../src/lib/logger";

const log = logger("slack:link");

interface LinkResult {
  success: boolean;
  error?: string;
  alreadyLinked?: boolean;
}

interface LinkStatus {
  isLinked: boolean;
  workspaceName?: string;
}

/**
 * Check if a Slack user is already linked to the current VM0 user
 */
export async function checkLinkStatus(
  slackUserId: string,
  workspaceId: string,
): Promise<LinkStatus> {
  const userId = await getAuthProvider().getUserId();

  if (!userId) {
    return { isLinked: false };
  }

  initServices();

  // Check if this Slack user is already linked
  const [existingLink] = await globalThis.services.db
    .select()
    .from(slackUserLinks)
    .where(
      and(
        eq(slackUserLinks.slackUserId, slackUserId),
        eq(slackUserLinks.slackWorkspaceId, workspaceId),
      ),
    )
    .limit(1);

  if (existingLink) {
    // Get workspace name
    const [installation] = await globalThis.services.db
      .select({ workspaceName: slackInstallations.slackWorkspaceName })
      .from(slackInstallations)
      .where(eq(slackInstallations.slackWorkspaceId, workspaceId))
      .limit(1);

    return {
      isLinked: true,
      workspaceName: installation?.workspaceName ?? undefined,
    };
  }

  return { isLinked: false };
}

/**
 * Link a Slack user to the current VM0 user
 */
export async function linkSlackAccount(
  slackUserId: string,
  workspaceId: string,
  channelId?: string | null,
): Promise<LinkResult> {
  const userId = await getAuthProvider().getUserId();

  if (!userId) {
    return { success: false, error: "Not authenticated" };
  }

  initServices();

  // Check if the workspace installation exists
  const [installation] = await globalThis.services.db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, workspaceId))
    .limit(1);

  if (!installation) {
    return {
      success: false,
      error: "Workspace not found. Please install the Slack app first.",
    };
  }

  // Check if this Slack user is already linked
  const [existingLink] = await globalThis.services.db
    .select()
    .from(slackUserLinks)
    .where(
      and(
        eq(slackUserLinks.slackUserId, slackUserId),
        eq(slackUserLinks.slackWorkspaceId, workspaceId),
      ),
    )
    .limit(1);

  if (existingLink) {
    if (existingLink.vm0UserId === userId) {
      // Send success message even for already linked users
      if (channelId) {
        await sendSuccessMessage(
          installation.encryptedBotToken,
          channelId,
          slackUserId,
          installation.defaultComposeId,
        ).catch((error) => {
          log.warn("Failed to send success message", { error });
        });
      }
      return { success: true, alreadyLinked: true };
    }
    return {
      success: false,
      error: "This Slack account is already linked to a different VM0 account.",
    };
  }

  // Ensure scope and artifact exist for the user
  await ensureScopeAndArtifact(userId);

  // Create the link
  await globalThis.services.db
    .insert(slackUserLinks)
    .values({
      slackUserId,
      slackWorkspaceId: workspaceId,
      vm0UserId: userId,
    })
    .returning({ id: slackUserLinks.id });

  // Auto-share workspace agent with the new user
  const email = await getUserEmail(userId);
  if (email && installation.defaultComposeId) {
    await addPermission(
      installation.defaultComposeId,
      "email",
      installation.adminSlackUserId,
      email,
    ).catch((error) => {
      log.warn("Failed to auto-share workspace agent", { error });
    });
  }

  // Send success message to the Slack channel
  if (channelId) {
    await sendSuccessMessage(
      installation.encryptedBotToken,
      channelId,
      slackUserId,
      installation.defaultComposeId,
    ).catch((error) => {
      log.warn("Failed to send success message", { error });
    });
  }

  // Refresh App Home to show linked state
  const { SECRETS_ENCRYPTION_KEY } = env();
  const botToken = decryptCredentialValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);
  await refreshAppHome(client, installation, slackUserId).catch((error) => {
    log.warn("Failed to refresh App Home after link", { error });
  });

  return { success: true };
}

/**
 * Send success message to the Slack channel (ephemeral - only visible to the user)
 */
async function sendSuccessMessage(
  encryptedBotToken: string,
  channelId: string,
  slackUserId: string,
  defaultComposeId: string,
): Promise<void> {
  const { SECRETS_ENCRYPTION_KEY } = env();
  const botToken = decryptCredentialValue(
    encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);

  const agent = await getWorkspaceAgent(defaultComposeId);
  const agentInfo = agent
    ? `The workspace agent \`${agent.name}\` is ready to use.`
    : "";

  await client.chat.postEphemeral({
    channel: channelId,
    user: slackUserId,
    text: `Successfully connected to VM0!`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:white_check_mark: *Successfully connected to VM0!*\n\n${agentInfo}\n\nYou can now:\n• Mention \`@VM0\` to interact with the agent\n• Use \`/vm0 settings\` to configure your secrets and variables`,
        },
      },
    ],
  });
}
