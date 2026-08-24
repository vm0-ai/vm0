import { randomUUID } from "node:crypto";

import {
  testCronMonitorChatEventQueueStateContract,
  type TestCronMonitorChatEventQueueStateActionBody,
} from "@okouai/api-contracts/contracts/test-cron-monitor-chat-event-queue-state";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { threadGoals } from "@okouai/db/schema/thread-goal";
import { command } from "ccstate";
import { eq } from "drizzle-orm";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  insertChatEvent,
  replaceChatEvent,
} from "../services/chat-event.service";
import { normalizeRunMetadata } from "../services/agent-run-metadata-write.service";
import { createUserMessageDocument } from "../services/chat-user-message.service";
import { monitorChatEventQueueForEvents$ } from "../services/cron-monitor-chat-event-queue.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";
import type { Tx } from "../../lib/db-types";

const actionBody$ = bodyResultOf(
  testCronMonitorChatEventQueueStateContract.action,
);
const monitorBody$ = bodyResultOf(
  testCronMonitorChatEventQueueStateContract.monitor,
);

type FixtureKind = Extract<
  TestCronMonitorChatEventQueueStateActionBody,
  { readonly action: "seed-fixture" }
>["fixture_kind"];
type DbTransaction = Tx;

const STALE_CONTEXT_FIXTURES = [
  {
    contextType: "web",
    eventType: "input.prompt",
  },
  {
    contextType: "agent_run",
    eventType: "input.prompt",
  },
  {
    contextType: "slack",
    eventType: "input.prompt",
  },
  {
    contextType: "feishu",
    eventType: "input.prompt",
  },
  {
    contextType: "teams",
    eventType: "input.prompt",
  },
  {
    contextType: "telegram",
    eventType: "input.prompt",
  },
  {
    contextType: "github",
    eventType: "input.prompt",
  },
  {
    contextType: "agentphone",
    eventType: "input.prompt",
  },
  {
    contextType: "automation",
    eventType: "input.automation",
  },
  {
    contextType: "goal",
    eventType: "input.goal",
  },
  {
    contextType: "morning_brief",
    eventType: "input.prompt",
  },
] as const;

function actionOk(extra: Record<string, unknown> = {}) {
  return {
    status: 200 as const,
    body: { ok: true as const, ...extra },
  };
}

async function seedActiveRun(
  db: Db,
  fixture: {
    readonly agentId: string;
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
      agentId: fixture.agentId,
    })
    .returning({ id: agentSessions.id });
  signal.throwIfAborted();
  if (!session) {
    throw new Error("Failed to seed orphan monitor session");
  }

  const metadata = normalizeRunMetadata({
    triggerSource: "web",
    chatThreadId: fixture.threadId,
  });
  const [run] = await db
    .insert(agentRuns)
    .values({
      userId: fixture.userId,
      orgId: fixture.orgId,
      sessionId: session.id,
      status: "pending",
      prompt: "orphan monitor active run fixture",
      ...metadata,
    })
    .returning({ id: agentRuns.id });
  signal.throwIfAborted();
  if (!run) {
    throw new Error("Failed to seed orphan monitor run");
  }
}

async function seedGoalFixture(
  tx: DbTransaction,
  args: {
    readonly agentId: string;
    readonly fixtureKind: "orphaned-goal" | "paused-goal";
    readonly orgId: string;
    readonly threadId: string;
    readonly userId: string;
  },
) {
  const [goal] = await tx
    .insert(threadGoals)
    .values({
      orgId: args.orgId,
      ownerUserId: args.userId,
      agentId: args.agentId,
      chatThreadId: args.threadId,
      status: args.fixtureKind === "paused-goal" ? "paused" : "active",
      objective: "orphan monitor goal objective",
      objectiveBrief: "orphan monitor goal",
    })
    .returning({ id: threadGoals.id });
  if (!goal) {
    throw new Error("Failed to seed orphan monitor goal");
  }
  const goalInputEvent = await insertChatEvent(tx, {
    chatThreadId: args.threadId,
    contextType: "goal",
    eventType: "input.goal",
    runGroupId: goal.id,
    userMessage: createUserMessageDocument({
      text: null,
      nonContentPart: { type: "goal", goalBrief: "orphan monitor goal" },
    }),
    runId: null,
    createdAt: new Date(0),
  });
  if (args.fixtureKind === "orphaned-goal") {
    await tx.delete(threadGoals).where(eq(threadGoals.id, goal.id));
  }
  return goalInputEvent;
}

async function seedQueuedIntegrationEvent(tx: DbTransaction, threadId: string) {
  const userMessage = createUserMessageDocument({
    text: "orphan monitor fixture",
  });
  const [event] = await tx
    .insert(chatEvents)
    .values({
      chatThreadId: threadId,
      contextType: "slack",
      contextId: randomUUID(),
      eventType: "input.prompt",
      payload: { userMessage },
      runId: null,
      seqId: 1,
    })
    .returning({ id: chatEvents.id });
  if (!event) {
    throw new Error("Failed to seed queued integration event");
  }
  return event;
}

