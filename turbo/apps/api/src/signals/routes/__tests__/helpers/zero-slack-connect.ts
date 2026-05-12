import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { and, eq } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";
import { encryptSecretForTests } from "./encrypt-secret";

export interface SlackConnectFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly slackWorkspaceId: string;
  readonly slackWorkspaceName: string;
  readonly slackUserId: string;
}

interface SeedValues {
  readonly withConnection?: boolean;
  readonly slackWorkspaceName?: string;
  readonly orgId?: string;
  readonly userId?: string;
  readonly slackWorkspaceId?: string;
  readonly slackUserId?: string;
  readonly installationOrgId?: string | null;
}

export const seedSlackConnectOrg$ = command(
  async (
    { set },
    values: SeedValues,
    signal: AbortSignal,
  ): Promise<SlackConnectFixture> => {
    const orgId = values.orgId ?? `org_${randomUUID()}`;
    const userId = values.userId ?? `user_${randomUUID()}`;
    const slackWorkspaceId =
      values.slackWorkspaceId ??
      `T_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const slackWorkspaceName = values.slackWorkspaceName ?? "Test Workspace";
    const slackUserId =
      values.slackUserId ?? `U_USER_${randomUUID().slice(0, 8)}`;
    const installationOrgId =
      values.installationOrgId === undefined ? orgId : values.installationOrgId;
    const writeDb = set(writeDb$);

    await writeDb.insert(slackOrgInstallations).values({
      slackWorkspaceId,
      slackWorkspaceName,
      orgId: installationOrgId,
      encryptedBotToken: encryptSecretForTests("xoxb-test-bot-token"),
      botUserId: "U_BOT_TEST",
    });
    signal.throwIfAborted();

    if (values.withConnection) {
      await writeDb.insert(slackOrgConnections).values({
        slackUserId,
        slackWorkspaceId,
        vm0UserId: userId,
      });
      signal.throwIfAborted();
    }

    return { orgId, userId, slackWorkspaceId, slackWorkspaceName, slackUserId };
  },
);

export const findSlackOrgConnection$ = command(
  async (
    { set },
    values: {
      readonly slackWorkspaceId: string;
      readonly slackUserId: string;
    },
    signal: AbortSignal,
  ): Promise<typeof slackOrgConnections.$inferSelect | undefined> => {
    const writeDb = set(writeDb$);
    const [connection] = await writeDb
      .select()
      .from(slackOrgConnections)
      .where(
        and(
          eq(slackOrgConnections.slackWorkspaceId, values.slackWorkspaceId),
          eq(slackOrgConnections.slackUserId, values.slackUserId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return connection;
  },
);

export const findSlackOrgInstallation$ = command(
  async (
    { set },
    slackWorkspaceId: string,
    signal: AbortSignal,
  ): Promise<typeof slackOrgInstallations.$inferSelect | undefined> => {
    const writeDb = set(writeDb$);
    const [installation] = await writeDb
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.slackWorkspaceId, slackWorkspaceId))
      .limit(1);
    signal.throwIfAborted();
    return installation;
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
