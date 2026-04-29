import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { chatThreadArtifactsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { initServices } from "../../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { getChatThreadArtifacts } from "../../../../../../src/lib/zero/chat-thread";
import { isNotFound } from "@vm0/api-services/errors";

const router = tsr.router(chatThreadArtifactsContract, {
  list: async ({ params, headers }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    try {
      const runs = await getChatThreadArtifacts(
        params.threadId,
        authCtx.userId,
      );
      return { status: 200 as const, body: { runs } };
    } catch (error) {
      if (isNotFound(error)) {
        return createErrorResponse("NOT_FOUND", "Chat thread not found");
      }
      throw error;
    }
  },
});

const handler = createHandler(chatThreadArtifactsContract, router, {
  routeName: "zero.chat-threads.artifacts",
});

export { handler as GET };
