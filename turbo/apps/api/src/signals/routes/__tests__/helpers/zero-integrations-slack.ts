import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { eq } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";
import { encryptSecretForTests } from "./encrypt-secret";

export interface SlackIntegrationFixture {
  readonly orgId: string;
  readonly slackWorkspaceId: string;
}

interface SeedSlackInstallationValues {
  readonly orgId: string;
  readonly slackWorkspaceId?: string;
  readonly slackWorkspaceName?: string;
  readonly botScopes?: string | null;
  readonly botToken?: string;
}

interface SeedSlackConnectionValues {
  readonly slackWorkspaceId: string;
  readonly vm0UserId: string;
  readonly slackUserId?: string;
}

function randomSlackId(prefix: string): string {
  return `${prefix}${randomUUID().replaceAll("-", "").slice(0, 9).toUpperCase()}`;
}

export const seedSlackOrgInstallation$ = command(
  async (
    { set },
    values: SeedSlackInstallationValues,
    signal: AbortSignal,
  ): Promise<SlackIntegrationFixture> => {
    const writeDb = set(writeDb$);
    const slackWorkspaceId = values.slackWorkspaceId ?? randomSlackId("T");

    await writeDb.insert(slackOrgInstallations).values({
      slackWorkspaceId,
      slackWorkspaceName: values.slackWorkspaceName ?? "Test Org Workspace",
      orgId: values.orgId,
      encryptedBotToken: encryptSecretForTests(
        values.botToken ?? "xoxb-test-token",
      ),
      botUserId: randomSlackId("U"),
      botScopes: values.botScopes ?? null,
    });
    signal.throwIfAborted();

    return { orgId: values.orgId, slackWorkspaceId };
  },
);

export const seedSlackOrgConnection$ = command(
  async (
    { set },
    values: SeedSlackConnectionValues,
    signal: AbortSignal,
  ): Promise<{ readonly slackUserId: string }> => {
    const writeDb = set(writeDb$);
    const slackUserId = values.slackUserId ?? randomSlackId("U");

    await writeDb.insert(slackOrgConnections).values({
      slackUserId,
      slackWorkspaceId: values.slackWorkspaceId,
      vm0UserId: values.vm0UserId,
    });
    signal.throwIfAborted();

    return { slackUserId };
  },
);

export const seedSlackEnvironmentAgent$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    const composeId = randomUUID();
    const versionId = randomUUID().replaceAll("-", "");

    await writeDb.insert(agentComposes).values({
      id: composeId,
      userId: args.userId,
      orgId: args.orgId,
      name: `agent-${composeId.slice(0, 8)}`,
      headVersionId: versionId,
    });
    signal.throwIfAborted();
    await writeDb.insert(agentComposeVersions).values({
      id: versionId,
      composeId,
      content: {},
      createdBy: args.userId,
    });
    signal.throwIfAborted();
    await writeDb
      .insert(orgMetadata)
      .values({
        orgId: args.orgId,
        defaultAgentId: composeId,
        tier: "free",
        credits: 10_000,
      })
      .onConflictDoUpdate({
        target: orgMetadata.orgId,
        set: { defaultAgentId: composeId, tier: "free", credits: 10_000 },
      });
    signal.throwIfAborted();
  },
);

export const deleteSlackIntegrationFixture$ = command(
  async (
    { set },
    fixture: SlackIntegrationFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .delete(slackOrgConnections)
      .where(
        eq(slackOrgConnections.slackWorkspaceId, fixture.slackWorkspaceId),
      );
    signal.throwIfAborted();
    await writeDb
      .delete(slackOrgInstallations)
      .where(
        eq(slackOrgInstallations.slackWorkspaceId, fixture.slackWorkspaceId),
      );
    signal.throwIfAborted();
  },
);
