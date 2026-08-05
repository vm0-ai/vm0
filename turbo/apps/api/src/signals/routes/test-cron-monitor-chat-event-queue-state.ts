import { randomUUID } from "node:crypto";

import {
  testCronMonitorChatEventQueueStateContract,
  type TestCronMonitorChatEventQueueStateActionBody,
} from "@vm0/api-contracts/contracts/test-cron-monitor-chat-event-queue-state";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatEvents } from "@vm0/db/schema/chat-event";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { threadGoals } from "@vm0/db/schema/thread-goal";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { command } from "ccstate";
import { eq } from "drizzle-orm";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  insertChatEvent,
  replaceChatEvent,
} from "../services/zero-chat-event.service";
import { createUserMessageDocument } from "../services/zero-chat-user-message.service";
import { monitorChatEventQueueForEvents$ } from "../services/cron-monitor-chat-event-queue.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

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
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

const STALE_CONTEXT_FIXTURES = [
  {
    contextType: "web",
    eventType: "input.prompt",
    triggerSource: "web",
  },
  {
    contextType: "web",
    eventType: "input.prompt",
    triggerSource: "test",
  },
  {
    contextType: "agent_run",
    eventType: "input.prompt",
    triggerSource: "agent",
  },
  {
    contextType: "slack",
    eventType: "input.prompt",
    triggerSource: "slack",
  },
  {
    contextType: "feishu",
    eventType: "input.prompt",
    triggerSource: "feishu",
  },
  {
    contextType: "teams",
    eventType: "input.prompt",
    triggerSource: "teams",
  },
  {
    contextType: "telegram",
    eventType: "input.prompt",
    triggerSource: "telegram",
  },
  {
    contextType: "github",
    eventType: "input.prompt",
    triggerSource: "github",
  },
  {
    contextType: "agentphone",
    eventType: "input.prompt",
    triggerSource: "agentphone",
  },
  {
    contextType: "automation",
    eventType: "input.automation",
    triggerSource: "workflow-event",
  },
  {
    contextType: "goal",
    eventType: "input.goal",
    triggerSource: null,
  },
  {
    contextType: "morning_brief",
    eventType: "input.prompt",
    triggerSource: "workflow-schedule",
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

async function seedGoalFixture(
  tx: DbTransaction,
  args: {
    readonly composeId: string;
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
      agentId: args.composeId,
      chatThreadId: args.threadId,
      status: args.fixtureKind === "paused-goal" ? "paused" : "active",
      objective: "orphan monitor goal objective",
      objectiveBrief: "orphan monitor goal",
    })
    .returning({ id: threadGoals.id });
  if (!goal) {
    throw new Error("Failed to seed orphan monitor goal");
  }
  const [goalEvent] = await tx
    .insert(chatEvents)
    .values({
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
      seqId: 1,
    })
    .returning({ id: chatEvents.id });
  if (args.fixtureKind === "orphaned-goal") {
    await tx.delete(threadGoals).where(eq(threadGoals.id, goal.id));
  }
  return goalEvent;
}

async function seedGoalAgent(
  db: Db,
  args: {
    readonly composeId: string;
    readonly fixtureKind: FixtureKind;
    readonly orgId: string;
    readonly userId: string;
  },
  signal: AbortSignal,
): Promise<void> {
  if (
    args.fixtureKind !== "orphaned-goal" &&
    args.fixtureKind !== "paused-goal"
  ) {
    return;
  }
  await db.insert(zeroAgents).values({
    id: args.composeId,
    orgId: args.orgId,
    owner: args.userId,
    name: `orphan-monitor-${randomUUID()}`,
  });
  signal.throwIfAborted();
}

async function seedQueuedIntegrationEvent(tx: DbTransaction, threadId: string) {
  const [event] = await tx
    .insert(chatEvents)
    .values({
      chatThreadId: threadId,
      contextType: "slack",
      contextId: randomUUID(),
      eventType: "input.prompt",
      triggerSource: "slack",
      userMessage: createUserMessageDocument({
        text: "orphan monitor fixture",
      }),
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

  await seedGoalAgent(
    db,
    { composeId: compose.id, fixtureKind, orgId, userId },
    signal,
  );

  const [thread] = await db
    .insert(chatThreads)
    .values({ userId, agentComposeId: compose.id })
    .returning({ id: chatThreads.id });
  signal.throwIfAborted();
  if (!thread) {
    throw new Error("Failed to seed orphan monitor thread");
  }

  const events = await db.transaction(async (tx) => {
    const baseEvent = {
      chatThreadId: thread.id,
      userMessage: createUserMessageDocument({
        text: "orphan monitor fixture",
      }),
      runId: null,
    };
    if (fixtureKind === "orphan") {
      return await tx
        .insert(chatEvents)
        .values(
          STALE_CONTEXT_FIXTURES.map((fixture, index) => {
            return {
              ...baseEvent,
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
        triggerSource: "workflow-event",
        triggerBrief: null,
      });
      return [automation];
    }
    if (fixtureKind === "orphaned-goal" || fixtureKind === "paused-goal") {
      return [
        await seedGoalFixture(tx, {
          composeId: compose.id,
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
            triggerSource: "web",
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
      { composeId: compose.id, orgId, threadId: thread.id, userId },
      signal,
    );
  }
  signal.throwIfAborted();

  return actionOk({
    compose_id: compose.id,
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

    await db
      .delete(agentComposes)
      .where(eq(agentComposes.id, bodyResult.data.compose_id));
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
