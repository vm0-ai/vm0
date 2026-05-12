import { randomBytes } from "node:crypto";

import { command } from "ccstate";
import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, desc, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { badRequestMessage, notFound } from "../../lib/error";
import { writeDb$, type Db } from "../external/db";
import {
  publishThreadListChanged,
  publishUserSignal,
} from "../external/realtime";
import { createAgentRun$ } from "./agent-run-create.service";

interface OwnedThreadForSend {
  readonly id: string;
  readonly agentComposeId: string;
}

function hasAgentSessionId(
  value: unknown,
): value is { readonly agentSessionId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "agentSessionId" in value &&
    typeof (value as { readonly agentSessionId: unknown }).agentSessionId ===
      "string"
  );
}

function buildWebChatPrompt(): string {
  return [
    "# Current Integration\nYou are currently running inside: Web",
    "You are communicating with the user through the web chat UI.",
  ].join("\n\n");
}

function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
}

function chatCallbackUrl(): string {
  return new URL("/api/internal/callbacks/chat", env("VM0_API_URL")).toString();
}

export const sendChatThreadMessageV1$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly prompt: string;
      readonly threadId: string | undefined;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);

    let thread: OwnedThreadForSend;
    let sessionId: string | undefined;

    if (args.threadId) {
      const [existingThread] = await db
        .select({
          id: chatThreads.id,
          agentComposeId: chatThreads.agentComposeId,
        })
        .from(chatThreads)
        .where(
          and(
            eq(chatThreads.id, args.threadId),
            eq(chatThreads.userId, args.userId),
          ),
        )
        .limit(1);
      signal.throwIfAborted();

      if (!existingThread) {
        return notFound("Chat thread not found");
      }

      thread = existingThread;
      sessionId = await latestSessionIdForThread(db, thread.id);
      signal.throwIfAborted();
    } else {
      const agentId = await defaultAgentId(db, args.orgId);
      signal.throwIfAborted();

      if (!agentId) {
        return badRequestMessage(
          "No default agent configured for this organization",
        );
      }

      const [createdThread] = await db
        .insert(chatThreads)
        .values({
          userId: args.userId,
          agentComposeId: agentId,
          title: null,
        })
        .returning({
          id: chatThreads.id,
          agentComposeId: chatThreads.agentComposeId,
        });
      signal.throwIfAborted();

      if (!createdThread) {
        throw new Error("Failed to create chat thread");
      }

      thread = createdThread;
    }

    const triggerSource: TriggerSource = "web";
    const runBody = {
      prompt: args.prompt,
      agentComposeId: thread.agentComposeId,
      ...(sessionId ? { sessionId } : {}),
      triggerSource,
      appendSystemPrompt: buildWebChatPrompt(),
    };

    const runResult = await set(
      createAgentRun$,
      {
        userId: args.userId,
        orgId: args.orgId,
        body: runBody,
        apiStartTime: args.apiStartTime,
        chatThreadId: thread.id,
        callbacks: [
          {
            url: chatCallbackUrl(),
            secret: generateCallbackSecret(),
            payload: { threadId: thread.id, agentId: thread.agentComposeId },
          },
        ],
      },
      signal,
    );
    signal.throwIfAborted();

    if (runResult.status !== 201) {
      return runResult;
    }

    const [message] = await db
      .insert(chatMessages)
      .values({
        chatThreadId: thread.id,
        role: "user",
        content: args.prompt,
        runId: runResult.body.runId,
      })
      .returning({ id: chatMessages.id });
    signal.throwIfAborted();

    if (!message) {
      throw new Error("Failed to insert chat message");
    }

    await publishUserSignal(
      [args.userId],
      `chatThreadMessageCreated:${thread.id}`,
    );
    signal.throwIfAborted();

    await publishThreadListChanged(args.userId);
    signal.throwIfAborted();

    await publishUserSignal([args.userId], `chatThreadRunCreated:${thread.id}`);
    signal.throwIfAborted();

    await publishThreadListChanged(args.userId);
    signal.throwIfAborted();

    return {
      status: 201 as const,
      body: {
        threadId: thread.id,
        messageId: message.id,
        createdAt: runResult.body.createdAt,
      },
    };
  },
);

async function defaultAgentId(db: Db, orgId: string): Promise<string | null> {
  const [orgRow] = await db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  return orgRow?.defaultAgentId ?? null;
}

async function latestSessionIdForThread(
  db: Db,
  threadId: string,
): Promise<string | undefined> {
  const rows = await db
    .select({ result: agentRuns.result })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(zeroRuns.id, agentRuns.id))
    .where(eq(zeroRuns.chatThreadId, threadId))
    .orderBy(desc(agentRuns.createdAt))
    .limit(5);

  for (const row of rows) {
    if (hasAgentSessionId(row.result)) {
      return row.result.agentSessionId;
    }
  }
  return undefined;
}
