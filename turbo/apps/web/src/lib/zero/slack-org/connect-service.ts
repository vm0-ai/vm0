import { eq, and, isNull } from "drizzle-orm";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import {
  ensureOrgArtifact,
  resolveDefaultComposeId,
  getWorkspaceAgent,
} from "./handlers/shared";
import { refreshOrgAppHome } from "./handlers/app-home";

import { env } from "../../../env";
import { decryptSecretValue } from "../../shared/crypto/secrets-encryption";
import { createSlackClient, postMessage } from "../slack/client";
import { buildSuccessMessage, buildWelcomeMessage } from "../slack/blocks";
import { logger } from "../../shared/logger";
import { publishOrgAdminSignal } from "../realtime";

const log = logger("slack-org:connect");

/**
 * Admin connect: bind an unbound workspace to an org.
 *
 * Uses atomic UPDATE ... WHERE org_id IS NULL to prevent race conditions.
 * If the workspace is already bound to the same org, treats as idempotent success.
 */
export async function adminConnect(params: {
  userId: string;
  orgId: string;
  workspaceId: string;
  slackUserId: string;
}): Promise<{
  connection: typeof slackOrgConnections.$inferSelect;
  installation: typeof slackOrgInstallations.$inferSelect;
}> {
  const { userId, orgId, workspaceId, slackUserId } = params;
  const db = globalThis.services.db;

  // Atomic bind: only succeeds if org_id is currently NULL
  const updated = await db
    .update(slackOrgInstallations)
    .set({
      orgId,
      installedByUserId: userId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(slackOrgInstallations.slackWorkspaceId, workspaceId),
        isNull(slackOrgInstallations.orgId),
      ),
    )
    .returning();

  let installation: typeof slackOrgInstallations.$inferSelect;

  if (updated.length === 0) {
    // Workspace already bound — check if it's the same org (idempotent)
    const [existing] = await db
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId))
      .limit(1);

    if (!existing) {
      throw new Error("Workspace installation not found");
    }

    if (existing.orgId !== orgId) {
      throw new Error("Workspace is already connected to a different org");
    }

    installation = existing;
  } else {
    installation = updated[0]!;
  }

  // Create connection (upsert to handle idempotent admin reconnect)
  const [connection] = await db
    .insert(slackOrgConnections)
    .values({
      slackUserId,
      slackWorkspaceId: workspaceId,
      vm0UserId: userId,
    })
    .onConflictDoNothing({
      target: [
        slackOrgConnections.slackUserId,
        slackOrgConnections.slackWorkspaceId,
      ],
    })
    .returning();

  // If conflict (already exists), fetch the existing connection
  const finalConnection =
    connection ??
    (
      await db
        .select()
        .from(slackOrgConnections)
        .where(
          and(
            eq(slackOrgConnections.slackUserId, slackUserId),
            eq(slackOrgConnections.slackWorkspaceId, workspaceId),
          ),
        )
        .limit(1)
    )[0]!;

  // Ensure artifact storage
  await ensureOrgArtifact(userId, orgId);

  log.info("Admin connected workspace to org", {
    workspaceId,
    orgId,
    userId,
  });

  // Notify every admin on the Slack settings page.
  await publishOrgAdminSignal(orgId, "slack:changed");

  return { connection: finalConnection, installation };
}

/**
 * Member connect: join an already-bound workspace.
 *
 * Requires that an admin has already connected (org_id is set on installation).
 */
