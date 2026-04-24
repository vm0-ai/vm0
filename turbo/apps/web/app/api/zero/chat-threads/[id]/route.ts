import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { chatThreadByIdContract } from "@vm0/core/contracts/chat-threads";
import { modelProviderTypeSchema } from "@vm0/core/contracts/model-providers";
import { z } from "zod";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserId } from "../../../../../src/lib/auth/get-auth-context";
import {
  getChatThread,
  getChatThreadMessages,
  getActiveRunsForThread,
  updateChatThreadDraft,
  deleteChatThread,
} from "../../../../../src/lib/zero/chat-thread";
import {
  getLatestRunProviderTypeForThread,
  publishThreadListChanged,
} from "../../../../../src/lib/zero/chat-thread/chat-message-service";
import { isNotFound } from "../../../../../src/lib/shared/errors";

const chatThreadIdParamSchema = z.string().uuid();

function isValidChatThreadId(id: string): boolean {
  return chatThreadIdParamSchema.safeParse(id).success;
}

function chatThreadNotFoundResponse() {
  return {
    status: 404 as const,
    body: {
      error: { message: "Chat thread not found", code: "NOT_FOUND" },
    },
  };
}

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

    if (!isValidChatThreadId(params.id)) {
      return chatThreadNotFoundResponse();
    }

    try {
      const thread = await getChatThread(params.id, userId);
      const [
        { chatMessages, latestSessionId },
        activeRuns,
        latestRunProviderTypeRaw,
      ] = await Promise.all([
        getChatThreadMessages(params.id, userId),
        getActiveRunsForThread(params.id),
        getLatestRunProviderTypeForThread(params.id),
      ]);
      const activeRunIds = activeRuns.map((r) => {
        return r.id;
      });
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
          activeRuns,
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
        return chatThreadNotFoundResponse();
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

    if (!isValidChatThreadId(params.id)) {
      return chatThreadNotFoundResponse();
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
        return chatThreadNotFoundResponse();
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

    if (!isValidChatThreadId(params.id)) {
      return chatThreadNotFoundResponse();
    }

    try {
      await deleteChatThread(params.id, userId);
      await publishThreadListChanged(userId);
      return { status: 204 as const, body: undefined };
    } catch (error) {
      if (isNotFound(error)) {
        return chatThreadNotFoundResponse();
      }
      throw error;
    }
  },
});

const handler = createHandler(chatThreadByIdContract, router, {
  routeName: "zero.chat-threads.byId",
});

export { handler as GET, handler as PATCH, handler as DELETE };
