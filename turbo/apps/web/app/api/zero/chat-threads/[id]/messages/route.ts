import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { chatThreadMessagesContract } from "@vm0/core/contracts/chat-threads";
import { initServices } from "../../../../../../src/lib/init-services";
import { getUserId } from "../../../../../../src/lib/auth/get-auth-context";
import {
  getChatThread,
  getMessagesBefore,
  getMessagesFromLastUserMessage,
  getMessagesSince,
  resolveAttachFileUrls,
  type MessageRow,
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
      // Ownership check — throws notFound if user doesn't own the thread
      await getChatThread(params.threadId, userId);

      let rows: MessageRow[];
      let hasMore: boolean | undefined;

      if (query.beforeId) {
        const result = await getMessagesBefore(
          params.threadId,
          query.beforeId,
          query.limit,
        );
        rows = result.messages;
        hasMore = result.hasMore;
      } else if (query.sinceId) {
        rows = await getMessagesSince(
          params.threadId,
          query.sinceId,
          query.limit,
        );
      } else {
        const result = await getMessagesFromLastUserMessage(params.threadId);
        rows = result.messages;
        hasMore = result.hasMore;
      }

      const messages = await Promise.all(
        rows.map(async (row) => {
          // Legacy placeholder rows (sequenceNumber IS NULL) fall back to runError;
          // event-backed rows and error rows use their own error field.
          const isLegacyPlaceholder =
            row.sequenceNumber === null && row.content === null && !row.error;
          const effectiveError = isLegacyPlaceholder
            ? (row.runError ?? undefined)
            : (row.error ?? undefined);
          const attachFiles =
            row.attachFiles && row.attachFiles.length > 0
              ? await resolveAttachFileUrls(userId, row.attachFiles)
              : undefined;
          return {
            id: row.id,
            role: row.role as "user" | "assistant",
            content: row.content,
            runId: row.runId ?? undefined,
            error: effectiveError,
            status: row.runStatus ?? undefined,
            attachFiles,
            createdAt: row.createdAt.toISOString(),
          };
        }),
      );

      return {
        status: 200 as const,
        body: { messages, ...(hasMore !== undefined ? { hasMore } : {}) },
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
  routeName: "zero.chat-threads.messages",
});

export { handler as GET };
