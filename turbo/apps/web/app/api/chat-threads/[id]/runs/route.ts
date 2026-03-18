import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { chatThreadRunsContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserId } from "../../../../../src/lib/auth/get-auth-context";
import { addRunToThread } from "../../../../../src/lib/chat-thread";
import { isNotFound } from "../../../../../src/lib/errors";

const router = tsr.router(chatThreadRunsContract, {
  addRun: async ({ params, body, headers }) => {
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
      await addRunToThread(params.id, body.runId, userId);

      return {
        status: 204 as const,
        body: undefined,
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

const handler = createHandler(chatThreadRunsContract, router);

export { handler as POST };
