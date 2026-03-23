import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../../src/lib/ts-rest-handler";
import { chatThreadRegenerateTitleContract } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import { getUserId } from "../../../../../../src/lib/auth/get-auth-context";
import {
  getChatThread,
  updateChatThreadTitle,
} from "../../../../../../src/lib/chat-thread";
import { isNotFound } from "../../../../../../src/lib/errors";
import { generateChatTitle } from "../../../../../../src/lib/ai/lightweight-model";
import { logger } from "../../../../../../src/lib/logger";

const log = logger("zero-chat-threads:regenerate-title");

const router = tsr.router(chatThreadRegenerateTitleContract, {
  regenerateTitle: async ({ params, body, headers }) => {
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
      await getChatThread(params.id, userId);
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

    const aiTitle = await generateChatTitle(body.prompt);
    if (!aiTitle) {
      log.warn("Title generation unavailable", { threadId: params.id });
      return {
        status: 404 as const,
        body: {
          error: {
            message: "Title generation unavailable",
            code: "NOT_FOUND",
          },
        },
      };
    }

    await updateChatThreadTitle(params.id, aiTitle);

    return {
      status: 200 as const,
      body: { title: aiTitle },
    };
  },
});

const handler = createHandler(chatThreadRegenerateTitleContract, router, {
  errorHandler: createSafeErrorHandler("zero-chat-thread-regenerate-title"),
});

export { handler as POST };
