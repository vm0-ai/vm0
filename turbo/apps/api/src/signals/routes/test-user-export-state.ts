import {
  type TestUserExportStateActionBody,
  testUserExportStateContract,
} from "@vm0/api-contracts/contracts/test-user-export-state";
import { emailOutbox } from "@vm0/db/schema/email-outbox";
import { exportJobs } from "@vm0/db/schema/export-job";
import { userCache } from "@vm0/db/schema/user-cache";
import { users } from "@vm0/db/schema/user";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";

import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const actionBody$ = bodyResultOf(testUserExportStateContract.action);
const DATA_EXPORT_READY_SUBJECT = "Your data export is ready";
const VM0_OUTBOX_FROM = "Zero <vm0@mail.example.com>";

function actionOk(extra: Record<string, unknown> = {}) {
  return {
    status: 200 as const,
    body: { ok: true as const, ...extra },
  };
}

function actionBadRequest(error: string) {
  return { status: 400 as const, body: { error } };
}

type UserExportStateAction = TestUserExportStateActionBody["action"];
type UserExportStateActionResponse =
  | ReturnType<typeof actionOk>
  | ReturnType<typeof actionBadRequest>;
type UserExportStateActionHandler = (
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<UserExportStateActionResponse>;

function readString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function deleteUserExportStateForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const userId = readString(body, "user_id");
  const email = readString(body, "email");
  if (!userId || !email) {
    return actionBadRequest("user_id and email are required");
  }

  await db.delete(emailOutbox).where(
    and(
      eq(emailOutbox.fromAddress, VM0_OUTBOX_FROM),
      eq(emailOutbox.subject, DATA_EXPORT_READY_SUBJECT),
      sql`(
        ${emailOutbox.toAddresses} = ${JSON.stringify(email)}::jsonb
        OR ${emailOutbox.toAddresses} @> ${JSON.stringify([email])}::jsonb
      )`,
    ),
  );
  signal.throwIfAborted();

  await db.delete(exportJobs).where(eq(exportJobs.userId, userId));
  signal.throwIfAborted();

  await db.delete(userCache).where(eq(userCache.userId, userId));
  signal.throwIfAborted();

  await db.delete(users).where(eq(users.id, userId));
  signal.throwIfAborted();

  return actionOk();
}

async function seedChatMessagesForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const userId = readString(body, "user_id");
  const agentId = readString(body, "agent_id");
  const threadId = readString(body, "thread_id");
  if (!userId || !agentId || !threadId) {
    return actionBadRequest("user_id, agent_id, and thread_id are required");
  }

  const createdAt = new Date("2026-05-12T05:01:00.000Z");
  await db.insert(chatThreads).values({
    id: threadId,
    userId,
    agentComposeId: agentId,
    title: "BDD export thread",
    lastMessageAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  });
  signal.throwIfAborted();

  await db.insert(chatMessages).values([
    {
      chatThreadId: threadId,
      role: "user",
      content: "exported user text",
      createdAt: new Date("2026-05-12T05:02:00.000Z"),
    },
    {
      chatThreadId: threadId,
      role: "assistant",
      content: "exported assistant text",
      createdAt: new Date("2026-05-12T05:03:00.000Z"),
    },
    {
      chatThreadId: threadId,
      role: "assistant",
      content: null,
      error: "hidden assistant error",
      createdAt: new Date("2026-05-12T05:04:00.000Z"),
    },
    {
      chatThreadId: threadId,
      role: "system",
      content: "hidden system text",
      createdAt: new Date("2026-05-12T05:05:00.000Z"),
    },
  ]);
  signal.throwIfAborted();

  return actionOk({ thread_id: threadId });
}

const userExportStateActionHandlers = {
  "delete-user-export-state": deleteUserExportStateForAction,
  "seed-chat-messages": seedChatMessagesForAction,
} satisfies Record<UserExportStateAction, UserExportStateActionHandler>;

const mutateTestUserExportState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const body = bodyResult.data as Record<string, unknown>;
    return await userExportStateActionHandlers[bodyResult.data.action](
      set(writeDb$),
      body,
      signal,
    );
  },
);

export const testUserExportStateRoutes: readonly RouteEntry[] = [
  {
    route: testUserExportStateContract.action,
    handler: mutateTestUserExportState$,
  },
];
