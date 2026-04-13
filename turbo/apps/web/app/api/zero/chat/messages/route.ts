import { eq } from "drizzle-orm";
import { after } from "next/server";
import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { chatMessagesContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import {
  createZeroRunRecord,
  dispatchZeroRun,
} from "../../../../../src/lib/zero/zero-run-service";
import { buildWebChatPrompt } from "../../../../../src/lib/zero/integration-prompt";
import { isApiError } from "../../../../../src/lib/shared/errors";
import {
  createChatThread,
  getChatThread,
  addRunToThread,
  updateChatThreadTitle,
  getChatThreadContext,
  threadHasNoRuns,
} from "../../../../../src/lib/zero/chat-thread/chat-thread-service";
import { generateChatTitle } from "../../../../../src/lib/zero/ai/lightweight-model";
import { zeroAgents } from "../../../../../src/db/schema/zero-agent";
import { zeroRuns } from "../../../../../src/db/schema/zero-run";
import { zeroAgentSchedules } from "../../../../../src/db/schema/zero-agent-schedule";
import {
  getApiUrl,
  generateCallbackSecret,
} from "../../../../../src/lib/infra/callback";
import type { ChatCallbackPayload } from "../../../../../src/lib/infra/callback/callback-payloads";
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

    let threadId: string | undefined;

    try {
      // Resolve or create thread
      let sessionId: string | undefined;
      let previousContext: Awaited<ReturnType<typeof getChatThreadContext>> =
        [];
      // Seeded once on the first run of a thread started from a scheduled run.
      // Subsequent runs inherit the session context so we don't re-apply it.
      let continueFromSchedulePrompt: string | undefined;

      if (body.threadId) {
        const thread = await getChatThread(body.threadId, authCtx.userId);
        threadId = thread.id;
        sessionId = thread.sessionId ?? undefined;
        previousContext = await getChatThreadContext(thread.id, authCtx.userId);
        if (thread.sourceScheduleRunId && (await threadHasNoRuns(thread.id))) {
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
      } else {
        const thread = await createChatThread(authCtx.userId, body.agentId);
        threadId = thread.id;
        sessionId = undefined;
      }

      // Only generate title when prompt has actual user text
      if (body.hasTextContent !== false) {
        const capturedThreadId = threadId;
        void generateChatTitle(
          body.prompt,
          previousContext.length > 0 ? previousContext : undefined,
        )
          .then((title) => {
            if (title) {
              return updateChatThreadTitle(capturedThreadId, title);
            }
          })
          .catch((err: unknown) => {
            log.warn("Chat title generation failed", {
              threadId: capturedThreadId,
              err,
            });
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

      // Create the run record (pre-flight checks + advisory-locked INSERT).
      // Does NOT dispatch — tokens, secrets, and runner dispatch are deferred.
      const result = await createZeroRunRecord({
        userId: authCtx.userId,
        prompt: body.prompt,
        agentId: body.agentId,
        sessionId,
        triggerSource: "web",
        modelProvider,
        appendSystemPrompt: continueFromSchedulePrompt
          ? [buildWebChatPrompt(), continueFromSchedulePrompt].join("\n\n")
          : buildWebChatPrompt(),
        callbacks: [chatCallback],
      });

      // Associate run to thread
      await addRunToThread(threadId, result.runId, authCtx.userId);

      // Defer the heavy dispatch pipeline (token generation, secret resolution,
      // OAuth refresh, storage manifest, runner dispatch) to after the response
      // is flushed. Failures are recorded via markRunFailed() inside dispatchZeroRun().
      after(() => {
        return dispatchZeroRun(result).catch((err: unknown) => {
          log.error("Deferred dispatch failed", {
            runId: result.runId,
            err,
          });
        });
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
