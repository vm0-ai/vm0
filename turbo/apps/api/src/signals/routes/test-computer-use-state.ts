import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { testComputerUseStateContract } from "@vm0/api-contracts/contracts/test-computer-use-state";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { eq } from "drizzle-orm";

import { bodyResultOf, queryOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const postBody$ = bodyResultOf(testComputerUseStateContract.post);
const getQuery$ = queryOf(testComputerUseStateContract.get);
const deleteQuery$ = queryOf(testComputerUseStateContract.delete);

interface RunState {
  readonly id: string;
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

type ComputerUseTriggerSource = "web" | "slack" | "teams";

async function loadRunState(db: Db, runId: string): Promise<RunState | null> {
  const [run] = await db
    .select({
      id: agentRuns.id,
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

async function sourceComputerUseHostId(
  db: Db,
  run: RunState,
): Promise<string | null> {
  if (!run.chatThreadId) {
    return null;
  }

  const [thread] = await db
    .select({ computerUseHostId: chatThreads.computerUseHostId })
    .from(chatThreads)
    .where(eq(chatThreads.id, run.chatThreadId))
    .limit(1);
  return thread?.computerUseHostId ?? null;
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
    if (body.trigger_source === "slack" && body.canonical_thread !== true) {
      return {
        status: 400 as const,
        body: { error: "Slack test runs require canonical_thread" },
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
    return {
      status: 200 as const,
      body: {
        ok: true as const,
        compose_id: seed.composeId,
        run_id: seed.runId,
        session_id: seed.sessionId,
        thread_id: seed.threadId,
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
