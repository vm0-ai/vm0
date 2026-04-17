import { slackOrgInstallations } from "../../../db/schema/slack-org-installation";
import { slackOrgConnections } from "../../../db/schema/slack-org-connection";
import { encryptSecretValue } from "../../shared/crypto/secrets-encryption";

interface Services {
  db: typeof globalThis.services.db;
  env: { SECRETS_ENCRYPTION_KEY: string };
}

interface UpsertSlackInstallationInput {
  slackWorkspaceId: string;
  slackWorkspaceName?: string;
  orgId: string | null;
  botUserId: string;
  botToken: string;
  botScopes?: string | null;
  installedByUserId?: string;
}

/**
 * Upsert a Slack org installation row with an encrypted bot token and
 * return the resulting row.
 *
 * Shared between the Vitest seeder (`src/__tests__/db-test-seeders/slack.ts`)
 * and the e2e HTTP seeder (`app/api/test/slack-state/route.ts`) so the
 * schema-aware write lives in one place.
 */
export async function upsertSlackInstallation(
  services: Services,
  input: UpsertSlackInstallationInput,
): Promise<{
  slackWorkspaceId: string;
  installation: typeof slackOrgInstallations.$inferSelect;
}> {
  const encryptedBotToken = encryptSecretValue(
    input.botToken,
    services.env.SECRETS_ENCRYPTION_KEY,
  );

  const [row] = await services.db
    .insert(slackOrgInstallations)
    .values({
      slackWorkspaceId: input.slackWorkspaceId,
      slackWorkspaceName: input.slackWorkspaceName,
      orgId: input.orgId,
      encryptedBotToken,
      botUserId: input.botUserId,
      botScopes: input.botScopes ?? null,
      installedByUserId: input.installedByUserId,
    })
    .onConflictDoUpdate({
      target: slackOrgInstallations.slackWorkspaceId,
      set: {
        orgId: input.orgId,
        encryptedBotToken,
        botUserId: input.botUserId,
      },
    })
    .returning();

  if (!row) {
    throw new Error("Failed to upsert Slack installation");
  }

  return { slackWorkspaceId: input.slackWorkspaceId, installation: row };
}

interface UpsertSlackConnectionInput {
  slackUserId: string;
  slackWorkspaceId: string;
  vm0UserId: string;
}

/**
 * Insert a Slack org connection row idempotently (no-op if a row already
 * exists for the same workspace + Slack user pair). Returns the connection
 * id on fresh insert or `undefined` if the row already existed.
 */
export async function insertSlackConnectionIfMissing(
  services: Services,
  input: UpsertSlackConnectionInput,
): Promise<{ connectionId: string | undefined }> {
  const [row] = await services.db
    .insert(slackOrgConnections)
    .values({
      slackUserId: input.slackUserId,
      slackWorkspaceId: input.slackWorkspaceId,
      vm0UserId: input.vm0UserId,
    })
    .onConflictDoNothing()
    .returning({ id: slackOrgConnections.id });
  return { connectionId: row?.id };
}
