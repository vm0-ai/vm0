import { eq } from "drizzle-orm";
import { after } from "next/server";
import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { chatMessagesContract, type AttachFile } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { createZeroRun } from "../../../../../src/lib/zero/zero-run-service";
import {
  buildWebChatPrompt,
  buildWebAttachFilesPrompt,
} from "../../../../../src/lib/zero/integration-prompt";
import { isApiError } from "../../../../../src/lib/shared/errors";
import {
  createChatThread,
  getChatThread,
  updateChatThreadTitle,
} from "../../../../../src/lib/zero/chat-thread/chat-thread-service";
import {
  insertChatMessage,
  getLatestSessionIdForThread,
  getMessagesByThreadId,
} from "../../../../../src/lib/zero/chat-thread/chat-message-service";
import { generateChatTitle } from "../../../../../src/lib/zero/ai/lightweight-model";
import { zeroAgents } from "../../../../../src/db/schema/zero-agent";
import { zeroRuns } from "../../../../../src/db/schema/zero-run";
import { zeroAgentSchedules } from "../../../../../src/db/schema/zero-agent-schedule";
import {
  getApiUrl,
  generateCallbackSecret,
} from "../../../../../src/lib/infra/callback";
import type { ChatCallbackPayload } from "../../../../../src/lib/infra/callback/callback-payloads";
import { publishUserSignal } from "../../../../../src/lib/infra/realtime/client";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("zero:chat-messages");

/**
 * System prompt seeded on the first run of a thread that was started from a
 * previously scheduled run. The agent can pull the original run's full
 * telemetry via the `zero logs <runId>` CLI command inside its sandbox.
 */
function buildContinueFromScheduleSystemPrompt(
  runId: string,
  scheduleName: string | null,
): string {
  const scheduleSuffix = scheduleName ? `(scheduleName: ${scheduleName})` : "";
  return (
    `You are continuing a previously scheduled run${scheduleSuffix}. ` +
    `Before replying, run \`zero logs ${runId}\` inside your sandbox to ` +
    `fetch the full record of that run, then continue the conversation with ` +
    `the user based on that context.`
  );
}

function buildAppendSystemPrompt(
  continueFromSchedulePrompt: string | undefined,
): string {
  const parts = [buildWebChatPrompt()];
  if (continueFromSchedulePrompt) {
    parts.push(continueFromSchedulePrompt);
  }
  return parts.join("\n\n");
}

/**
 * Build the full prompt including file descriptions appended after user text.
 */
function buildFullPrompt(
  prompt: string,
  attachFiles: AttachFile[] | undefined,
): string {
  if (!attachFiles || attachFiles.length === 0) return prompt;
  return `${prompt}\n\n${buildWebAttachFilesPrompt(attachFiles)}`;
}

interface ResolvedThread {
  threadId: string;
  sessionId: string | undefined;
  previousContext: { role: "user" | "assistant"; content: string }[];
  continueFromSchedulePrompt: string | undefined;
}

/**
 * Resolve an existing thread or create a new one.
 * Returns thread metadata needed for run creation and title generation.
 */
async function resolveThread(
  userId: string,
  agentId: string,
  existingThreadId: string | undefined,
): Promise<ResolvedThread> {
  if (!existingThreadId) {
    const thread = await createChatThread(userId, agentId);
    return {
      threadId: thread.id,
      sessionId: undefined,
      previousContext: [],
      continueFromSchedulePrompt: undefined,
    };
  }

  const thread = await getChatThread(existingThreadId, userId);
  const sessionId = await getLatestSessionIdForThread(thread.id);
  const messages = await getMessagesByThreadId(thread.id);
  const previousContext = messages
    .filter((m) => {
      return m.content !== null;
    })
    .slice(-10)
    .map((m) => {
      return {
        role: m.role as "user" | "assistant",
        content: m.content as string,
      };
    });

  let continueFromSchedulePrompt: string | undefined;
  if (thread.sourceScheduleRunId && messages.length === 0) {
    const [sourceSchedule] = await globalThis.services.db
      .select({ name: zeroAgentSchedules.name })
      .from(zeroRuns)
      .innerJoin(
        zeroAgentSchedules,
        eq(zeroRuns.scheduleId, zeroAgentSchedules.id),
      )
      .where(eq(zeroRuns.id, thread.sourceScheduleRunId))
      .limit(1);
    continueFromSchedulePrompt = buildContinueFromScheduleSystemPrompt(
      thread.sourceScheduleRunId,
      sourceSchedule?.name ?? null,
    );
  }

  return {
    threadId: thread.id,
    sessionId,
    previousContext,
    continueFromSchedulePrompt,
  };
}

