import { eq, and } from "drizzle-orm";
import { phoneUserLinks } from "../../../../db/schema/phone-user-link";
import { phoneThreadSessions } from "../../../../db/schema/phone-thread-session";
import { orgMetadata } from "../../../../db/schema/org-metadata";

/**
 * Look up an existing phone thread session by (userId, orgId).
 */
export async function lookupPhoneThreadSession(
  userId: string,
  orgId: string,
): Promise<{ agentSessionId: string; lastCallId: string | null } | undefined> {
  const [session] = await globalThis.services.db
    .select({
      agentSessionId: phoneThreadSessions.agentSessionId,
      lastCallId: phoneThreadSessions.lastCallId,
    })
    .from(phoneThreadSessions)
    .where(
      and(
        eq(phoneThreadSessions.userId, userId),
        eq(phoneThreadSessions.orgId, orgId),
      ),
    )
    .limit(1);

  return session ?? undefined;
}

/**
 * Save or update a phone thread session mapping after run completion.
 */
export async function savePhoneThreadSession(opts: {
  userId: string;
  orgId: string;
  existingSessionId: string | undefined;
  newSessionId: string | undefined;
  callId: string;
  runStatus: string;
}): Promise<void> {
  const { userId, orgId, existingSessionId, newSessionId, callId, runStatus } =
    opts;

  if (!existingSessionId && newSessionId) {
    // New session — insert
    await globalThis.services.db
      .insert(phoneThreadSessions)
      .values({
        userId,
        orgId,
        agentSessionId: newSessionId,
        lastCallId: callId,
      })
      .onConflictDoNothing();
  } else if (
    existingSessionId &&
    (runStatus === "completed" || runStatus === "timeout")
  ) {
    // Existing session, successful run — update lastCallId
    await globalThis.services.db
      .update(phoneThreadSessions)
      .set({
        lastCallId: callId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(phoneThreadSessions.userId, userId),
          eq(phoneThreadSessions.orgId, orgId),
        ),
      );
  }
}

/**
 * Resolve the org from an AgentPhone agent ID stored in org_metadata.
 */
export async function resolveOrgByAgentphoneAgentId(
  agentphoneAgentId: string,
): Promise<{
  orgId: string;
  defaultAgentId: string | null;
} | null> {
  const [org] = await globalThis.services.db
    .select({
      orgId: orgMetadata.orgId,
      defaultAgentId: orgMetadata.defaultAgentId,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.agentphoneAgentId, agentphoneAgentId))
    .limit(1);

  return org ?? null;
}

/**
 * Resolve a VM0 user from a verified phone number + org.
 */
export async function resolveUserByPhone(
  phoneNumber: string,
  orgId: string,
): Promise<string | null> {
  const [link] = await globalThis.services.db
    .select({ vm0UserId: phoneUserLinks.vm0UserId })
    .from(phoneUserLinks)
    .where(
      and(
        eq(phoneUserLinks.orgId, orgId),
        eq(phoneUserLinks.phoneNumber, phoneNumber),
        eq(phoneUserLinks.verified, true),
      ),
    )
    .limit(1);

  return link?.vm0UserId ?? null;
}
