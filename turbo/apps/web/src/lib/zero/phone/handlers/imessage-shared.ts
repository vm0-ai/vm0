import { eq, and } from "drizzle-orm";
import { imessageUserLinks } from "../../../../db/schema/imessage-user-link";
import { imessageThreadSessions } from "../../../../db/schema/imessage-thread-session";
import { orgMetadata } from "../../../../db/schema/org-metadata";

/**
 * Look up an existing iMessage thread session by (userId, orgId).
 */
export async function lookupIMessageThreadSession(
  userId: string,
  orgId: string,
): Promise<
  { agentSessionId: string; lastMessageId: string | null } | undefined
> {
  const [session] = await globalThis.services.db
    .select({
      agentSessionId: imessageThreadSessions.agentSessionId,
      lastMessageId: imessageThreadSessions.lastMessageId,
    })
    .from(imessageThreadSessions)
    .where(
      and(
        eq(imessageThreadSessions.userId, userId),
        eq(imessageThreadSessions.orgId, orgId),
      ),
    )
    .limit(1);

  return session ?? undefined;
}

/**
 * Save or update an iMessage thread session mapping after run completion.
 */
export async function saveIMessageThreadSession(opts: {
  userId: string;
  orgId: string;
  existingSessionId: string | undefined;
  newSessionId: string | undefined;
  messageId: string;
  runStatus: string;
}): Promise<void> {
  const {
    userId,
    orgId,
    existingSessionId,
    newSessionId,
    messageId,
    runStatus,
  } = opts;

  if (!existingSessionId && newSessionId) {
    await globalThis.services.db
      .insert(imessageThreadSessions)
      .values({
        userId,
        orgId,
        agentSessionId: newSessionId,
        lastMessageId: messageId,
      })
      .onConflictDoNothing();
  } else if (
    existingSessionId &&
    (runStatus === "completed" || runStatus === "timeout")
  ) {
    await globalThis.services.db
      .update(imessageThreadSessions)
      .set({
        lastMessageId: messageId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(imessageThreadSessions.userId, userId),
          eq(imessageThreadSessions.orgId, orgId),
        ),
      );
  }
}

/**
 * Resolve org from AgentPhone agent ID (reuses the same org_metadata lookup).
 */
export async function resolveOrgByAgentphoneAgentId(
  agentphoneAgentId: string,
): Promise<{
  orgId: string;
  defaultAgentId: string | null;
  agentphoneAgentId: string;
} | null> {
  const [org] = await globalThis.services.db
    .select({
      orgId: orgMetadata.orgId,
      defaultAgentId: orgMetadata.defaultAgentId,
      agentphoneAgentId: orgMetadata.agentphoneAgentId,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.agentphoneAgentId, agentphoneAgentId))
    .limit(1);

  if (!org?.agentphoneAgentId) return null;

  return {
    orgId: org.orgId,
    defaultAgentId: org.defaultAgentId,
    agentphoneAgentId: org.agentphoneAgentId,
  };
}

/**
 * Resolve a VM0 user from an iMessage handle (globally unique).
 * Returns the user ID and org ID if the handle is bound.
 */
export async function resolveUserByIMessageHandle(
  imessageHandle: string,
): Promise<{ vm0UserId: string; orgId: string } | null> {
  const [link] = await globalThis.services.db
    .select({
      vm0UserId: imessageUserLinks.vm0UserId,
      orgId: imessageUserLinks.orgId,
    })
    .from(imessageUserLinks)
    .where(eq(imessageUserLinks.imessageHandle, imessageHandle))
    .limit(1);

  return link ?? null;
}
