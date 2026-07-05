import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import type { PersistedAttachment } from "@vm0/api-contracts/contracts/chat-threads";
import {
  testChatThreadStateContract,
  type TestChatThreadStateActionBody,
} from "@vm0/api-contracts/contracts/test-chat-thread-state";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { threadGoals } from "@vm0/db/schema/thread-goal";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { eq, inArray } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

interface ChatThreadFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly composeId: string;
  readonly threadId: string;
}

type ChatThreadStateAction<
  TAction extends TestChatThreadStateActionBody["action"],
> = Extract<TestChatThreadStateActionBody, { action: TAction }>;

function parseOptionalDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  return new Date(value);
}

function parseMaybeDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  return new Date(value);
}

function fixtureToWire(fixture: ChatThreadFixture) {
  return {
    user_id: fixture.userId,
    org_id: fixture.orgId,
    compose_id: fixture.composeId,
    thread_id: fixture.threadId,
  };
}

function fixtureFromWire(fixture: {
  readonly user_id: string;
  readonly org_id: string;
  readonly compose_id: string;
  readonly thread_id: string;
}): ChatThreadFixture {
  return {
    userId: fixture.user_id,
    orgId: fixture.org_id,
    composeId: fixture.compose_id,
    threadId: fixture.thread_id,
  };
}

async function seedChatThreadFixture(
  db: Db,
  args: {
    readonly userId?: string;
    readonly orgId?: string;
    readonly title?: string | null;
    readonly pinnedAt?: Date | null;
    readonly renamedAt?: Date | null;
    readonly lastReadAt?: Date | null;
    readonly lastReadMessageId?: string | null;
    readonly draftContent?: string | null;
    readonly draftAttachments?: readonly PersistedAttachment[] | null;
    readonly createdAt?: Date;
    readonly agentAvatarUrl?: string | null;
  },
  signal: AbortSignal,
): Promise<ChatThreadFixture> {
  const userId = args.userId ?? `user_${randomUUID()}`;
  const orgId = args.orgId ?? `org_${randomUUID()}`;
  const composeId = randomUUID();
  const threadId = randomUUID();

  await db.insert(agentComposes).values({
    id: composeId,
    userId,
    orgId,
    name: `compose-${composeId.slice(0, 8)}`,
  });
  signal.throwIfAborted();

  await db.insert(zeroAgents).values({
    id: composeId,
    orgId,
    owner: userId,
    name: `agent-${composeId.slice(0, 8)}`,
    ...(args.agentAvatarUrl !== undefined
      ? { avatarUrl: args.agentAvatarUrl }
      : {}),
  });
  signal.throwIfAborted();

  await db.insert(chatThreads).values({
    id: threadId,
    userId,
    agentComposeId: composeId,
    title: args.title ?? "chat thread",
    pinnedAt: args.pinnedAt ?? null,
    renamedAt: args.renamedAt ?? null,
    ...(args.lastReadAt !== undefined ? { lastReadAt: args.lastReadAt } : {}),
    ...(args.lastReadMessageId !== undefined
      ? { lastReadMessageId: args.lastReadMessageId }
      : {}),
    ...(args.draftContent !== undefined
      ? { draftContent: args.draftContent }
      : {}),
    ...(args.draftAttachments !== undefined
      ? {
          draftAttachments: args.draftAttachments
            ? [...args.draftAttachments]
            : null,
        }
      : {}),
    ...(args.createdAt !== undefined ? { createdAt: args.createdAt } : {}),
  });
  signal.throwIfAborted();

  return { userId, orgId, composeId, threadId };
}

async function deleteChatThreadFixture(
  db: Db,
  fixture: ChatThreadFixture,
  signal: AbortSignal,
): Promise<void> {
  const runRows = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.userId, fixture.userId));
  signal.throwIfAborted();
  const runIds = runRows.map((row) => {
    return row.id;
  });

  await db
    .delete(chatMessages)
    .where(eq(chatMessages.chatThreadId, fixture.threadId));
  signal.throwIfAborted();

  if (runIds.length > 0) {
    await db.delete(zeroRuns).where(inArray(zeroRuns.id, runIds));
    signal.throwIfAborted();
    await db.delete(agentRuns).where(inArray(agentRuns.id, runIds));
    signal.throwIfAborted();
  }

  await db
    .delete(agentSessions)
    .where(eq(agentSessions.userId, fixture.userId));
  signal.throwIfAborted();
  await db.delete(chatThreads).where(eq(chatThreads.id, fixture.threadId));
  signal.throwIfAborted();
  await db
    .delete(agentComposeVersions)
    .where(eq(agentComposeVersions.composeId, fixture.composeId));
  signal.throwIfAborted();
  await db.delete(zeroAgents).where(eq(zeroAgents.id, fixture.composeId));
  signal.throwIfAborted();
  await db.delete(agentComposes).where(eq(agentComposes.id, fixture.composeId));
  signal.throwIfAborted();
}

