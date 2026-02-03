"use server";

import { auth } from "@clerk/nextjs/server";
import { eq, and } from "drizzle-orm";
import { initServices } from "../../../src/lib/init-services";
import { slackUserLinks } from "../../../src/db/schema/slack-user-link";
import { slackInstallations } from "../../../src/db/schema/slack-installation";

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
  const { userId } = await auth();

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
): Promise<LinkResult> {
  const { userId } = await auth();

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
      return { success: true, alreadyLinked: true };
    }
    return {
      success: false,
      error: "This Slack account is already linked to a different VM0 account.",
    };
  }

  // Create the link
  await globalThis.services.db.insert(slackUserLinks).values({
    slackUserId,
    slackWorkspaceId: workspaceId,
    vm0UserId: userId,
  });

  return { success: true };
}
