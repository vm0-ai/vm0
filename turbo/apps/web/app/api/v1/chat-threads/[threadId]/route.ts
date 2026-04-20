import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { chatThreadV1GetContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireApiKeyAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { getChatThread } from "../../../../../src/lib/zero/chat-thread";
import { isNotFound } from "../../../../../src/lib/shared/errors";

const router = tsr.router(chatThreadV1GetContract, {
  get: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireApiKeyAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    try {
      const thread = await getChatThread(params.threadId, authCtx.userId);
      return {
        status: 200 as const,
        body: {
          id: thread.id,
          title: thread.title,
          createdAt: thread.createdAt.toISOString(),
          updatedAt: thread.updatedAt.toISOString(),
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
      throw error;
    }
  },
});

const handler = createHandler(chatThreadV1GetContract, router, {
  errorHandler: createSafeErrorHandler("v1-chat-thread-get"),
});

export { handler as GET };
