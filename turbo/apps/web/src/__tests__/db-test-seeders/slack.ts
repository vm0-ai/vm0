import { randomUUID } from "crypto";
import { initServices } from "../../lib/init-services";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { slackOrgThreadSessions } from "@vm0/db/schema/slack-org-thread-session";
import {
  insertSlackConnectionIfMissing,
  upsertSlackInstallation,
} from "../../lib/zero/slack/seed-install";
import { uniqueId } from "../test-helpers";

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
 *
 * `slackChannelId` / `slackThreadTs` default to unique values so callers who
 * don't care get isolation. Pass explicit values to co-locate several sessions
 * in the same thread (e.g. to simulate multiple Slack users mentioning the
 * agent in one conversation).
 */
export async function insertTestSlackOrgThreadSession(params: {
  connectionId: string;
  agentSessionId?: string;
  slackChannelId?: string;
  slackThreadTs?: string;
}): Promise<{ id: string }> {
  const [row] = await globalThis.services.db
    .insert(slackOrgThreadSessions)
    .values({
      connectionId: params.connectionId,
      slackChannelId: params.slackChannelId ?? "C-test",
      slackThreadTs: params.slackThreadTs ?? uniqueId("ts"),
      ...(params.agentSessionId && { agentSessionId: params.agentSessionId }),
    })
    .returning({ id: slackOrgThreadSessions.id });
  return row!;
}
