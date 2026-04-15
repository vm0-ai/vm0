import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { chatThreadByIdContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserId } from "../../../../../src/lib/auth/get-auth-context";
import {
  getChatThread,
  getChatThreadMessages,
  updateChatThreadDraft,
  deleteChatThread,
} from "../../../../../src/lib/zero/chat-thread";
import { isNotFound } from "../../../../../src/lib/shared/errors";

const router = tsr.router(chatThreadByIdContract, {
  get: async ({ params, headers }) => {
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
      const thread = await getChatThread(params.id, userId);
      const { chatMessages, latestSessionId } = await getChatThreadMessages(
        params.id,
        userId,
      );

      return {
        status: 200 as const,
        body: {
          id: thread.id,
          title: thread.title,
          agentId: thread.agentComposeId,
          chatMessages,
          latestSessionId,
          createdAt: thread.createdAt.toISOString(),
          updatedAt: thread.updatedAt.toISOString(),
          draftContent: thread.draftContent,
          draftAttachments: thread.draftAttachments,
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
  patch: async ({ params, headers, body }) => {
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
      await updateChatThreadDraft(
        params.id,
        userId,
        body.draftContent ?? null,
        body.draftAttachments ?? null,
      );
      return { status: 204 as const, body: undefined };
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
  delete: async ({ params, headers }) => {
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
      await deleteChatThread(params.id, userId);
      return { status: 204 as const, body: undefined };
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

const handler = createHandler(chatThreadByIdContract, router, {
  errorHandler: createSafeErrorHandler("zero-chat-thread-by-id"),
});

export { handler as GET, handler as PATCH, handler as DELETE };
