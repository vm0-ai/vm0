import { randomBytes } from "node:crypto";

import { command } from "ccstate";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, desc, eq } from "drizzle-orm";

import { badRequestMessage, notFound } from "../../lib/error";
import { internalApiBaseUrl } from "../../lib/internal-api-url";
import type { AuthContext } from "../../types/auth";
import { writeDb$, type Db } from "../external/db";
import {
  publishThreadListChanged,
  publishUserSignal,
} from "../external/realtime";
import { createZeroRun$ } from "./zero-runs-create.service";

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
  return new URL(
    "/api/internal/callbacks/chat",
    internalApiBaseUrl(),
  ).toString();
}

export const sendChatThreadMessageV1$ = command(
  async (
    { set },
    args: {
      readonly auth: AuthContext & { readonly orgId: string };
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
            eq(chatThreads.userId, args.auth.userId),
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
      const agentId = await defaultAgentId(db, args.auth.orgId);
      signal.throwIfAborted();

      if (!agentId) {
        return badRequestMessage(
          "No default agent configured for this organization",
        );
      }

      const [createdThread] = await db
        .insert(chatThreads)
        .values({
          userId: args.auth.userId,
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

    // Route through createZeroRun$ so the V1 surface matches the web chat
    // path: env-ref validation is skipped, ZERO_TOKEN secret is injected,
    // credit enforcement / concurrency queueing / skill volumes / connector
    // allowlists are all applied. Direct createAgentRun$ calls left the V1
    // path missing every one of those, which surfaced as a 400 "Missing
    // required values: vars.*" whenever the default agent referenced
    // integration vars the caller had not provided.
    const runResult = await set(
      createZeroRun$,
      {
        auth: args.auth,
        apiStartTime: args.apiStartTime,
        chatThreadId: thread.id,
        triggerSource: "web",
        appendSystemPrompt: buildWebChatPrompt(),
        body: {
          prompt: args.prompt,
          agentId: thread.agentComposeId,
          ...(sessionId ? { sessionId } : {}),
        },
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
      [args.auth.userId],
      `chatThreadMessageCreated:${thread.id}`,
    );
    signal.throwIfAborted();

    await publishThreadListChanged(args.auth.userId);
    signal.throwIfAborted();

    await publishUserSignal(
      [args.auth.userId],
      `chatThreadRunCreated:${thread.id}`,
    );
    signal.throwIfAborted();

    await publishThreadListChanged(args.auth.userId);
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
    // D7 session-continuity exclusion (see latestSessionIdForThread in
    // zero-chat-messages.ts): only web-source runs join the chain, so a
    // scheduled run never bleeds into web-chat session continuity.
    .where(
      and(
        eq(zeroRuns.chatThreadId, threadId),
        eq(zeroRuns.triggerSource, "web"),
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(5);

  for (const row of rows) {
    if (hasAgentSessionId(row.result)) {
      return row.result.agentSessionId;
    }
  }
  return undefined;
}
