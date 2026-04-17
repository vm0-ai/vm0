import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { initServices } from "../../lib/init-services";
import { slackOrgInstallations } from "../../db/schema/slack-org-installation";
import { slackOrgThreadSessions } from "../../db/schema/slack-org-thread-session";
import {
  insertSlackConnectionIfMissing,
  upsertSlackInstallation,
} from "../../lib/zero/slack/seed-install";
import { uniqueId } from "../test-helpers";

/**
 * @why-db-direct Slack OAuth callback requires real API interaction to exchange
 * authorization code for bot token; no test-friendly API endpoint exists.
 *
 * Creates an org-aware Slack installation with encrypted bot token.
 */
export async function createTestSlackOrgInstallation(opts: {
  workspaceId?: string;
  workspaceName?: string;
  orgId: string | null;
  botScopes?: string | null;
}): Promise<{
  slackWorkspaceId: string;
  slackWorkspaceName: string;
  installation: typeof slackOrgInstallations.$inferSelect;
}> {
  initServices();

  const workspaceId = opts.workspaceId ?? `T-${randomUUID().slice(0, 8)}`;
  const workspaceName = opts.workspaceName ?? "Test Org Workspace";

  const { installation } = await upsertSlackInstallation(globalThis.services, {
    slackWorkspaceId: workspaceId,
    slackWorkspaceName: workspaceName,
    orgId: opts.orgId,
    botUserId: `B-${randomUUID().slice(0, 8)}`,
    botToken: "xoxb-test-bot-token",
    botScopes: opts.botScopes ?? null,
  });

  return {
    slackWorkspaceId: workspaceId,
    slackWorkspaceName: workspaceName,
    installation,
  };
}

/**
 * @why-db-direct Connect API calls Slack to send DM notifications; test setup
 * needs connections without Slack API side effects.
 *
 * Creates an org-aware Slack connection, validating the installation has an orgId.
 */
export async function createTestSlackOrgConnection(opts: {
  slackUserId?: string;
  slackWorkspaceId: string;
  vm0UserId: string;
}): Promise<{ slackUserId: string; connectionId: string }> {
  initServices();

  const slackUserId = opts.slackUserId ?? `U-${randomUUID().slice(0, 8)}`;

  const [installation] = await globalThis.services.db
    .select({ orgId: slackOrgInstallations.orgId })
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, opts.slackWorkspaceId))
    .limit(1);

  if (!installation?.orgId) {
    throw new Error(
      `No installation with orgId found for workspace ${opts.slackWorkspaceId}`,
    );
  }

  const { connectionId } = await insertSlackConnectionIfMissing(
    globalThis.services,
    {
      slackUserId,
      slackWorkspaceId: opts.slackWorkspaceId,
      vm0UserId: opts.vm0UserId,
    },
  );

  if (!connectionId) {
    throw new Error("Failed to create Slack org connection");
  }

  return { slackUserId, connectionId };
}

/**
 * @why-db-direct Direct insert without installation-orgId validation; needed
 * for cleanup/disconnect tests where installation may lack orgId.
 *
 * Delegates to the shared `insertSlackConnectionIfMissing` helper so the
 * schema-aware insert lives in one place.
 */
export async function seedTestSlackOrgConnection(opts: {
  slackUserId: string;
  slackWorkspaceId: string;
  vm0UserId: string;
}): Promise<{ connectionId: string }> {
  initServices();
  const { connectionId } = await insertSlackConnectionIfMissing(
    globalThis.services,
    {
      slackUserId: opts.slackUserId,
      slackWorkspaceId: opts.slackWorkspaceId,
      vm0UserId: opts.vm0UserId,
    },
  );
  if (!connectionId) {
    throw new Error("Failed to seed Slack org connection");
  }
  return { connectionId };
}

/**
 * @why-db-direct Minimal installation for external cleanup tests; no API path
 * creates installations without real OAuth.
 *
 * Uses the shared `upsertSlackInstallation` helper so schema changes to
 * `slack_org_installations` land in one place.
 */
export async function createSlackInstallationForOrg(
  orgId: string,
  workspaceId: string,
): Promise<void> {
  initServices();
  await upsertSlackInstallation(globalThis.services, {
    slackWorkspaceId: workspaceId,
    orgId,
    botUserId: `U${randomUUID().slice(0, 8)}`,
    botToken: "xoxb-test-token",
  });
}

/**
 * @why-db-direct Simple installation without encrypted tokens for
 * deletion/cascade tests.
 */
export async function insertTestSlackOrgInstallation(params: {
  slackWorkspaceId: string;
  slackWorkspaceName: string;
  orgId: string;
  installedByUserId: string;
}): Promise<void> {
  await globalThis.services.db.insert(slackOrgInstallations).values({
    slackWorkspaceId: params.slackWorkspaceId,
    slackWorkspaceName: params.slackWorkspaceName,
    orgId: params.orgId,
    encryptedBotToken: "enc-token-test",
    botUserId: "bot-user-test",
    installedByUserId: params.installedByUserId,
  });
}

/**
 * @why-db-direct Direct connection insert for deletion/cascade tests.
 *
 * Delegates to the shared `insertSlackConnectionIfMissing` helper so the
 * schema-aware insert lives in one place.
 */
export async function insertTestSlackOrgConnection(params: {
  slackUserId: string;
  slackWorkspaceId: string;
  vm0UserId: string;
}): Promise<{ id: string }> {
  initServices();
  const { connectionId } = await insertSlackConnectionIfMissing(
    globalThis.services,
    {
      slackUserId: params.slackUserId,
      slackWorkspaceId: params.slackWorkspaceId,
      vm0UserId: params.vm0UserId,
    },
  );
  if (!connectionId) {
    throw new Error("Failed to insert Slack org connection");
  }
  return { id: connectionId };
}

/**
 * @why-db-direct Thread session requires pre-existing connection ID; no API
 * creates thread sessions directly.
 */
export async function insertTestSlackOrgThreadSession(params: {
  connectionId: string;
  agentSessionId?: string;
}): Promise<{ id: string }> {
  const [row] = await globalThis.services.db
    .insert(slackOrgThreadSessions)
    .values({
      connectionId: params.connectionId,
      slackChannelId: "C-test",
      slackThreadTs: uniqueId("ts"),
      ...(params.agentSessionId && { agentSessionId: params.agentSessionId }),
    })
    .returning({ id: slackOrgThreadSessions.id });
  return row!;
}
