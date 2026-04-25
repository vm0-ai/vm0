import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { chatThreadV1MessagesContract } from "@vm0/api-contracts/contracts/chat-threads-v1";
import { z } from "zod";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireApiKeyAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import {
  getChatThread,
  getPagedMessages,
} from "../../../../../../src/lib/zero/chat-thread";
import { isNotFound } from "../../../../../../src/lib/shared/errors";

const messageRoleSchema = z.enum(["user", "assistant"]);

const router = tsr.router(chatThreadV1MessagesContract, {
  list: async ({ params, query, headers }) => {
    initServices();

    const authCtx = await requireApiKeyAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    try {
      // Ownership check — throws notFound if the user does not own the thread
      await getChatThread(params.threadId, authCtx.userId);

      const page = await getPagedMessages(
        params.threadId,
        query.sinceId,
        query.beforeId,
        query.limit,
      );

      const messages = page.messages.map((row) => {
        // Legacy placeholder rows (sequenceNumber IS NULL) fall back to runError;
        // event-backed rows and error rows use their own error field.
        const isLegacyPlaceholder =
          row.sequenceNumber === null && row.content === null && !row.error;
        const effectiveError = isLegacyPlaceholder
          ? (row.runError ?? undefined)
          : (row.error ?? undefined);
        return {
          id: row.id,
          role: messageRoleSchema.parse(row.role),
          content: row.content,
          error: effectiveError,
          createdAt: row.createdAt.toISOString(),
        };
      });

      return { status: 200 as const, body: { messages } };
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

const handler = createHandler(chatThreadV1MessagesContract, router, {
  routeName: "v1.chat-threads.messages",
});

export { handler as GET };
