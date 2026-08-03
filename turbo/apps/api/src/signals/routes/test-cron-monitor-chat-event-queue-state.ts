import { randomUUID } from "node:crypto";

import {
  testCronMonitorChatEventQueueStateContract,
  type TestCronMonitorChatEventQueueStateActionBody,
} from "@vm0/api-contracts/contracts/test-cron-monitor-chat-event-queue-state";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatEventInputParams } from "@vm0/db/schema/chat-event-input-params";
import { chatEvents } from "@vm0/db/schema/chat-event";
import { chatThreads } from "@vm0/db/schema/chat-thread";
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

const STALE_CONTEXT_FIXTURES = [
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
              contextId: randomUUID(),
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
    const event =
      fixtureKind === "failed-message"
        ? await insertChatEvent(tx, {
            ...baseEvent,
            eventType: "input.rejected",
            error: "INSUFFICIENT_CREDITS",
          })
        : await insertChatEvent(tx, {
            ...baseEvent,
            eventType: "input.prompt",
            triggerSource:
              fixtureKind === "queued-integration" ? "slack" : "web",
          });
    return [event];
  });
  signal.throwIfAborted();
  const event = events[0];
  if (!event) {
    throw new Error("Failed to seed orphan monitor message");
  }

  if (fixtureKind === "queued-integration") {
    await db.insert(chatEventInputParams).values({
      eventId: event.id,
      encryptedParams: "encrypted-monitor-params",
    });
  } else if (fixtureKind === "revoked-message") {
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
    event_ids: events.map((candidate) => {
      if (!candidate) {
        throw new Error("Failed to seed orphan monitor message");
      }
      return candidate.id;
    }),
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
