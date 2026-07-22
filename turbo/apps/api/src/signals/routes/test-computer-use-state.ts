import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { testComputerUseStateContract } from "@vm0/api-contracts/contracts/test-computer-use-state";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { slackOrgThreadSessions } from "@vm0/db/schema/slack-org-thread-session";
import { teamsOrgConnections } from "@vm0/db/schema/teams-org-connection";
import { teamsOrgInstallations } from "@vm0/db/schema/teams-org-installation";
import { teamsOrgThreadSessions } from "@vm0/db/schema/teams-org-thread-session";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq } from "drizzle-orm";

import { bodyResultOf, queryOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { slackOrgCallbackPayloadSchema } from "../services/slack-org-callback-payload";
import { teamsOrgCallbackPayloadSchema } from "../services/teams-org-callback-payload";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const postBody$ = bodyResultOf(testComputerUseStateContract.post);
const getQuery$ = queryOf(testComputerUseStateContract.get);
const deleteQuery$ = queryOf(testComputerUseStateContract.delete);

interface RunState {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly agentComposeId: string;
  readonly triggerSource: string | null;
  readonly chatThreadId: string | null;
}

interface BaseComputerUseRunSeed {
  readonly composeId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly threadId: string | null;
}

interface SlackComputerUseSeed {
  readonly connection_id: string;
  readonly channel_id: string;
  readonly thread_ts: string;
}

interface TeamsComputerUseSeed {
  readonly connection_id: string;
  readonly conversation_id: string;
  readonly thread_id: string;
}

type ComputerUseTriggerSource = "web" | "slack" | "teams";

async function loadRunState(db: Db, runId: string): Promise<RunState | null> {
  const [run] = await db
    .select({
      id: agentRuns.id,
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      sessionId: agentRuns.sessionId,
      agentComposeId: agentSessions.agentComposeId,
      triggerSource: zeroRuns.triggerSource,
      chatThreadId: zeroRuns.chatThreadId,
    })
    .from(agentRuns)
    .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
    .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return run ?? null;
}

async function slackCallbackPayload(db: Db, runId: string) {
  const [callback] = await db
    .select({ payload: agentRunCallbacks.payload })
    .from(agentRunCallbacks)
    .where(
      and(
        eq(agentRunCallbacks.runId, runId),
        eq(agentRunCallbacks.internalKind, "slack:org"),
      ),
    )
    .limit(1);
  const parsed = slackOrgCallbackPayloadSchema.safeParse(callback?.payload);
  return parsed.success ? parsed.data : null;
}

async function teamsCallbackPayload(db: Db, runId: string) {
  const [callback] = await db
    .select({ payload: agentRunCallbacks.payload })
    .from(agentRunCallbacks)
    .where(
      and(
        eq(agentRunCallbacks.runId, runId),
        eq(agentRunCallbacks.internalKind, "teams:org"),
      ),
    )
    .limit(1);
  const parsed = teamsOrgCallbackPayloadSchema.safeParse(callback?.payload);
  return parsed.success ? parsed.data : null;
}

async function sourceComputerUseHostId(
  db: Db,
  run: RunState,
): Promise<string | null> {
  if (run.chatThreadId) {
    const [thread] = await db
      .select({ computerUseHostId: chatThreads.computerUseHostId })
      .from(chatThreads)
      .where(eq(chatThreads.id, run.chatThreadId))
      .limit(1);
    return thread?.computerUseHostId ?? null;
  }

  if (run.triggerSource === "slack") {
    const payload = await slackCallbackPayload(db, run.id);
    if (!payload) {
      return null;
    }
    const [session] = await db
      .select({ computerUseHostId: slackOrgThreadSessions.computerUseHostId })
      .from(slackOrgThreadSessions)
      .where(
        and(
          eq(slackOrgThreadSessions.connectionId, payload.connectionId),
          eq(slackOrgThreadSessions.slackChannelId, payload.channelId),
          eq(slackOrgThreadSessions.slackThreadTs, payload.threadTs),
        ),
      )
      .limit(1);
    return session?.computerUseHostId ?? null;
  }

  if (run.triggerSource === "teams") {
    const payload = await teamsCallbackPayload(db, run.id);
    if (!payload) {
      return null;
    }
    const [session] = await db
      .select({ computerUseHostId: teamsOrgThreadSessions.computerUseHostId })
      .from(teamsOrgThreadSessions)
      .where(
        and(
          eq(teamsOrgThreadSessions.connectionId, payload.connectionId),
          eq(
            teamsOrgThreadSessions.teamsConversationId,
            payload.conversationId,
          ),
          eq(teamsOrgThreadSessions.teamsThreadId, payload.threadId),
        ),
      )
      .limit(1);
    return session?.computerUseHostId ?? null;
  }

  return null;
}

async function seedBaseComputerUseRun(args: {
  readonly db: Db;
  readonly userId: string;
  readonly orgId: string;
  readonly triggerSource: ComputerUseTriggerSource;
  readonly canonicalThread: boolean;
  readonly signal: AbortSignal;
}): Promise<BaseComputerUseRunSeed> {
  const composeId = randomUUID();
  const sessionId = randomUUID();
  const runId = randomUUID();
  const threadId =
    args.triggerSource === "web" || args.canonicalThread ? randomUUID() : null;

  await args.db.insert(agentComposes).values({
    id: composeId,
    userId: args.userId,
    orgId: args.orgId,
    name: `computer-use-auth-${composeId.slice(0, 8)}`,
  });
  args.signal.throwIfAborted();

  if (threadId) {
    await args.db.insert(chatThreads).values({
      id: threadId,
      userId: args.userId,
      agentComposeId: composeId,
      title: "Computer Use authorization test",
    });
    args.signal.throwIfAborted();
  }

  await args.db.insert(agentSessions).values({
    id: sessionId,
    userId: args.userId,
    orgId: args.orgId,
    agentComposeId: composeId,
  });
  args.signal.throwIfAborted();

  await args.db.insert(agentRuns).values({
    id: runId,
    userId: args.userId,
    orgId: args.orgId,
    sessionId,
    status: "running",
    prompt: "Need Computer Use",
  });
  args.signal.throwIfAborted();

  await args.db.insert(zeroRuns).values({
    id: runId,
    triggerSource: args.triggerSource,
    chatThreadId: threadId,
  });
  args.signal.throwIfAborted();

  return { composeId, sessionId, runId, threadId };
}

async function seedSlackComputerUseCallback(args: {
  readonly db: Db;
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
  readonly composeId: string;
  readonly signal: AbortSignal;
}): Promise<SlackComputerUseSeed> {
  const workspaceId = `T${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const slackUserId = `U${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const channelId = `C${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const threadTs = "1710000000.000100";
  const connectionId = randomUUID();

  await args.db.insert(slackOrgInstallations).values({
    slackWorkspaceId: workspaceId,
    slackWorkspaceName: "Computer Use Auth Workspace",
    orgId: args.orgId,
    encryptedBotToken: "encrypted-bot-token",
    botUserId: "U_BOT_TEST",
  });
  args.signal.throwIfAborted();

  await args.db.insert(slackOrgConnections).values({
    id: connectionId,
    slackWorkspaceId: workspaceId,
    slackUserId,
    vm0UserId: args.userId,
  });
  args.signal.throwIfAborted();

  await args.db.insert(agentRunCallbacks).values({
    runId: args.runId,
    internalKind: "slack:org",
    encryptedSecret: "encrypted-callback-secret",
    payload: {
      workspaceId,
      channelId,
      threadTs,
      messageTs: threadTs,
      connectionId,
      agentId: args.composeId,
    },
  });
  args.signal.throwIfAborted();

  return {
    connection_id: connectionId,
    channel_id: channelId,
    thread_ts: threadTs,
  };
}

async function seedTeamsComputerUseCallback(args: {
  readonly db: Db;
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
  readonly composeId: string;
  readonly signal: AbortSignal;
}): Promise<TeamsComputerUseSeed> {
  const tenantId = `tenant-${randomUUID()}`;
  const conversationId = `19:${randomUUID()}@thread.tacv2`;
  const threadId = `root-${randomUUID()}`;
  const connectionId = randomUUID();
  const teamsUserId = `29:${randomUUID()}`;

  await args.db.insert(teamsOrgInstallations).values({
    teamsTenantId: tenantId,
    teamsTenantName: "Computer Use Auth Tenant",
    orgId: args.orgId,
    botId: "28:bot-test",
    botName: "Zero",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
  });
  args.signal.throwIfAborted();

  await args.db.insert(teamsOrgConnections).values({
    id: connectionId,
    teamsTenantId: tenantId,
    teamsUserId,
    vm0UserId: args.userId,
  });
  args.signal.throwIfAborted();

  await args.db.insert(agentRunCallbacks).values({
    runId: args.runId,
    internalKind: "teams:org",
    encryptedSecret: "encrypted-callback-secret",
    payload: {
      tenantId,
      tenantName: "Computer Use Auth Tenant",
      teamId: null,
      teamName: null,
      channelId: null,
      conversationId,
      conversationType: "personal",
      threadId,
      activityId: threadId,
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      connectionId,
      teamsUserId,
      teamsUserDisplayName: "Computer Use Tester",
      teamsUserPrincipalName: "tester@example.com",
      botId: "28:bot-test",
      botName: "Zero",
      agentId: args.composeId,
      existingSessionId: null,
    },
  });
  args.signal.throwIfAborted();

  return {
    connection_id: connectionId,
    conversation_id: conversationId,
    thread_id: threadId,
  };
}

const postComputerUseState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(postBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const body = bodyResult.data;
    if (!body.user_id || !body.org_id || !body.trigger_source) {
      return {
        status: 400 as const,
        body: { error: "user_id, org_id, and trigger_source are required" },
      };
    }

    const db = set(writeDb$);
    const seed = await seedBaseComputerUseRun({
      db,
      userId: body.user_id,
      orgId: body.org_id,
      triggerSource: body.trigger_source,
      canonicalThread: body.canonical_thread === true,
      signal,
    });
    const slack =
      body.trigger_source === "slack"
        ? await seedSlackComputerUseCallback({
            db,
            userId: body.user_id,
            orgId: body.org_id,
            runId: seed.runId,
            composeId: seed.composeId,
            signal,
          })
        : null;
    const teams =
      body.trigger_source === "teams"
        ? await seedTeamsComputerUseCallback({
            db,
            userId: body.user_id,
            orgId: body.org_id,
            runId: seed.runId,
            composeId: seed.composeId,
            signal,
          })
        : null;

    return {
      status: 200 as const,
      body: {
        ok: true as const,
        compose_id: seed.composeId,
        run_id: seed.runId,
        session_id: seed.sessionId,
        thread_id: seed.threadId,
        slack,
        teams,
      },
    };
  },
);

const getComputerUseState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const query = get(getQuery$);
    const runId = query.run_id;
    if (!runId) {
      return {
        status: 400 as const,
        body: { error: "run_id query param is required" },
      };
    }

    const db = set(writeDb$);
    const run = await loadRunState(db, runId);
    signal.throwIfAborted();
    if (!run) {
      return {
        status: 200 as const,
        body: { source: null, computer_use_host_id: null },
      };
    }

    return {
      status: 200 as const,
      body: {
        source:
          run.triggerSource === "web" ||
          run.triggerSource === "slack" ||
          run.triggerSource === "teams"
            ? run.triggerSource
            : null,
        computer_use_host_id: await sourceComputerUseHostId(db, run),
      },
    };
  },
);

const deleteComputerUseState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const query = get(deleteQuery$);
    const runId = query.run_id;
    if (!runId) {
      return {
        status: 400 as const,
        body: { error: "run_id query param is required" },
      };
    }

    const db = set(writeDb$);
    const run = await loadRunState(db, runId);
    signal.throwIfAborted();
    if (!run) {
      return { status: 200 as const, body: { ok: true as const } };
    }

    const slackPayload = await slackCallbackPayload(db, run.id);
    signal.throwIfAborted();
    if (slackPayload) {
      await db
        .delete(slackOrgThreadSessions)
        .where(
          eq(slackOrgThreadSessions.connectionId, slackPayload.connectionId),
        );
      signal.throwIfAborted();
      await db
        .delete(slackOrgConnections)
        .where(eq(slackOrgConnections.id, slackPayload.connectionId));
      signal.throwIfAborted();
      await db
        .delete(slackOrgInstallations)
        .where(
          eq(slackOrgInstallations.slackWorkspaceId, slackPayload.workspaceId),
        );
      signal.throwIfAborted();
    }

    const teamsPayload = await teamsCallbackPayload(db, run.id);
    signal.throwIfAborted();
    if (teamsPayload) {
      await db
        .delete(teamsOrgThreadSessions)
        .where(
          eq(teamsOrgThreadSessions.connectionId, teamsPayload.connectionId),
        );
      signal.throwIfAborted();
      await db
        .delete(teamsOrgConnections)
        .where(eq(teamsOrgConnections.id, teamsPayload.connectionId));
      signal.throwIfAborted();
      await db
        .delete(teamsOrgInstallations)
        .where(eq(teamsOrgInstallations.teamsTenantId, teamsPayload.tenantId));
      signal.throwIfAborted();
    }

    await db
      .delete(agentRunCallbacks)
      .where(eq(agentRunCallbacks.runId, run.id));
    signal.throwIfAborted();
    await db.delete(zeroRuns).where(eq(zeroRuns.id, run.id));
    signal.throwIfAborted();
    await db.delete(agentRuns).where(eq(agentRuns.id, run.id));
    signal.throwIfAborted();
    await db.delete(agentSessions).where(eq(agentSessions.id, run.sessionId));
    signal.throwIfAborted();
    if (run.chatThreadId) {
      await db.delete(chatThreads).where(eq(chatThreads.id, run.chatThreadId));
      signal.throwIfAborted();
    }
    await db
      .delete(agentComposes)
      .where(eq(agentComposes.id, run.agentComposeId));
    signal.throwIfAborted();

    return { status: 200 as const, body: { ok: true as const } };
  },
);

export const testComputerUseStateRoutes: readonly RouteEntry[] = [
  {
    route: testComputerUseStateContract.post,
    handler: postComputerUseState$,
  },
  {
    route: testComputerUseStateContract.get,
    handler: getComputerUseState$,
  },
  {
    route: testComputerUseStateContract.delete,
    handler: deleteComputerUseState$,
  },
];
