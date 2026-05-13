import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { conversations } from "@vm0/db/schema/conversation";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { slackOrgThreadSessions } from "@vm0/db/schema/slack-org-thread-session";
import { slackUserAgentPreferences } from "@vm0/db/schema/slack-user-agent-preference";
import { userCache } from "@vm0/db/schema/user-cache";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq, inArray } from "drizzle-orm";

import { writeDb$, type Db } from "../../../external/db";
import { nowDate } from "../../../external/time";
import { encryptSecretForTests } from "./encrypt-secret";

export interface SlackWebhookFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly slackWorkspaceId: string;
  readonly slackUserId: string;
  readonly defaultAgentId: string | null;
  readonly switchAgentId: string | null;
}

interface SeedSlackWebhookFixtureArgs {
  readonly withConnection?: boolean;
  readonly withDefaultAgent?: boolean;
  readonly withSwitchAgent?: boolean;
  readonly orgId?: string;
  readonly userId?: string;
  readonly slackWorkspaceId?: string;
  readonly slackUserId?: string;
  readonly installationOrgId?: string | null;
}

async function seedRunnableAgent(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly namePrefix: string;
}): Promise<string> {
  const name = `${args.namePrefix}-${randomUUID().slice(0, 8)}`;
  const [compose] = await args.db
    .insert(agentComposes)
    .values({
      userId: args.userId,
      orgId: args.orgId,
      name,
    })
    .returning({ id: agentComposes.id });
  if (!compose) {
    throw new Error("seedRunnableAgent insert returned no compose");
  }

  const versionId = randomUUID();
  await args.db.insert(agentComposeVersions).values({
    id: versionId,
    composeId: compose.id,
    createdBy: args.userId,
    content: {
      version: "1.0",
      agents: {
        [name]: {
          framework: "claude-code",
          environment: { ANTHROPIC_API_KEY: "test-key" },
        },
      },
    },
  });
  await args.db
    .update(agentComposes)
    .set({ headVersionId: versionId })
    .where(eq(agentComposes.id, compose.id));

  await args.db.insert(zeroAgents).values({
    id: compose.id,
    orgId: args.orgId,
    owner: args.userId,
    name,
    displayName: name,
    visibility: "public",
    customSkills: [],
  });

  return compose.id;
}