export async function memberConnect(params: {
  userId: string;
  orgId: string;
  workspaceId: string;
  slackUserId: string;
}): Promise<{ connection: typeof slackOrgConnections.$inferSelect }> {
  const { userId, orgId, workspaceId, slackUserId } = params;
  const db = globalThis.services.db;

  // Verify installation is bound to this org
  const [installation] = await db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId))
    .limit(1);

  if (!installation) {
    throw new Error("Workspace installation not found");
  }

  if (!installation.orgId) {
    throw new Error(
      "Org admin must connect first. Ask your org admin to run /vm0 connect.",
    );
  }

  if (installation.orgId !== orgId) {
    throw new Error("Workspace is connected to a different org");
  }

  // Create connection
  const [connection] = await db
    .insert(slackOrgConnections)
    .values({
      slackUserId,
      slackWorkspaceId: workspaceId,
      vm0UserId: userId,
    })
    .onConflictDoNothing({
      target: [
        slackOrgConnections.slackUserId,
        slackOrgConnections.slackWorkspaceId,
      ],
    })
    .returning();

  const finalConnection =
    connection ??
    (
      await db
        .select()
        .from(slackOrgConnections)
        .where(
          and(
            eq(slackOrgConnections.slackUserId, slackUserId),
            eq(slackOrgConnections.slackWorkspaceId, workspaceId),
          ),
        )
        .limit(1)
    )[0]!;

  // Ensure artifact storage
  await ensureOrgArtifact(userId, orgId);

  log.info("Member connected to workspace", {
    workspaceId,
    orgId,
    userId,
  });

  await publishOrgAdminSignal(orgId, "slack:changed");

  return { connection: finalConnection };
}

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

/**
 * Send a Slack DM confirming successful connection, a welcome thread,
 * mark dmWelcomeSent, and refresh App Home.
 *
 * Fire-and-forget — callers should use `void notifyConnectSuccess(...)`.
 * When channelId is provided, sends an ephemeral message in that channel
 * instead of a DM.
 */
export async function notifyConnectSuccess(params: {
  installation: typeof slackOrgInstallations.$inferSelect;
  slackUserId: string;
  orgId: string;
  channelId?: string | null;
  threadTs?: string | null;
  /**
   * Optional prompt captured from the entry URL (e.g. a use-case CTA).
   * When provided and the greeting goes to a DM (not an ephemeral channel
   * message), an additional plain-text DM asks the user whether they want
   * to run this prompt.
   */
  pendingPrompt?: string | null;
}): Promise<void> {
  const {
    installation,
    slackUserId,
    orgId,
    channelId,
    threadTs,
    pendingPrompt,
  } = params;
  const { SECRETS_ENCRYPTION_KEY } = env();
  const botToken = decryptSecretValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);

  let agentName: string | undefined;
  const composeId = await resolveDefaultComposeId(orgId);
  if (composeId) {
    const agent = await getWorkspaceAgent(composeId);
    agentName = agent?.displayName ?? agent?.name;
  }

  const blocks = buildSuccessMessage(
    `You're connected! :tada:\nMention \`@Zero\` in any channel or send a DM to start chatting with your agent.`,
  );

  let sentEphemeral = false;
  if (channelId) {
    try {
      await client.chat.postEphemeral({
        channel: channelId,
        user: slackUserId,
        text: "You're connected!",
        blocks,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      sentEphemeral = true;
    } catch (err) {
      // Bot may not be in the channel — fall back to DM below
      log.warn("Ephemeral failed, falling back to DM", {
        channelId,
        error: err,
      });
    }
  }

  if (!sentEphemeral) {
    const connectMsg = await postMessage(
      client,
      slackUserId,
      "You're connected!",
      { blocks },
    );

    if (connectMsg?.ts) {
      await postMessage(client, slackUserId, "Hi! I'm Zero.", {
        threadTs: connectMsg.ts,
        blocks: buildWelcomeMessage(agentName),
      });

      if (pendingPrompt) {
        // Wrap in a code block to prevent Slack mrkdwn injection
        // (mentions, links, formatting) from user-controlled input.
        const safePrompt = `\`\`\`${pendingPrompt.replaceAll("`", "\u2018")}\`\`\``;
        await postMessage(
          client,
          slackUserId,
          `By the way, would you like me to run this for you?\n\n${safePrompt}\n\nJust paste it in a message and I'll get started!`,
          { threadTs: connectMsg.ts },
        );
      }
    }

    await globalThis.services.db
      .update(slackOrgConnections)
      .set({ dmWelcomeSent: true })
      .where(
        and(
          eq(slackOrgConnections.slackUserId, slackUserId),
          eq(
            slackOrgConnections.slackWorkspaceId,
            installation.slackWorkspaceId,
          ),
        ),
      );
  }

  await refreshOrgAppHome(client, installation, slackUserId);
}
