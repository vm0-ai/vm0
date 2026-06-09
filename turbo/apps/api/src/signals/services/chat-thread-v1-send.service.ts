import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { and, eq } from "drizzle-orm";

import { notFound } from "../../lib/error";
import type { AuthContext } from "../../types/auth";
import { sendNormalMessage$ } from "../routes/zero-chat-messages";
import { writeDb$ } from "../external/db";

export const sendChatThreadMessageV1$ = command(
  async (
    { set },
    args: {
      readonly auth: AuthContext & { readonly orgId: string };
      readonly prompt: string;
      readonly threadId: string;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [thread] = await db
      .select({
        id: chatThreads.id,
        agentComposeId: chatThreads.agentComposeId,
      })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, args.threadId),
          eq(chatThreads.userId, args.auth.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!thread) {
      return notFound("Chat thread not found");
    }

    const messageId = randomUUID();
    const result = await set(
      sendNormalMessage$,
      {
        auth: args.auth,
        userId: args.auth.userId,
        orgId: args.auth.orgId,
        apiStartTime: args.apiStartTime,
        body: {
          agentId: thread.agentComposeId,
          threadId: thread.id,
          prompt: args.prompt,
          clientMessageId: messageId,
        },
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status !== 201) {
      return result;
    }

    return {
      status: 201 as const,
      body: {
        threadId: result.body.threadId,
        messageId,
        runId: result.body.runId,
        createdAt: result.body.createdAt,
      },
    };
  },
);