function completedAtForRunStatus(status: string): Date | null {
  return status === "queued" || status === "pending" || status === "running"
    ? null
    : nowDate();
}

async function seedThreadRun(
  db: Db,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly agentId: string;
    readonly threadId: string;
    readonly status: string;
  },
  signal: AbortSignal,
): Promise<string> {
  const [session] = await db
    .insert(agentSessions)
    .values({
      userId: args.userId,
      orgId: args.orgId,
      agentComposeId: args.agentId,
    })
    .returning({ id: agentSessions.id });
  signal.throwIfAborted();
  if (!session) {
    throw new Error("seedThreadRun: session insert returned no row");
  }

  const [run] = await db
    .insert(agentRuns)
    .values({
      userId: args.userId,
      orgId: args.orgId,
      sessionId: session.id,
      status: args.status,
      prompt: "bdd active unread aggregate",
      completedAt: completedAtForRunStatus(args.status),
    })
    .returning({ id: agentRuns.id });
  signal.throwIfAborted();
  if (!run) {
    throw new Error("seedThreadRun: run insert returned no row");
  }

  await db.insert(zeroRuns).values({
    id: run.id,
    triggerSource: "web",
    chatThreadId: args.threadId,
  });
  signal.throwIfAborted();

  return run.id;
}

async function seedThreadRunForAction(
  db: Db,
  body: ChatThreadStateAction<"seed-thread-run">,
  signal: AbortSignal,
) {
  const runId = await seedThreadRun(
    db,
    {
      userId: body.user_id,
      orgId: body.org_id,
      agentId: body.agent_id,
      threadId: body.thread_id,
      status: body.status,
    },
    signal,
  );
  return {
    status: 200 as const,
    body: { ok: true as const, run_id: runId },
  };
}

async function seedThreadGoalForAction(
  db: Db,
  body: ChatThreadStateAction<"seed-thread-goal">,
  signal: AbortSignal,
) {
  const [goal] = await db
    .insert(threadGoals)
    .values({
      orgId: body.org_id,
      ownerUserId: body.user_id,
      agentId: body.agent_id,
      chatThreadId: body.thread_id,
      status: body.status,
      objective: "bdd unread goal",
      objectiveBrief: "bdd unread goal",
    })
    .returning({ id: threadGoals.id });
  signal.throwIfAborted();
  if (!goal) {
    throw new Error("seedThreadGoalForAction: goal insert returned no row");
  }
  return {
    status: 200 as const,
    body: { ok: true as const, goal_id: goal.id },
  };
}

async function updateThreadRunStatusForAction(
  db: Db,
  body: ChatThreadStateAction<"update-thread-run-status">,
  signal: AbortSignal,
) {
  await db
    .update(agentRuns)
    .set({
      status: body.status,
      completedAt: completedAtForRunStatus(body.status),
    })
    .where(eq(agentRuns.id, body.run_id));
  signal.throwIfAborted();
  return { status: 200 as const, body: { ok: true as const } };
}

const actionBody$ = bodyResultOf(testChatThreadStateContract.action);

const mutateTestChatThreadState$ = command(
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
    const body = bodyResult.data;

    switch (body.action) {
      case "seed-thread": {
        const fixture = await seedChatThreadFixture(
          db,
          {
            userId: body.user_id,
            orgId: body.org_id,
            title: body.title,
            pinnedAt:
              body.pinned_at === undefined
                ? undefined
                : parseOptionalDate(body.pinned_at),
            renamedAt:
              body.renamed_at === undefined
                ? undefined
                : parseOptionalDate(body.renamed_at),
            lastReadAt:
              body.last_read_at === undefined
                ? undefined
                : parseOptionalDate(body.last_read_at),
            lastReadMessageId: body.last_read_message_id,
            draftContent: body.draft_content,
            draftAttachments: body.draft_attachments,
            createdAt: parseMaybeDate(body.created_at),
            agentAvatarUrl: body.agent_avatar_url,
          },
          signal,
        );
        return {
          status: 200 as const,
          body: { ok: true as const, fixture: fixtureToWire(fixture) },
        };
      }
      case "delete-thread": {
        await deleteChatThreadFixture(
          db,
          fixtureFromWire(body.fixture),
          signal,
        );
        return { status: 200 as const, body: { ok: true as const } };
      }
      case "seed-thread-run": {
        return await seedThreadRunForAction(db, body, signal);
      }
      case "seed-thread-goal": {
        return await seedThreadGoalForAction(db, body, signal);
      }
      case "update-thread-run-status": {
        return await updateThreadRunStatusForAction(db, body, signal);
      }
    }
  },
);

export const testChatThreadStateRoutes: readonly RouteEntry[] = [
  {
    route: testChatThreadStateContract.action,
    handler: mutateTestChatThreadState$,
  },
];
