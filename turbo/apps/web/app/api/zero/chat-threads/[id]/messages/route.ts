import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../../src/lib/ts-rest-handler";
import { chatThreadMessagesContract } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import { getUserId } from "../../../../../../src/lib/auth/get-auth-context";
import {
  getChatThread,
  getChatThreadMessagesSince,
} from "../../../../../../src/lib/zero/chat-thread";
import { isNotFound } from "../../../../../../src/lib/shared/errors";

const router = tsr.router(chatThreadMessagesContract, {
  list: async ({ params, query, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    try {
      // Ownership check — throws notFound if thread doesn't belong to user
      await getChatThread(params.id, userId);

      const messages = await getChatThreadMessagesSince(
        params.id,
        query.sinceId,
      );

      return {
        status: 200 as const,
        body: { messages },
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

const handler = createHandler(chatThreadMessagesContract, router, {
  errorHandler: createSafeErrorHandler("zero-chat-thread-messages"),
});

export { handler as GET };
