import { and, eq } from "drizzle-orm";
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
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { modelProviders } from "../../../../../src/db/schema/model-provider";
import { chatThreads } from "../../../../../src/db/schema/chat-thread";
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
  publishThreadListChanged,
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
 * Persist the composer's per-run override onto the thread row and return the
 * effective override to use for this run (precedence: per-run > thread > agent).
 * `undefined` for `modelSelection` means "leave thread row as-is" — older
 * clients that never saw the field still get the thread/agent fall-through.
 */
async function resolveRunModelOverride(
  threadId: string,
  agent: { modelProviderId: string | null; selectedModel: string | null },
  modelSelection:
    | { modelProviderId: string; selectedModel: string }
    | null
    | undefined,
): Promise<{ providerId: string | null; selectedModel: string | null }> {
  if (modelSelection !== undefined) {
    await globalThis.services.db
      .update(chatThreads)
      .set({
        modelProviderId: modelSelection?.modelProviderId ?? null,
        selectedModel: modelSelection?.selectedModel ?? null,
        updatedAt: new Date(),
      })
      .where(eq(chatThreads.id, threadId));
    if (modelSelection !== null) {
      return {
        providerId: modelSelection.modelProviderId,
        selectedModel: modelSelection.selectedModel,
      };
    }
    // modelSelection === null means "clear" — fall through to agent default.
  } else {
    const [thread] = await globalThis.services.db
      .select({
        modelProviderId: chatThreads.modelProviderId,
        selectedModel: chatThreads.selectedModel,
      })
      .from(chatThreads)
      .where(eq(chatThreads.id, threadId))
      .limit(1);
    if (thread?.modelProviderId && thread.selectedModel) {
      return {
        providerId: thread.modelProviderId,
        selectedModel: thread.selectedModel,
      };
    }
  }
  return {
    providerId: agent.modelProviderId,
    selectedModel: agent.selectedModel,
  };
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

    // Verify agent exists and fetch model provider override
    const [agent] = await globalThis.services.db
      .select({
        id: zeroAgents.id,
        modelProviderId: zeroAgents.modelProviderId,
        selectedModel: zeroAgents.selectedModel,
      })
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

    // Validate per-run model selection belongs to the caller's org before
    // we trust it to write onto the thread or override the agent's default.
    if (body.modelSelection) {
      const { org } = await resolveOrg(authCtx);
      const [provider] = await globalThis.services.db
        .select({ id: modelProviders.id })
        .from(modelProviders)
        .where(
          and(
            eq(modelProviders.id, body.modelSelection.modelProviderId),
            eq(modelProviders.orgId, org.orgId),
          ),
        )
        .limit(1);
      if (!provider) {
        return {
          status: 400 as const,
          body: {
            error: {
              message: "Unknown model provider for this workspace",
              code: "BAD_REQUEST" as const,
            },
          },
        };
      }
    }

    try {
      const {
        threadId,
        sessionId,
        previousContext,
        continueFromSchedulePrompt,
      } = await resolveThread(authCtx.userId, body.agentId, body.threadId);

      const override = await resolveRunModelOverride(
        threadId,
        {
          modelProviderId: agent.modelProviderId,
          selectedModel: agent.selectedModel,
        },
        body.modelSelection,
      );

      // Only generate title when prompt has actual user text. The
      // assistant reply is not yet available at send time — the chat
      // callback regenerates the title with the full current exchange
      // once the run completes.
      if (body.hasTextContent !== false) {
        void generateChatTitle({
          currentUserMessage: body.prompt,
          priorRounds: previousContext.length > 0 ? previousContext : undefined,
        })
          .then((title) => {
            if (title) {
              return updateChatThreadTitle(threadId, authCtx.userId, title);
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
        modelProviderId: override.providerId ?? undefined,
        selectedModelOverride: override.selectedModel ?? undefined,
        appendSystemPrompt: buildAppendSystemPrompt(continueFromSchedulePrompt),
        callbacks: [chatCallback],
        chatThreadId: threadId,
      });

      // Persist user message to chat_messages.
      // Only file IDs are stored — metadata is resolved at query time from S3.
      // insertChatMessage also publishes chatThreadMessageCreated internally,
      // so the paged-messages view picks up the new row.
      // Stamp with the runId so the callback's prior-context filter can
      // exclude this message structurally (by runId) instead of by content.
      await insertChatMessage({
        chatThreadId: threadId,
        userId: authCtx.userId,
        role: "user",
        content: body.prompt,
        runId: result.runId,
        attachFiles: body.attachFiles?.map((f) => {
          return f.id;
        }),
        id: body.clientMessageId,
      });

      after(async () => {
        await publishUserSignal(
          [authCtx.userId],
          `chatThreadRunCreated:${threadId}`,
        );
        await publishThreadListChanged(authCtx.userId);
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
