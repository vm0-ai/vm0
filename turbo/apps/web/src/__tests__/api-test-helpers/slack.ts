import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { initServices } from "../../lib/init-services";
import { slackOrgInstallations } from "../../db/schema/slack-org-installation";
import { slackOrgConnections } from "../../db/schema/slack-org-connection";
import { slackOrgPendingQuestions } from "../../db/schema/slack-org-pending-question";
import { slackOrgThreadSessions } from "../../db/schema/slack-org-thread-session";
import { encryptSecretValue } from "../../lib/shared/crypto/secrets-encryption";
import { uniqueId } from "../test-helpers";
export { SLACK_BOT_SCOPES } from "../../lib/zero/slack-org/scopes";

/**
 * Create an org-aware Slack installation for testing.
 *
 * Direct DB insert is required because the org Slack OAuth callback
 * requires real Slack API interaction that cannot be easily mocked.
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
  const { SECRETS_ENCRYPTION_KEY } = globalThis.services.env;

  const workspaceId = opts.workspaceId ?? `T-${randomUUID().slice(0, 8)}`;
  const workspaceName = opts.workspaceName ?? "Test Org Workspace";

  const encryptedBotToken = encryptSecretValue(
    "xoxb-test-bot-token",
    SECRETS_ENCRYPTION_KEY,
  );

  const [installation] = await globalThis.services.db
    .insert(slackOrgInstallations)
    .values({
      slackWorkspaceId: workspaceId,
      slackWorkspaceName: workspaceName,
      orgId: opts.orgId,
      encryptedBotToken,
      botUserId: `B-${randomUUID().slice(0, 8)}`,
      botScopes: opts.botScopes ?? null,
    })
    .returning();

  if (!installation) {
    throw new Error("Failed to create test Slack org installation");
  }

  return {
    slackWorkspaceId: workspaceId,
    slackWorkspaceName: workspaceName,
    installation,
  };
}

/**
 * Create an org-aware Slack connection for testing.
 *
 * Direct DB insert is required because the connect API requires
 * Slack workspace context that is only available during real OAuth.
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

  const [connection] = await globalThis.services.db
    .insert(slackOrgConnections)
    .values({
      slackUserId,
      slackWorkspaceId: opts.slackWorkspaceId,
      vm0UserId: opts.vm0UserId,
    })
    .returning({ id: slackOrgConnections.id });

  return { slackUserId, connectionId: connection!.id };
}

export async function findTestSlackOrgInstallation(workspaceId: string) {
  const [row] = await globalThis.services.db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId))
    .limit(1);
  return row;
}

export async function findTestSlackOrgConnections(
  slackUserId: string,
  workspaceId: string,
) {
  return globalThis.services.db
    .select()
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.slackUserId, slackUserId),
        eq(slackOrgConnections.slackWorkspaceId, workspaceId),
      ),
    );
}

export async function findTestSlackOrgConnection(
  slackUserId: string,
  workspaceId: string,
) {
  const [row] = await globalThis.services.db
    .select()
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.slackUserId, slackUserId),
        eq(slackOrgConnections.slackWorkspaceId, workspaceId),
      ),
    );
  return row;
}

/**
 * Seed a Slack org connection directly for testing cleanup scenarios.
 *
 * Unlike createTestSlackOrgConnection, this does not require the
 * installation to have an orgId.
 */
export async function seedTestSlackOrgConnection(opts: {
  slackUserId: string;
  slackWorkspaceId: string;
  vm0UserId: string;
}): Promise<{ connectionId: string }> {
  initServices();
  const [row] = await globalThis.services.db
    .insert(slackOrgConnections)
    .values({
      slackUserId: opts.slackUserId,
      slackWorkspaceId: opts.slackWorkspaceId,
      vm0UserId: opts.vm0UserId,
    })
    .returning({ id: slackOrgConnections.id });
  if (!row) {
    throw new Error("Failed to seed Slack org connection");
  }
  return { connectionId: row.id };
}

/**
 * Create a Slack org installation for a specific org.
 */
export async function createSlackInstallationForOrg(
  orgId: string,
  workspaceId: string,
): Promise<void> {
  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;

  await globalThis.services.db
    .insert(slackOrgInstallations)
    .values({
      slackWorkspaceId: workspaceId,
      orgId,
      encryptedBotToken: encryptSecretValue("xoxb-test-token", encryptionKey),
      botUserId: `U${randomUUID().slice(0, 8)}`,
    })
    .onConflictDoNothing();
}

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

export async function insertTestSlackOrgConnection(params: {
  slackUserId: string;
  slackWorkspaceId: string;
  vm0UserId: string;
}): Promise<{ id: string }> {
  const [row] = await globalThis.services.db
    .insert(slackOrgConnections)
    .values({
      slackUserId: params.slackUserId,
      slackWorkspaceId: params.slackWorkspaceId,
      vm0UserId: params.vm0UserId,
    })
    .returning({ id: slackOrgConnections.id });
  return row!;
}

export async function insertTestSlackOrgPendingQuestion(params: {
  connectionId: string;
  composeId: string;
  sessionId: string;
  runId: string;
  slackWorkspaceId: string;
}): Promise<void> {
  await globalThis.services.db.insert(slackOrgPendingQuestions).values({
    connectionId: params.connectionId,
    composeId: params.composeId,
    sessionId: params.sessionId,
    runId: params.runId,
    slackWorkspaceId: params.slackWorkspaceId,
    slackChannelId: "C-test",
    slackThreadTs: "1234.5678",
    slackMessageTs: "1234.5679",
    agentName: "test-agent",
    questions: [{ question: "test?" }],
    expiresAt: new Date(Date.now() + 3600000),
  });
}

