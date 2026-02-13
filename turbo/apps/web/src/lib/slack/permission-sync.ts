import { eq, and, inArray } from "drizzle-orm";
import { slackUserLinks } from "../../db/schema/slack-user-link";
import { agentPermissions } from "../../db/schema/agent-permission";
import { getUserEmail } from "../auth/get-user-email";
import { resolveDefaultAgentComposeId } from "./index";
import { logger } from "../logger";
import type { Database } from "../../types/global";

const log = logger("slack:permission-sync");

/**
 * Sync agent permissions for all linked users in a Slack workspace
 * when the workspace default agent is switched.
 *
 * - Revokes email permissions on the old agent (unless it's the SLACK_DEFAULT_AGENT)
 * - Grants email permissions on the new agent
 *
 * When `dbOverride` is provided (a caller's transaction), permission writes
 * execute directly on it — no nested transaction / savepoint is created.
 * When omitted, a new transaction is opened for the permission writes.
 */
export async function syncWorkspaceAgentPermissions(
  oldComposeId: string,
  newComposeId: string,
  slackWorkspaceId: string,
  adminSlackUserId: string,
  dbOverride?: Database,
): Promise<void> {
  if (oldComposeId === newComposeId) {
    return;
  }

  const db = dbOverride ?? globalThis.services.db;

  // 1. Query all linked users in the workspace
  const linkedUsers = await db
    .select({ vm0UserId: slackUserLinks.vm0UserId })
    .from(slackUserLinks)
    .where(eq(slackUserLinks.slackWorkspaceId, slackWorkspaceId));

  if (linkedUsers.length === 0) {
    return;
  }

  // 2. Resolve emails in parallel
  const emails = (
    await Promise.all(linkedUsers.map((u) => getUserEmail(u.vm0UserId)))
  ).filter((e): e is string => !!e);

  if (emails.length === 0) {
    return;
  }

  // 3. Determine if old agent is the SLACK_DEFAULT_AGENT (skip revocation)
  const defaultComposeId = await resolveDefaultAgentComposeId();
  const skipRevoke = oldComposeId === defaultComposeId;

  // 4. Batch permission changes
  // When dbOverride is provided (caller's transaction), use it directly
  // to avoid nested savepoints. Otherwise, open a new transaction.
  const execute = async (tx: Database) => {
    if (!skipRevoke) {
      await tx
        .delete(agentPermissions)
        .where(
          and(
            eq(agentPermissions.agentComposeId, oldComposeId),
            eq(agentPermissions.granteeType, "email"),
            inArray(agentPermissions.granteeEmail, emails),
          ),
        );
    }

    await tx
      .insert(agentPermissions)
      .values(
        emails.map((email) => ({
          agentComposeId: newComposeId,
          granteeType: "email" as const,
          granteeEmail: email,
          grantedBy: adminSlackUserId,
        })),
      )
      .onConflictDoNothing();
  };

  if (dbOverride) {
    await execute(dbOverride);
  } else {
    await db.transaction(async (tx) => execute(tx));
  }

  log.info("Synced workspace agent permissions", {
    slackWorkspaceId,
    oldComposeId,
    newComposeId,
    skipRevoke,
    userCount: emails.length,
  });
}
