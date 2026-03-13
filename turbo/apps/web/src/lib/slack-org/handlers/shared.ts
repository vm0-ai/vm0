import { eq, and } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { slackOrgInstallations } from "../../../db/schema/slack-org-installation";
import { slackOrgConnections } from "../../../db/schema/slack-org-connection";
import { slackOrgThreadSessions } from "../../../db/schema/slack-org-thread-session";
import { getPlatformUrl } from "../../url";
import { resolveDefaultAgentComposeId } from "../../agent-compose/resolve-default";
import { ensureStorageExists } from "../../storage/storage-service";

/**
 * Resolve installation and org from a Slack workspace ID.
 * Returns null if the workspace is not installed or not bound to an org.
 */
export async function resolveOrgFromWorkspace(workspaceId: string): Promise<{
  installation: typeof slackOrgInstallations.$inferSelect;
  orgId: string;
} | null> {
  const [installation] = await globalThis.services.db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId))
    .limit(1);

  if (!installation?.orgId) {
    return null;
  }

  return { installation, orgId: installation.orgId };
}

/**
 * Resolve a connection from a Slack user in a workspace.
 */
export async function resolveConnectionFromSlackUser(
  slackUserId: string,
  workspaceId: string,
): Promise<typeof slackOrgConnections.$inferSelect | null> {
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

  return connection ?? null;
}

/**
 * Resolve default agent compose ID from Clerk org metadata.
 * Falls back to VM0_DEFAULT_AGENT env var if not set.
 */
export async function resolveDefaultComposeId(
  orgId: string,
): Promise<string | null> {
  // For now, read from Clerk org metadata via org cache
  // The publicMetadata.default_agent_compose_id field may not yet exist,
  // so we read it via getOrgData which fetches from Clerk API
  const clerk = await clerkClient();
  const org = await clerk.organizations.getOrganization({
    organizationId: orgId,
  });

  const metadata = org.publicMetadata as Record<string, unknown> | undefined;
  const composeId = metadata?.default_agent_compose_id;

  if (typeof composeId === "string" && composeId.length > 0) {
    return composeId;
  }

  // Fallback: resolve from VM0_DEFAULT_AGENT env var
  return resolveDefaultAgentComposeId();
}

/**
 * Look up an existing thread session for deduplication.
 */
export async function lookupThreadSession(
  channelId: string,
  threadTs: string,
  connectionId: string,
): Promise<{
  existingSessionId: string | undefined;
  lastProcessedMessageTs: string | undefined;
}> {
  const [session] = await globalThis.services.db
    .select({
      agentSessionId: slackOrgThreadSessions.agentSessionId,
      lastProcessedMessageTs: slackOrgThreadSessions.lastProcessedMessageTs,
    })
    .from(slackOrgThreadSessions)
    .where(
      and(
        eq(slackOrgThreadSessions.connectionId, connectionId),
        eq(slackOrgThreadSessions.slackChannelId, channelId),
        eq(slackOrgThreadSessions.slackThreadTs, threadTs),
      ),
    )
    .limit(1);

  return {
    existingSessionId: session?.agentSessionId ?? undefined,
    lastProcessedMessageTs: session?.lastProcessedMessageTs ?? undefined,
  };
}

/**
 * Save or update a thread session mapping after agent execution.
 */
export async function saveThreadSession(opts: {
  connectionId: string;
  channelId: string;
  threadTs: string;
  existingSessionId: string | undefined;
  newSessionId: string | undefined;
  messageTs: string;
  runStatus: string;
}): Promise<void> {
  const {
    connectionId,
    channelId,
    threadTs,
    existingSessionId,
    newSessionId,
    messageTs,
    runStatus,
  } = opts;

  const agentSessionId = newSessionId ?? existingSessionId;

  // Skip update on failed runs — allows retry with same context
  if (runStatus === "failed") {
    return;
  }

  if (!existingSessionId && agentSessionId) {
    // Create new mapping
    await globalThis.services.db
      .insert(slackOrgThreadSessions)
      .values({
        connectionId,
        slackChannelId: channelId,
        slackThreadTs: threadTs,
        agentSessionId,
        lastProcessedMessageTs: messageTs,
      })
      .onConflictDoUpdate({
        target: [
          slackOrgThreadSessions.connectionId,
          slackOrgThreadSessions.slackChannelId,
          slackOrgThreadSessions.slackThreadTs,
        ],
        set: {
          agentSessionId,
          lastProcessedMessageTs: messageTs,
          updatedAt: new Date(),
        },
      });
  } else if (existingSessionId) {
    // Update existing mapping
    await globalThis.services.db
      .update(slackOrgThreadSessions)
      .set({
        lastProcessedMessageTs: messageTs,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(slackOrgThreadSessions.connectionId, connectionId),
          eq(slackOrgThreadSessions.slackChannelId, channelId),
          eq(slackOrgThreadSessions.slackThreadTs, threadTs),
        ),
      );
  }
}

/**
 * Build the org connect URL for Slack users.
 */
export function buildOrgConnectUrl(
  workspaceId: string,
  slackUserId: string,
  channelId: string,
): string {
  const baseUrl = getPlatformUrl();
  const params = new URLSearchParams({
    w: workspaceId,
    u: slackUserId,
    c: channelId,
  });
  return `${baseUrl}/integrations/slack/org/connect?${params.toString()}`;
}

/**
 * Ensure artifact storage exists for a user in a specific org.
 * Unlike the legacy version, this takes explicit org context.
 */
export async function ensureOrgArtifact(
  userId: string,
  orgId: string,
  orgSlug: string,
): Promise<void> {
  await ensureStorageExists(orgId, userId, "artifact", orgSlug, "artifact");
}

// Re-export pure functions from legacy shared module
export {
  fetchConversationContexts,
  enrichMessageContent,
  buildLogsUrl,
  buildAgentLogsUrl,
  getWorkspaceAgent,
  resolveSessionCompose,
} from "../../slack/handlers/shared";