const router = tsr.router(chatMessagesContract, {
  send: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent-run:write",
    });
    if (isAuthError(authCtx)) return authCtx;

    // Verify agent exists
    const [agent] = await globalThis.services.db
      .select({ id: zeroAgents.id })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, body.agentId))
      .limit(1);

    if (!agent) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent not found", code: "NOT_FOUND" as const },
        },
      };
    }

    try {
      const {
        threadId,
        sessionId,
        previousContext,
        continueFromSchedulePrompt,
      } = await resolveThread(authCtx.userId, body.agentId, body.threadId);

      // Only generate title when prompt has actual user text
      if (body.hasTextContent !== false) {
        void generateChatTitle(
          body.prompt,
          previousContext.length > 0 ? previousContext : undefined,
        )
          .then((title) => {
            if (title) {
              return updateChatThreadTitle(threadId, title);
            }
          })
          .catch((err: unknown) => {
            log.warn("Chat title generation failed", { threadId, err });
          });
      }

      // Build callback for session persistence
      const chatCallback: {
        url: string;
        secret: string;
        payload: ChatCallbackPayload;
      } = {
        url: getApiUrl() + "/api/internal/callbacks/chat",
        secret: generateCallbackSecret(),
        payload: { threadId, agentId: body.agentId },
      };

      const modelProvider =
        body.modelProvider && body.modelProvider !== "default"
          ? body.modelProvider
          : undefined;

      // Build prompt: user text + file descriptions appended
      const fullPrompt = buildFullPrompt(body.prompt, body.attachFiles);

      // Create the run. Phase 2 dispatch is deferred inside createZeroRun
      // via after() so the response flushes before tokens/secrets/runner work.
      const result = await createZeroRun({
        userId: authCtx.userId,
        prompt: fullPrompt,
        agentId: body.agentId,
        sessionId,
        triggerSource: "web",
        modelProvider,
        appendSystemPrompt: buildAppendSystemPrompt(continueFromSchedulePrompt),
        callbacks: [chatCallback],
        chatThreadId: threadId,
      });

      // Persist user message to chat_messages.
      // Only file IDs are stored — metadata is resolved at query time from S3.
      await insertChatMessage({
        chatThreadId: threadId,
        role: "user",
        content: body.prompt,
        runId: null,
        attachFiles: body.attachFiles?.map((f) => {
          return f.id;
        }),
        id: body.clientMessageId,
      });

      // Notify subscribers that a new run and messages were created on this thread
      after(async () => {
        await publishUserSignal(
          [authCtx.userId],
          `chatThreadRunCreated:${threadId}`,
        );
        await publishUserSignal(
          [authCtx.userId],
          `chatThreadMessageCreated:${threadId}`,
        );
      });

      return {
        status: 201 as const,
        body: {
          runId: result.runId,
          threadId,
          status: result.status,
          createdAt: result.createdAt.toISOString(),
        },
      };
    } catch (error) {
      if (isApiError(error)) {
        const status = error.code === "UNAUTHORIZED" ? 404 : error.statusCode;
        const code = error.code === "UNAUTHORIZED" ? "NOT_FOUND" : error.code;
        const message =
          error.code === "UNAUTHORIZED" ? "Resource not found" : error.message;
        return {
          status: status as 400 | 401 | 403 | 404,
          body: { error: { message, code } },
        };
      }

      throw error;
    }
  },
});

const handler = createHandler(chatMessagesContract, router, {
  errorHandler: createSafeErrorHandler("zero-chat-messages"),
});

export { handler as POST };