export async function insertTestSlackOrgPendingQuestionNoSession(params: {
  connectionId: string;
  composeId: string;
  runId: string;
  slackWorkspaceId: string;
}): Promise<void> {
  await globalThis.services.db.insert(slackOrgPendingQuestions).values({
    connectionId: params.connectionId,
    composeId: params.composeId,
    runId: params.runId,
    slackWorkspaceId: params.slackWorkspaceId,
    slackChannelId: "C-test",
    slackThreadTs: "1234.5678",
    slackMessageTs: "1234.5679",
    agentName: "test-agent",
    questions: [{ question: "test?" }],
    expiresAt: new Date(Date.now() + 3600000),
  });
}

export async function insertTestSlackOrgThreadSession(params: {
  connectionId: string;
  agentSessionId?: string;
}): Promise<void> {
  await globalThis.services.db.insert(slackOrgThreadSessions).values({
    connectionId: params.connectionId,
    slackChannelId: "C-test",
    slackThreadTs: uniqueId("ts"),
    ...(params.agentSessionId && { agentSessionId: params.agentSessionId }),
  });
}

/**
 * Count Slack org installations for a workspace.
 */
export async function countSlackOrgInstallations(
  workspaceId: string,
): Promise<number> {
  initServices();
  const rows = await globalThis.services.db
    .select({ id: slackOrgInstallations.slackWorkspaceId })
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId));
  return rows.length;
}

/**
 * Count Slack org connections for a workspace.
 */
export async function countSlackOrgConnections(
  workspaceId: string,
): Promise<number> {
  initServices();
  const rows = await globalThis.services.db
    .select({ id: slackOrgConnections.id })
    .from(slackOrgConnections)
    .where(eq(slackOrgConnections.slackWorkspaceId, workspaceId));
  return rows.length;
}

/**
 * Count Slack org pending questions for a connection.
 */
export async function countSlackOrgPendingQuestions(
  connectionId: string,
): Promise<number> {
  initServices();
  const rows = await globalThis.services.db
    .select({ id: slackOrgPendingQuestions.id })
    .from(slackOrgPendingQuestions)
    .where(eq(slackOrgPendingQuestions.connectionId, connectionId));
  return rows.length;
}

/**
 * Count rows in slack_org_connections where vm0_user_id matches.
 */
export async function countSlackConnectionRows(
  vm0UserId: string,
): Promise<number> {
  const rows = await globalThis.services.db.execute(
    sql`SELECT COUNT(*)::int AS count FROM slack_org_connections WHERE vm0_user_id = ${vm0UserId}`,
  );
  return (rows.rows[0] as { count: number }).count;
}

export async function findTestSlackOrgConnectionsByVm0UserId(
  vm0UserId: string,
) {
  return globalThis.services.db
    .select()
    .from(slackOrgConnections)
    .where(eq(slackOrgConnections.vm0UserId, vm0UserId));
}

export async function findTestSlackOrgPendingQuestionsByConnectionId(
  connectionId: string,
) {
  return globalThis.services.db
    .select()
    .from(slackOrgPendingQuestions)
    .where(eq(slackOrgPendingQuestions.connectionId, connectionId));
}

/**
 * Seed a Slack org pending question for testing.
 */
export async function seedTestSlackOrgPendingQuestion(opts: {
  runId: string;
  slackWorkspaceId: string;
  slackChannelId: string;
  slackThreadTs: string;
  slackMessageTs?: string;
  connectionId: string;
  composeId: string;
  agentName: string;
  questions: unknown;
  expiresAt: Date;
}): Promise<{ pendingQuestionId: string }> {
  initServices();
  const [row] = await globalThis.services.db
    .insert(slackOrgPendingQuestions)
    .values({
      runId: opts.runId,
      slackWorkspaceId: opts.slackWorkspaceId,
      slackChannelId: opts.slackChannelId,
      slackThreadTs: opts.slackThreadTs,
      slackMessageTs: opts.slackMessageTs,
      connectionId: opts.connectionId,
      composeId: opts.composeId,
      agentName: opts.agentName,
      questions: opts.questions,
      expiresAt: opts.expiresAt,
    })
    .returning({ id: slackOrgPendingQuestions.id });
  if (!row) {
    throw new Error("Failed to seed pending question");
  }
  return { pendingQuestionId: row.id };
}

/**
 * Update a pending question record to simulate a user answering.
 */
export async function updateTestPendingQuestionAnswer(
  pendingId: string,
  answer: string,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(slackOrgPendingQuestions)
    .set({ answer, answeredAt: new Date() })
    .where(eq(slackOrgPendingQuestions.id, pendingId));
}

/**
 * Update a pending question record's expiration to simulate expiry.
 */
export async function updateTestPendingQuestionExpiry(
  pendingId: string,
  expiresAt: Date,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(slackOrgPendingQuestions)
    .set({ expiresAt })
    .where(eq(slackOrgPendingQuestions.id, pendingId));
}

/**
 * Find a pending question record by ID.
 */
export async function findTestPendingQuestion(pendingId: string) {
  initServices();
  const [row] = await globalThis.services.db
    .select()
    .from(slackOrgPendingQuestions)
    .where(eq(slackOrgPendingQuestions.id, pendingId))
    .limit(1);
  return row;
}
