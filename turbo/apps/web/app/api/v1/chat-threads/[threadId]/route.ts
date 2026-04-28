import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { chatThreadV1GetContract } from "@vm0/api-contracts/contracts/chat-threads-v1";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireApiKeyAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { getChatThread } from "../../../../../src/lib/zero/chat-thread";
import { isNotFound } from "@vm0/api-services/errors";

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
  routeName: "v1.chat-threads.byId",
  shadowCompareApi: true,
});

export { handler as GET };
