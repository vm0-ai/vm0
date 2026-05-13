import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { chatThreadByIdContract } from "@vm0/api-contracts/contracts/chat-threads";
import {
  modelProviderCredentialScopeSchema,
  modelProviderTypeSchema,
} from "@vm0/api-contracts/contracts/model-providers";
import { z } from "zod";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserId } from "../../../../../src/lib/auth/get-auth-context";
import {
  getChatThread,
  getFirstRunModelPinForThread,
  getChatThreadMessages,
  getActiveRunsForThread,
  updateChatThreadDraft,
  deleteChatThread,
} from "../../../../../src/lib/zero/chat-thread";
import {
  getLatestRunProviderTypeForThread,
  publishThreadListChanged,
} from "../../../../../src/lib/zero/chat-thread/chat-message-service";
import { isNotFound } from "@vm0/api-services/errors";

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

type ChatThreadRecord = Awaited<ReturnType<typeof getChatThread>>;
type ModelFirstRunPin = Awaited<
  ReturnType<typeof getFirstRunModelPinForThread>
>;

async function getModelFirstRunPinForThreadDetail(
  thread: ChatThreadRecord,
  threadId: string,
): Promise<ModelFirstRunPin> {
  if (!thread.orgId || thread.selectedModel !== null) {
    return null;
  }
  return getFirstRunModelPinForThread(threadId);
}

function parseThreadProviderType(value: string | null) {
  if (value === null) {
    return null;
  }
  return modelProviderTypeSchema.safeParse(value).data ?? null;
}

function parseThreadCredentialScope(value: string | null) {
  if (value === null) {
    return null;
  }
  return modelProviderCredentialScopeSchema.safeParse(value).data ?? null;
}

function resolveThreadModelFields(
  thread: ChatThreadRecord,
  modelFirstRunPin: ModelFirstRunPin,
) {
  const modelProviderCredentialScope =
    modelFirstRunPin?.modelProviderCredentialScope ??
    thread.modelProviderCredentialScope;
  const modelProviderType =
    modelFirstRunPin?.modelProviderType ?? thread.modelProviderType;

  return {
    modelProviderId:
      modelFirstRunPin?.modelProviderId ?? thread.modelProviderId,
    modelProviderType: parseThreadProviderType(modelProviderType),
    modelProviderCredentialScope: parseThreadCredentialScope(
      modelProviderCredentialScope,
    ),
    selectedModel: modelFirstRunPin?.selectedModel ?? thread.selectedModel,
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
        modelFirstRunPin,
      ] = await Promise.all([
        getChatThreadMessages(params.id, userId),
        getActiveRunsForThread(params.id),
        getLatestRunProviderTypeForThread(params.id),
        getModelFirstRunPinForThreadDetail(thread, params.id),
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
      const threadModelFields = resolveThreadModelFields(
        thread,
        modelFirstRunPin,
      );

      return {
        status: 200 as const,
        body: {
          id: thread.id,
          title: thread.title,
          agentId: thread.agentComposeId,
          chatMessages,
          latestSessionId,
          lastReadMessageId: thread.lastReadMessageId,
          latestSessionProviderType,
          activeRunIds,
          activeRuns,
          createdAt: thread.createdAt.toISOString(),
          updatedAt: thread.updatedAt.toISOString(),
          draftContent: thread.draftContent,
          draftAttachments: thread.draftAttachments,
          ...threadModelFields,
          renamedAt: thread.renamedAt ? thread.renamedAt.toISOString() : null,
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
