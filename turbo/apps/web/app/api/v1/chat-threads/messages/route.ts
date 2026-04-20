import { after } from "next/server";
import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { chatThreadV1SendContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireApiKeyAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { createZeroRun } from "../../../../../src/lib/zero/zero-run-service";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { resolveDefaultAgentId } from "../../../../../src/lib/zero/resolve-default-agent";
import { buildWebChatPrompt } from "../../../../../src/lib/zero/integration-prompt";
import { isApiError, isNotFound } from "../../../../../src/lib/shared/errors";
import {
  createChatThread,
  getChatThread,
} from "../../../../../src/lib/zero/chat-thread/chat-thread-service";
import {
  insertChatMessage,
  getLatestSessionIdForThread,
  publishThreadListChanged,
} from "../../../../../src/lib/zero/chat-thread/chat-message-service";
import {
  getApiUrl,
  generateCallbackSecret,
} from "../../../../../src/lib/infra/callback";
import type { ChatCallbackPayload } from "../../../../../src/lib/infra/callback/callback-payloads";
import { publishUserSignal } from "../../../../../src/lib/infra/realtime/client";

const router = tsr.router(chatThreadV1SendContract, {
  send: async ({ body, headers }) => {
    const apiStartTime = Date.now();
    initServices();

    const authCtx = await requireApiKeyAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    let orgId: string;
    try {
      const { org } = await resolveOrg(authCtx);
      orgId = org.orgId;
    } catch (error) {
      if (isApiError(error)) {
        return {
          status: error.statusCode as 400 | 401 | 403 | 404,
          body: { error: { message: error.message, code: error.code } },
        };
      }
      throw error;
    }

    try {
      let threadId: string;
      let sessionId: string | undefined;
      let agentId: string;

      if (body.threadId) {
        const thread = await getChatThread(body.threadId, authCtx.userId);
        threadId = thread.id;
        agentId = thread.agentComposeId;
        sessionId = (await getLatestSessionIdForThread(thread.id)) ?? undefined;
      } else {
        const defaultAgentId = await resolveDefaultAgentId(orgId);
        if (!defaultAgentId) {
          return {
            status: 400 as const,
            body: {
              error: {
                message: "No default agent configured for this organization",
                code: "BAD_REQUEST",
              },
            },
          };
        }
        agentId = defaultAgentId;
        const thread = await createChatThread(authCtx.userId, agentId);
        threadId = thread.id;
      }

      const chatCallback: {
        url: string;
        secret: string;
        payload: ChatCallbackPayload;
      } = {
        url: getApiUrl() + "/api/internal/callbacks/chat",
        secret: generateCallbackSecret(),
        payload: { threadId, agentId },
      };

      const result = await createZeroRun({
        userId: authCtx.userId,
        prompt: body.prompt,
        agentId,
        sessionId,
        triggerSource: "web",
        appendSystemPrompt: buildWebChatPrompt(),
        callbacks: [chatCallback],
        chatThreadId: threadId,
        apiStartTime,
      });

      const userMessage = await insertChatMessage({
        chatThreadId: threadId,
        userId: authCtx.userId,
        role: "user",
        content: body.prompt,
        runId: result.runId,
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
          threadId,
          messageId: userMessage.id,
          runId: result.runId,
          status: result.status,
          createdAt: result.createdAt.toISOString(),
        },
      };
    } catch (error) {
      if (isNotFound(error)) {
        return {
          status: 404 as const,
          body: {
            error: { message: "Chat thread not found", code: "NOT_FOUND" },
          },
        };
      }
      if (isApiError(error)) {
        return {
          status: error.statusCode as 400 | 401 | 403 | 404,
          body: { error: { message: error.message, code: error.code } },
        };
      }
      throw error;
    }
  },
});

const handler = createHandler(chatThreadV1SendContract, router, {
  errorHandler: createSafeErrorHandler("v1-chat-thread-send"),
});

export { handler as POST };
