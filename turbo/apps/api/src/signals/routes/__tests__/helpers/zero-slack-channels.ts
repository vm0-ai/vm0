import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { eq } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";
import { encryptSecretForTests } from "./encrypt-secret";

export interface SlackInstallationFixture {
  readonly orgId: string;
  readonly slackWorkspaceId: string;
}

interface SeedSlackInstallationValues {
  readonly orgId?: string;
  readonly botToken?: string;
  readonly workspaceName?: string;
}

function randomSlackId(prefix: string): string {
  return `${prefix}${randomUUID().replaceAll("-", "").slice(0, 9).toUpperCase()}`;
}

export const seedSlackInstallation$ = command(
  async (
    { set },
    values: SeedSlackInstallationValues,
    signal: AbortSignal,
  ): Promise<SlackInstallationFixture> => {
    const orgId = values.orgId ?? `org_${randomUUID()}`;
    const slackWorkspaceId = randomSlackId("T");
    const writeDb = set(writeDb$);

    await writeDb.insert(slackOrgInstallations).values({
      slackWorkspaceId,
      slackWorkspaceName: values.workspaceName ?? "Test Workspace",
      orgId,
      encryptedBotToken: encryptSecretForTests(
        values.botToken ?? "xoxb-test-token",
      ),
      botUserId: randomSlackId("U"),
    });
    signal.throwIfAborted();

    return { orgId, slackWorkspaceId };
  },
);

export const deleteSlackInstallation$ = command(
  async (
    { set },
    fixture: SlackInstallationFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .delete(slackOrgInstallations)
      .where(
        eq(slackOrgInstallations.slackWorkspaceId, fixture.slackWorkspaceId),
      );
    signal.throwIfAborted();
  },
);
