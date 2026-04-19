import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../../src/lib/ts-rest-handler";
import { chatThreadMarkReadContract } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import { getUserId } from "../../../../../../src/lib/auth/get-auth-context";
import { markThreadRead } from "../../../../../../src/lib/zero/chat-thread";
import { isNotFound } from "../../../../../../src/lib/shared/errors";
import { publishUserSignal } from "../../../../../../src/lib/infra/realtime/client";

const router = tsr.router(chatThreadMarkReadContract, {
  markRead: async ({ params, headers, body }) => {
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

    const cursor = body.cursor ? new Date(body.cursor) : undefined;

    try {
      const newLastReadAt = await markThreadRead(userId, params.id, cursor);

      await publishUserSignal(
        [userId],
        `chatThreadReadCursorUpdated:${params.id}`,
        { lastReadAt: newLastReadAt.toISOString() },
      );

      return {
        status: 200 as const,
        body: { lastReadAt: newLastReadAt.toISOString() },
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

const handler = createHandler(chatThreadMarkReadContract, router, {
  errorHandler: createSafeErrorHandler("zero-chat-thread-mark-read"),
});

export { handler as POST };
