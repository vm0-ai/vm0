import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { eq } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";

export interface SlackConnectFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly slackWorkspaceId: string;
  readonly slackWorkspaceName: string;
}

interface SeedValues {
  readonly withConnection?: boolean;
  readonly slackWorkspaceName?: string;
}

export const seedSlackConnectOrg$ = command(
  async (
    { set },
    values: SeedValues,
    signal: AbortSignal,
  ): Promise<SlackConnectFixture> => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const slackWorkspaceId = `T_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const slackWorkspaceName = values.slackWorkspaceName ?? "Test Workspace";
    const writeDb = set(writeDb$);

    await writeDb.insert(slackOrgInstallations).values({
      slackWorkspaceId,
      slackWorkspaceName,
      orgId,
      encryptedBotToken: "encrypted-token",
      botUserId: "U_BOT_TEST",
    });
    signal.throwIfAborted();

    if (values.withConnection) {
      await writeDb.insert(slackOrgConnections).values({
        slackUserId: `U_USER_${randomUUID().slice(0, 8)}`,
        slackWorkspaceId,
        vm0UserId: userId,
      });
      signal.throwIfAborted();
    }

    return { orgId, userId, slackWorkspaceId, slackWorkspaceName };
  },
);

export const deleteSlackConnectOrg$ = command(
  async (
    { set },
    fixture: SlackConnectFixture,
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
