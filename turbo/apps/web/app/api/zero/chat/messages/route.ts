import { eq } from "drizzle-orm";
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
import { createZeroRun } from "../../../../../src/lib/zero/zero-run-service";
import { isRunDispatchError } from "../../../../../src/lib/run";
import { isApiError } from "../../../../../src/lib/errors";
import {
  createChatThread,
  getChatThread,
  addRunToThread,
} from "../../../../../src/lib/chat-thread/chat-thread-service";
import { zeroAgents } from "../../../../../src/db/schema/zero-agent";
import {
  getApiUrl,
  generateCallbackSecret,
} from "../../../../../src/lib/callback";
import type { ChatCallbackPayload } from "../../../../../src/lib/callback/callback-payloads";

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

      if (body.threadId) {
        const thread = await getChatThread(body.threadId, authCtx.userId);
        threadId = thread.id;
        sessionId = thread.sessionId ?? undefined;
      } else {
        const title = body.prompt.trim().slice(0, 100);
        const thread = await createChatThread(
          authCtx.userId,
          body.agentId,
          title,
        );
        threadId = thread.id;
        sessionId = undefined;
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

      // Create the run
      const result = await createZeroRun({
        userId: authCtx.userId,
        prompt: body.prompt,
        agentId: body.agentId,
        sessionId,
        triggerSource: "web",
        modelProvider,
        callbacks: [chatCallback],
      });

      // Associate run to thread
      await addRunToThread(threadId, result.runId, authCtx.userId);

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
      // Dispatch errors with a runId: return partial result with threadId
      if (isRunDispatchError(error) && error.runId && threadId) {
        return {
          status: 201 as const,
          body: {
            runId: error.runId,
            threadId,
            status: "failed" as const,
            createdAt: error.createdAt?.toISOString() ?? "",
          },
        };
      }

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
