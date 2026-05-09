import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { chatThreadMessagesContract } from "@vm0/api-contracts/contracts/chat-threads";
import { initServices } from "../../../../../../src/lib/init-services";
import { getUserId } from "../../../../../../src/lib/auth/get-auth-context";
import {
  getChatThread,
  getPagedMessages,
  resolveAttachFileUrls,
} from "../../../../../../src/lib/zero/chat-thread";
import { formatChatRunErrorMessage } from "../../../../../../src/lib/zero/chat-thread/chat-run-error-message";
import { isNotFound } from "@vm0/api-services/errors";

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

      const page = await getPagedMessages(
        params.threadId,
        query.sinceId,
        query.beforeId,
        query.limit,
      );

      const messages = await Promise.all(
        page.messages.map(async (row) => {
          // Legacy placeholder rows (sequenceNumber IS NULL) fall back to runError;
          // event-backed rows and error rows use their own error field.
          const isLegacyPlaceholder =
            row.sequenceNumber === null && row.content === null && !row.error;
          const rawEffectiveError = isLegacyPlaceholder
            ? (row.runError ?? undefined)
            : (row.error ?? undefined);
          const effectiveError =
            rawEffectiveError && isLegacyPlaceholder && row.runId
              ? await formatChatRunErrorMessage({
                  chatThreadId: params.threadId,
                  runId: row.runId,
                  errorMessage: rawEffectiveError,
                })
              : rawEffectiveError;
          const attachFiles =
            row.attachFiles && row.attachFiles.length > 0
              ? await resolveAttachFileUrls(userId, row.attachFiles)
              : undefined;
          const role = row.role as "user" | "assistant";
          const message = {
            id: row.id,
            role,
            content: row.content,
            runId: row.runId ?? undefined,
            revokesMessageId: row.revokesMessageId ?? undefined,
            error: effectiveError,
            attachFiles,
            createdAt: row.createdAt.toISOString(),
          };
          if (role !== "assistant") {
            return {
              ...message,
              role: "user" as const,
            };
          }
          return {
            ...message,
            role: "assistant" as const,
            status: row.runStatus ?? undefined,
          };
        }),
      );

      return {
        status: 200 as const,
        body: { messages, hasHistoryBefore: page.hasHistoryBefore },
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
