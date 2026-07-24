import { randomUUID } from "node:crypto";

import {
  testCronMonitorChatMessageQueueStateContract,
  type TestCronMonitorChatMessageQueueStateActionBody,
} from "@vm0/api-contracts/contracts/test-cron-monitor-chat-message-queue-state";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatMessageQueue } from "@vm0/db/schema/chat-message-queue";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { command } from "ccstate";
import { eq } from "drizzle-orm";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  insertChatMessage,
  updateChatMessage,
} from "../services/zero-chat-message.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const actionBody$ = bodyResultOf(
  testCronMonitorChatMessageQueueStateContract.action,
);

type FixtureKind = Extract<
  TestCronMonitorChatMessageQueueStateActionBody,
  { readonly action: "seed-fixture" }
>["fixture_kind"];

function actionOk(extra: Record<string, unknown> = {}) {
  return {
    status: 200 as const,
    body: { ok: true as const, ...extra },
  };
}

async function seedActiveRun(
  db: Db,
  fixture: {
    readonly composeId: string;
    readonly orgId: string;
    readonly threadId: string;
    readonly userId: string;
  },
  signal: AbortSignal,
): Promise<void> {
  const [session] = await db
    .insert(agentSessions)
    .values({
      userId: fixture.userId,
      orgId: fixture.orgId,
      agentComposeId: fixture.composeId,
      artifacts: [],
    })
    .returning({ id: agentSessions.id });
  signal.throwIfAborted();
  if (!session) {
    throw new Error("Failed to seed orphan monitor session");
  }

  const [run] = await db
    .insert(agentRuns)
    .values({
      userId: fixture.userId,
      orgId: fixture.orgId,
      sessionId: session.id,
      status: "pending",
      prompt: "orphan monitor active run fixture",
    })
    .returning({ id: agentRuns.id });
  signal.throwIfAborted();
  if (!run) {
    throw new Error("Failed to seed orphan monitor run");
  }

  await db.insert(zeroRuns).values({
    id: run.id,
    triggerSource: "web",
    chatThreadId: fixture.threadId,
  });
  signal.throwIfAborted();
}

async function seedFixture(
  db: Db,
  fixtureKind: FixtureKind,
  signal: AbortSignal,
) {
  const userId = `orphan-monitor-user-${randomUUID()}`;
  const orgId = `orphan-monitor-org-${randomUUID()}`;
  const [compose] = await db
    .insert(agentComposes)
    .values({
      userId,
      orgId,
      name: `orphan-monitor-${randomUUID()}`,
    })
    .returning({ id: agentComposes.id });
  signal.throwIfAborted();
  if (!compose) {
    throw new Error("Failed to seed orphan monitor compose");
  }

  const [thread] = await db
    .insert(chatThreads)
    .values({ userId, agentComposeId: compose.id })
    .returning({ id: chatThreads.id });
  signal.throwIfAborted();
  if (!thread) {
    throw new Error("Failed to seed orphan monitor thread");
  }

  const message = await db.transaction(async (tx) => {
    return await insertChatMessage(tx, {
      chatThreadId: thread.id,
      role: "user",
      content: "orphan monitor fixture",
      runId: null,
      error: fixtureKind === "failed-message" ? "INSUFFICIENT_CREDITS" : null,
    });
  });
  signal.throwIfAborted();
  if (!message) {
    throw new Error("Failed to seed orphan monitor message");
  }

  if (fixtureKind === "queued-message") {
    await db.insert(chatMessageQueue).values({
      orgId,
      userId,
      chatThreadId: thread.id,
      itemType: "user_message",
      chatMessageId: message.id,
    });
  } else if (fixtureKind === "revoked-message") {
    await db.transaction(async (tx) => {
      await updateChatMessage(tx, message.id, {
        chatThreadId: thread.id,
        role: "user",
        content: "claimed orphan monitor fixture",
        runId: randomUUID(),
      });
    });
  } else if (fixtureKind === "active-run") {
    await seedActiveRun(
      db,
      { composeId: compose.id, orgId, threadId: thread.id, userId },
      signal,
    );
  }
  signal.throwIfAborted();

  return actionOk({ compose_id: compose.id });
}

const mutateTestCronMonitorChatMessageQueueState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    if (bodyResult.data.action === "seed-fixture") {
      return await seedFixture(db, bodyResult.data.fixture_kind, signal);
    }

    await db
      .delete(agentComposes)
      .where(eq(agentComposes.id, bodyResult.data.compose_id));
    signal.throwIfAborted();
    return actionOk();
  },
);

export const testCronMonitorChatMessageQueueStateRoutes: readonly RouteEntry[] =
  [
    {
      route: testCronMonitorChatMessageQueueStateContract.action,
      handler: mutateTestCronMonitorChatMessageQueueState$,
    },
  ];
