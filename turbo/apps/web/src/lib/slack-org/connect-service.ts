import { eq, and, isNull } from "drizzle-orm";
import { slackOrgInstallations } from "../../db/schema/slack-org-installation";
import { slackOrgConnections } from "../../db/schema/slack-org-connection";
import { addPermission } from "../agent/permission-service";
import { getUserEmail } from "../auth/get-user-email";
import { resolveDefaultComposeId, ensureOrgArtifact } from "./handlers/shared";
import { getOrgData } from "../org/org-cache-service";
import { logger } from "../logger";

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
      orgId,
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

  // Grant agent permission via email
  await grantAgentPermission(userId, orgId);

  // Ensure artifact storage
  const orgData = await getOrgData(orgId);
  await ensureOrgArtifact(userId, orgId, orgData.slug);

  log.info("Admin connected workspace to org", {
    workspaceId,
    orgId,
    userId,
  });

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
      orgId,
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

  // Grant agent permission
  await grantAgentPermission(userId, orgId);

  // Ensure artifact storage
  const orgData = await getOrgData(orgId);
  await ensureOrgArtifact(userId, orgId, orgData.slug);

  log.info("Member connected to workspace", {
    workspaceId,
    orgId,
    userId,
  });

  return { connection: finalConnection };
}

/**
 * Disconnect a user from Slack.
 */
export async function disconnect(params: {
  connectionId: string;
  userId: string;
}): Promise<void> {
  const { connectionId } = params;

  await globalThis.services.db
    .delete(slackOrgConnections)
    .where(eq(slackOrgConnections.id, connectionId));

  log.info("User disconnected from Slack", params);
}

/**
 * Grant agent permission to user via email for the org's default agent.
 */
async function grantAgentPermission(
  userId: string,
  orgId: string,
): Promise<void> {
  const email = await getUserEmail(userId);
  if (!email) return;

  const composeId = await resolveDefaultComposeId(orgId);
  if (!composeId) return;

  await addPermission(composeId, "email", userId, email).catch((error) => {
    log.warn("Failed to grant agent permission", { error, userId, orgId });
  });
}
