import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { chatThreadByIdContract, modelProviderTypeSchema } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserId } from "../../../../../src/lib/auth/get-auth-context";
import {
  getChatThread,
  getChatThreadMessages,
  getActiveRunIdsForThread,
  updateChatThreadDraft,
  deleteChatThread,
} from "../../../../../src/lib/zero/chat-thread";
import {
  getLatestRunProviderTypeForThread,
  publishThreadListChanged,
} from "../../../../../src/lib/zero/chat-thread/chat-message-service";
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
      const [
        { chatMessages, latestSessionId },
        activeRunIds,
        latestRunProviderTypeRaw,
      ] = await Promise.all([
        getChatThreadMessages(params.id, userId),
        getActiveRunIdsForThread(params.id),
        getLatestRunProviderTypeForThread(params.id),
      ]);
      // Narrow to the canonical type enum; a stale/unknown value is treated
      // as "no prior session" so the composer picker stays unconstrained.
      const latestSessionProviderType =
        latestRunProviderTypeRaw === null
          ? null
          : (modelProviderTypeSchema.safeParse(latestRunProviderTypeRaw).data ??
            null);

      return {
        status: 200 as const,
        body: {
          id: thread.id,
          title: thread.title,
          agentId: thread.agentComposeId,
          chatMessages,
          latestSessionId,
          latestSessionProviderType,
          activeRunIds,
          createdAt: thread.createdAt.toISOString(),
          updatedAt: thread.updatedAt.toISOString(),
          draftContent: thread.draftContent,
          draftAttachments: thread.draftAttachments,
          modelProviderId: thread.modelProviderId,
          selectedModel: thread.selectedModel,
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
      await publishThreadListChanged(userId);
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
