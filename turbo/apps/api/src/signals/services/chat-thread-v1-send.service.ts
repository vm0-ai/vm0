import { randomBytes } from "node:crypto";

import { command, type Setter } from "ccstate";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, desc, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { badRequestMessage, notFound } from "../../lib/error";
import type { AuthContext } from "../../types/auth";
import { writeDb$, type Db } from "../external/db";
import {
  publishThreadListChanged,
  publishUserSignal,
} from "../external/realtime";
import { touchChatThreadLastMessageAt } from "./zero-chat-thread.service";
import {
  resolveChatRunModelPin,
  resolveModelFirstProviderAdmission,
  zeroRunModelSelectionFromPin,
} from "./zero-model-selection.service";
import { createZeroRun$ } from "./zero-runs-create.service";

interface OwnedThreadForSend {
  readonly id: string;
  readonly agentComposeId: string;
}

interface SendChatThreadMessageV1Args {
  readonly auth: AuthContext & { readonly orgId: string };
  readonly prompt: string;
  readonly threadId: string | undefined;
  readonly apiStartTime: number;
}

interface V1ThreadForRun {
  readonly thread: OwnedThreadForSend;
  readonly sessionId?: string;
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
  async ({ set }, args: SendChatThreadMessageV1Args, signal: AbortSignal) => {
    const db = set(writeDb$);

    const resolvedThread = await resolveThreadForV1Send(db, args, signal);
    if ("status" in resolvedThread) {
      return resolvedThread;
    }

    const runResult = await createChatThreadV1Run({
      set,
      db,
      args,
      ...resolvedThread,
      signal,
    });
    signal.throwIfAborted();

    if (runResult.status !== 201) {
      return runResult;
    }

    const messageId = await insertUserMessageForV1({
      db,
      threadId: resolvedThread.thread.id,
      prompt: args.prompt,
      runId: runResult.body.runId,
      signal,
    });
    await publishV1MessageSignals({
      db,
      userId: args.auth.userId,
      threadId: resolvedThread.thread.id,
      signal,
    });

    return {
      status: 201 as const,
      body: {
        threadId: resolvedThread.thread.id,
        messageId,
        createdAt: runResult.body.createdAt,
      },
    };
  },
);

async function resolveThreadForV1Send(
  db: Db,
  args: SendChatThreadMessageV1Args,
  signal: AbortSignal,
) {
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

    const sessionId = await latestSessionIdForThread(db, existingThread.id);
    signal.throwIfAborted();
    return { thread: existingThread, sessionId } satisfies V1ThreadForRun;
  }

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

  return { thread: createdThread } satisfies V1ThreadForRun;
}

async function createChatThreadV1Run(args: {
  readonly set: Setter;
  readonly db: Db;
  readonly args: SendChatThreadMessageV1Args;
  readonly thread: OwnedThreadForSend;
  readonly sessionId?: string;
  readonly signal: AbortSignal;
}) {
  const modelPin = await resolveChatRunModelPin({
    db: args.db,
    orgId: args.args.auth.orgId,
    userId: args.args.auth.userId,
    threadId: args.thread.id,
    modelSelection: undefined,
    forceNewSession: false,
  });
  args.signal.throwIfAborted();
  if ("status" in modelPin) {
    return modelPin;
  }

  const providerAdmission = await resolveModelFirstProviderAdmission({
    db: args.db,
    orgId: args.args.auth.orgId,
    userId: args.args.auth.userId,
    modelPin,
    requestedModelProvider: undefined,
  });
  args.signal.throwIfAborted();
  if (providerAdmission.error) {
    return providerAdmission.error;
  }

  return await args.set(
    createZeroRun$,
    {
      auth: args.args.auth,
      apiStartTime: args.args.apiStartTime,
      chatThreadId: args.thread.id,
      modelProviderId: modelPin.modelProviderId ?? undefined,
      modelProviderCredentialScope:
        modelPin.modelProviderCredentialScope ?? undefined,
      selectedModelOverride: modelPin.selectedModel ?? undefined,
      zeroRunModelSelection: zeroRunModelSelectionFromPin(
        modelPin,
        providerAdmission.effectiveModelProvider,
      ),
      triggerSource: "web",
      appendSystemPrompt: buildWebChatPrompt(),
      body: {
        prompt: args.args.prompt,
        agentId: args.thread.agentComposeId,
        ...(args.sessionId ? { sessionId: args.sessionId } : {}),
        ...(providerAdmission.effectiveModelProvider
          ? { modelProvider: providerAdmission.effectiveModelProvider }
          : {}),
      },
      callbacks: [
        {
          url: chatCallbackUrl(),
          secret: generateCallbackSecret(),
          payload: {
            threadId: args.thread.id,
            agentId: args.thread.agentComposeId,
          },
        },
      ],
    },
    args.signal,
  );
}

async function insertUserMessageForV1(args: {
  readonly db: Db;
  readonly threadId: string;
  readonly prompt: string;
  readonly runId: string;
  readonly signal: AbortSignal;
}): Promise<string> {
  const [message] = await args.db
    .insert(chatMessages)
    .values({
      chatThreadId: args.threadId,
      role: "user",
      content: args.prompt,
      runId: args.runId,
    })
    .returning({ id: chatMessages.id });
  args.signal.throwIfAborted();

  if (!message) {
    throw new Error("Failed to insert chat message");
  }

  return message.id;
}

async function publishV1MessageSignals(args: {
  readonly db: Db;
  readonly userId: string;
  readonly threadId: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  await touchChatThreadLastMessageAt(args.db, args.threadId);
  args.signal.throwIfAborted();

  await publishUserSignal(
    [args.userId],
    `chatThreadMessageCreated:${args.threadId}`,
  );
  args.signal.throwIfAborted();

  await publishThreadListChanged(args.userId);
  args.signal.throwIfAborted();

  await publishUserSignal(
    [args.userId],
    `chatThreadRunCreated:${args.threadId}`,
  );
  args.signal.throwIfAborted();

  await publishThreadListChanged(args.userId);
  args.signal.throwIfAborted();
}

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
