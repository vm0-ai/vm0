import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { chatThreadUnpinContract } from "@vm0/api-contracts/contracts/chat-threads";
import { initServices } from "../../../../../../src/lib/init-services";
import { getUserId } from "../../../../../../src/lib/auth/get-auth-context";
import { unpinChatThread } from "../../../../../../src/lib/zero/chat-thread";
import { publishThreadListChanged } from "../../../../../../src/lib/zero/chat-thread/chat-message-service";
import { isNotFound } from "@vm0/api-services/errors";

const router = tsr.router(chatThreadUnpinContract, {
  unpin: async ({ params, headers }) => {
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
      await unpinChatThread(params.id, userId);
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

const handler = createHandler(chatThreadUnpinContract, router, {
  routeName: "zero.chat-threads.unpin",
});

export { handler as POST };