function requireSeededEventId(
  event: { readonly id: string } | null | undefined,
): string {
  if (!event) {
    throw new Error("Failed to seed orphan monitor message");
  }
  return event.id;
}

async function seedFixture(
  db: Db,
  fixtureKind: FixtureKind,
  signal: AbortSignal,
) {
  const userId = `orphan-monitor-user-${randomUUID()}`;
  const orgId = `orphan-monitor-org-${randomUUID()}`;
  const name = `orphan-monitor-${randomUUID()}`;
  const [agent] = await db
    .insert(agents)
    .values({
      id: randomUUID(),
      owner: userId,
      orgId,
      name,
    })
    .returning({ id: agents.id });
  signal.throwIfAborted();
  if (!agent) {
    throw new Error("Failed to seed orphan monitor Agent");
  }

  const [thread] = await db
    .insert(chatThreads)
    .values({ userId, agentId: agent.id })
    .returning({ id: chatThreads.id });
  signal.throwIfAborted();
  if (!thread) {
    throw new Error("Failed to seed orphan monitor thread");
  }

  const events = await db.transaction(async (tx) => {
    const userMessage = createUserMessageDocument({
      text: "orphan monitor fixture",
    });
    const baseEvent = {
      chatThreadId: thread.id,
      userMessage,
      runId: null,
    };
    if (fixtureKind === "orphan") {
      return await tx
        .insert(chatEvents)
        .values(
          STALE_CONTEXT_FIXTURES.map((fixture, index) => {
            return {
              chatThreadId: baseEvent.chatThreadId,
              payload: { userMessage: baseEvent.userMessage },
              runId: baseEvent.runId,
              ...fixture,
              contextId: fixture.contextType === null ? null : randomUUID(),
              createdAt: new Date(0),
              seqId: index + 1,
            };
          }),
        )
        .returning({ id: chatEvents.id });
    }
    if (fixtureKind === "orphaned-automation") {
      const automation = await insertChatEvent(tx, {
        ...baseEvent,
        eventType: "input.automation",
        createdAt: new Date(0),
        automationId: randomUUID(),
        triggerBrief: null,
      });
      return [automation];
    }
    if (fixtureKind === "orphaned-goal" || fixtureKind === "paused-goal") {
      return [
        await seedGoalFixture(tx, {
          agentId: agent.id,
          fixtureKind,
          orgId,
          threadId: thread.id,
          userId,
        }),
      ];
    }
    if (fixtureKind === "queued-integration") {
      return [await seedQueuedIntegrationEvent(tx, thread.id)];
    }
    const event =
      fixtureKind === "failed-message"
        ? await insertChatEvent(tx, {
            ...baseEvent,
            eventType: "input.rejected",
            error: "INSUFFICIENT_CREDITS",
          })
        : await insertChatEvent(tx, {
            ...baseEvent,
            contextType: "web",
            eventType: "input.prompt",
          });
    return [event];
  });
  signal.throwIfAborted();
  const event = events[0];
  if (!event) {
    throw new Error("Failed to seed orphan monitor message");
  }

  if (fixtureKind === "revoked-message") {
    await db.transaction(async (tx) => {
      await replaceChatEvent(tx, event.id, {
        chatThreadId: thread.id,
        eventType: "input.prompt",
        userMessage: createUserMessageDocument({
          text: "claimed orphan monitor fixture",
        }),
        runId: randomUUID(),
      });
    });
  } else if (fixtureKind === "active-run") {
    await seedActiveRun(
      db,
      { agentId: agent.id, orgId, threadId: thread.id, userId },
      signal,
    );
  }
  signal.throwIfAborted();

  return actionOk({
    compose_id: agent.id,
    event_id: event.id,
    event_ids: events.map(requireSeededEventId),
  });
}

const mutateTestCronMonitorChatEventQueueState$ = command(
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

    await db.delete(agents).where(eq(agents.id, bodyResult.data.compose_id));
    signal.throwIfAborted();
    return actionOk();
  },
);

const monitorTestCronMonitorChatEventQueueState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(monitorBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const body = await set(
      monitorChatEventQueueForEvents$,
      bodyResult.data.event_ids,
      signal,
    );
    signal.throwIfAborted();
    return { status: 200 as const, body };
  },
);

export const testCronMonitorChatEventQueueStateRoutes: readonly RouteEntry[] = [
  {
    route: testCronMonitorChatEventQueueStateContract.action,
    handler: mutateTestCronMonitorChatEventQueueState$,
  },
  {
    route: testCronMonitorChatEventQueueStateContract.monitor,
    handler: monitorTestCronMonitorChatEventQueueState$,
  },
];