export const seedSlackWebhookFixture$ = command(
  async (
    { set },
    args: SeedSlackWebhookFixtureArgs,
    signal: AbortSignal,
  ): Promise<SlackWebhookFixture> => {
    const db = set(writeDb$);
    const orgId = args.orgId ?? `org_${randomUUID()}`;
    const userId = args.userId ?? `user_${randomUUID()}`;
    const slackWorkspaceId =
      args.slackWorkspaceId ??
      `T_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const slackUserId =
      args.slackUserId ?? `U_USER_${randomUUID().slice(0, 8)}`;
    const installationOrgId =
      args.installationOrgId === undefined ? orgId : args.installationOrgId;

    await db.insert(userCache).values({
      userId,
      email: `${userId}@example.com`,
      name: "Slack Test User",
    });
    signal.throwIfAborted();

    const defaultAgentId = args.withDefaultAgent
      ? await seedRunnableAgent({
          db,
          orgId,
          userId,
          namePrefix: "default-agent",
        })
      : null;
    signal.throwIfAborted();

    const switchAgentId = args.withSwitchAgent
      ? await seedRunnableAgent({
          db,
          orgId,
          userId,
          namePrefix: "switch-agent",
        })
      : null;
    signal.throwIfAborted();

    await db.insert(orgMetadata).values({
      orgId,
      defaultAgentId,
      credits: 100_000,
    });
    signal.throwIfAborted();
    await db.insert(orgMembersMetadata).values({
      orgId,
      userId,
      timezone: "UTC",
    });
    signal.throwIfAborted();

    await db.insert(slackOrgInstallations).values({
      slackWorkspaceId,
      slackWorkspaceName: "Test Workspace",
      orgId: installationOrgId,
      encryptedBotToken: encryptSecretForTests("xoxb-test-bot-token"),
      botUserId: "U_BOT_TEST",
    });
    signal.throwIfAborted();

    if (args.withConnection) {
      await db.insert(slackOrgConnections).values({
        slackUserId,
        slackWorkspaceId,
        vm0UserId: userId,
      });
      signal.throwIfAborted();
    }

    return {
      orgId,
      userId,
      slackWorkspaceId,
      slackUserId,
      defaultAgentId,
      switchAgentId,
    };
  },
);

export const countSlackWebhookConnections$ = command(
  async (
    { set },
    slackWorkspaceId: string,
    signal: AbortSignal,
  ): Promise<number> => {
    const db = set(writeDb$);
    const rows = await db
      .select({ id: slackOrgConnections.id })
      .from(slackOrgConnections)
      .where(eq(slackOrgConnections.slackWorkspaceId, slackWorkspaceId));
    signal.throwIfAborted();
    return rows.length;
  },
);

export const findSlackAgentPreference$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<string | null | undefined> => {
    const db = set(writeDb$);
    const [row] = await db
      .select({
        selectedComposeId: slackUserAgentPreferences.selectedComposeId,
      })
      .from(slackUserAgentPreferences)
      .where(
        and(
          eq(slackUserAgentPreferences.orgId, args.orgId),
          eq(slackUserAgentPreferences.vm0UserId, args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return row?.selectedComposeId;
  },
);

export const findUserSelectedModel$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<string | null | undefined> => {
    const db = set(writeDb$);
    const [row] = await db
      .select({ selectedModel: orgMembersMetadata.selectedModel })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, args.orgId),
          eq(orgMembersMetadata.userId, args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return row?.selectedModel;
  },
);

export const setSlackWebhookUserSelectedModel$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly selectedModel: string | null;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await db
      .update(orgMembersMetadata)
      .set({ selectedModel: args.selectedModel })
      .where(
        and(
          eq(orgMembersMetadata.orgId, args.orgId),
          eq(orgMembersMetadata.userId, args.userId),
        ),
      );
    signal.throwIfAborted();
  },
);

export const seedSlackThreadSession$ = command(
  async (
    { set },
    args: {
      readonly fixture: SlackWebhookFixture;
      readonly channelId: string;
      readonly threadTs: string;
      readonly selectedModel: string;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const db = set(writeDb$);
    if (!args.fixture.defaultAgentId) {
      throw new Error("fixture default agent is required");
    }

    const [connection] = await db
      .select({ id: slackOrgConnections.id })
      .from(slackOrgConnections)
      .where(
        and(
          eq(
            slackOrgConnections.slackWorkspaceId,
            args.fixture.slackWorkspaceId,
          ),
          eq(slackOrgConnections.slackUserId, args.fixture.slackUserId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!connection) {
      throw new Error("fixture Slack connection is required");
    }

    const [session] = await db
      .insert(agentSessions)
      .values({
        userId: args.fixture.userId,
        orgId: args.fixture.orgId,
        agentComposeId: args.fixture.defaultAgentId,
      })
      .returning({ id: agentSessions.id });
    signal.throwIfAborted();
    if (!session) {
      throw new Error("Slack session insert returned no row");
    }

    const [run] = await db
      .insert(agentRuns)
      .values({
        userId: args.fixture.userId,
        orgId: args.fixture.orgId,
        sessionId: session.id,
        status: "completed",
        prompt: "previous Slack session",
        completedAt: nowDate(),
      })
      .returning({ id: agentRuns.id });
    signal.throwIfAborted();
    if (!run) {
      throw new Error("Slack run insert returned no row");
    }

    await db.insert(zeroRuns).values({
      id: run.id,
      triggerSource: "slack",
      modelProvider: "vm0",
      selectedModel: args.selectedModel,
    });
    signal.throwIfAborted();

    const [conversation] = await db
      .insert(conversations)
      .values({
        runId: run.id,
        cliAgentType: "claude-code",
        cliAgentSessionId: `slack-test-${randomUUID()}`,
        cliAgentSessionHistory: "[]",
      })
      .returning({ id: conversations.id });
    signal.throwIfAborted();
    if (!conversation) {
      throw new Error("Slack conversation insert returned no row");
    }

    await db
      .update(agentSessions)
      .set({ conversationId: conversation.id })
      .where(eq(agentSessions.id, session.id));
    signal.throwIfAborted();

    await db.insert(slackOrgThreadSessions).values({
      connectionId: connection.id,
      slackChannelId: args.channelId,
      slackThreadTs: args.threadTs,
      agentSessionId: session.id,
    });
    signal.throwIfAborted();

    return session.id;
  },
);

export const deleteSlackWebhookFixture$ = command(
  async (
    { set },
    fixture: SlackWebhookFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const runRows = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, fixture.orgId),
          eq(agentRuns.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();

    const runIds = runRows.map((row) => {
      return row.id;
    });
    if (runIds.length > 0) {
      await db
        .delete(runnerJobQueue)
        .where(inArray(runnerJobQueue.runId, runIds));
      signal.throwIfAborted();
      await db
        .delete(agentRunQueue)
        .where(inArray(agentRunQueue.runId, runIds));
      signal.throwIfAborted();
      await db.delete(zeroRuns).where(inArray(zeroRuns.id, runIds));
      signal.throwIfAborted();
      await db.delete(agentRuns).where(inArray(agentRuns.id, runIds));
      signal.throwIfAborted();
    }

    await db
      .delete(slackUserAgentPreferences)
      .where(eq(slackUserAgentPreferences.orgId, fixture.orgId));
    signal.throwIfAborted();
    await db
      .delete(slackOrgConnections)
      .where(
        eq(slackOrgConnections.slackWorkspaceId, fixture.slackWorkspaceId),
      );
    signal.throwIfAborted();
    await db
      .delete(slackOrgInstallations)
      .where(
        eq(slackOrgInstallations.slackWorkspaceId, fixture.slackWorkspaceId),
      );
    signal.throwIfAborted();

    await db
      .delete(agentSessions)
      .where(
        and(
          eq(agentSessions.orgId, fixture.orgId),
          eq(agentSessions.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
    await db.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
    signal.throwIfAborted();
    await db
      .delete(orgMembersMetadata)
      .where(eq(orgMembersMetadata.orgId, fixture.orgId));
    signal.throwIfAborted();

    const composeRows = await db
      .select({ id: agentComposes.id })
      .from(agentComposes)
      .where(eq(agentComposes.orgId, fixture.orgId));
    signal.throwIfAborted();
    const composeIds = composeRows.map((row) => {
      return row.id;
    });
    if (composeIds.length > 0) {
      await db
        .delete(agentComposeVersions)
        .where(inArray(agentComposeVersions.composeId, composeIds));
      signal.throwIfAborted();
      await db.delete(zeroAgents).where(inArray(zeroAgents.id, composeIds));
      signal.throwIfAborted();
      await db
        .delete(agentComposes)
        .where(inArray(agentComposes.id, composeIds));
      signal.throwIfAborted();
    }

    await db.delete(userCache).where(eq(userCache.userId, fixture.userId));
    signal.throwIfAborted();
  },
);
