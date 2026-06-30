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
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq } from "drizzle-orm";

import { bodyResultOf, queryOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { slackOrgCallbackPayloadSchema } from "../services/slack-org-callback-payload";
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

async function sourceComputerUseHostId(
  db: Db,
  run: RunState,
): Promise<string | null> {
  if (run.triggerSource === "web" && run.chatThreadId) {
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

  return null;
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
    const composeId = randomUUID();
    const sessionId = randomUUID();
    const runId = randomUUID();
    const threadId = body.trigger_source === "web" ? randomUUID() : null;

    await db.insert(agentComposes).values({
      id: composeId,
      userId: body.user_id,
      orgId: body.org_id,
      name: `computer-use-auth-${composeId.slice(0, 8)}`,
    });
    signal.throwIfAborted();

    if (threadId) {
      await db.insert(chatThreads).values({
        id: threadId,
        userId: body.user_id,
        agentComposeId: composeId,
        title: "Computer Use authorization test",
      });
      signal.throwIfAborted();
    }

    await db.insert(agentSessions).values({
      id: sessionId,
      userId: body.user_id,
      orgId: body.org_id,
      agentComposeId: composeId,
    });
    signal.throwIfAborted();

    await db.insert(agentRuns).values({
      id: runId,
      userId: body.user_id,
      orgId: body.org_id,
      sessionId,
      status: "running",
      prompt: "Need Computer Use",
    });
    signal.throwIfAborted();

    await db.insert(zeroRuns).values({
      id: runId,
      triggerSource: body.trigger_source,
      chatThreadId: threadId,
    });
    signal.throwIfAborted();

    let slack: {
      readonly connection_id: string;
      readonly channel_id: string;
      readonly thread_ts: string;
    } | null = null;

    if (body.trigger_source === "slack") {
      const workspaceId = `T${randomUUID().replaceAll("-", "").slice(0, 10)}`;
      const slackUserId = `U${randomUUID().replaceAll("-", "").slice(0, 10)}`;
      const channelId = `C${randomUUID().replaceAll("-", "").slice(0, 10)}`;
      const threadTs = "1710000000.000100";
      const connectionId = randomUUID();

      await db.insert(slackOrgInstallations).values({
        slackWorkspaceId: workspaceId,
        slackWorkspaceName: "Computer Use Auth Workspace",
        orgId: body.org_id,
        encryptedBotToken: "encrypted-bot-token",
        botUserId: "U_BOT_TEST",
      });
      signal.throwIfAborted();
      await db.insert(slackOrgConnections).values({
        id: connectionId,
        slackWorkspaceId: workspaceId,
        slackUserId,
        vm0UserId: body.user_id,
      });
      signal.throwIfAborted();
      await db.insert(agentRunCallbacks).values({
        runId,
        internalKind: "slack:org",
        encryptedSecret: "encrypted-callback-secret",
        payload: {
          workspaceId,
          channelId,
          threadTs,
          messageTs: threadTs,
          connectionId,
          agentId: composeId,
        },
      });
      signal.throwIfAborted();

      slack = {
        connection_id: connectionId,
        channel_id: channelId,
        thread_ts: threadTs,
      };
    }

    return {
      status: 200 as const,
      body: {
        ok: true as const,
        compose_id: composeId,
        run_id: runId,
        session_id: sessionId,
        thread_id: threadId,
        slack,
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
          run.triggerSource === "web" || run.triggerSource === "slack"
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
