import { createNextHandler, tsr } from "@ts-rest/serverless/next";
import { sessionsMainContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { agentSessionService } from "../../../../src/lib/agent-session";

const router = tsr.router(sessionsMainContract, {
  list: async () => {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    // Get all sessions for user
    const sessions = await agentSessionService.getByUserId(userId);

    return {
      status: 200 as const,
      body: {
        sessions: sessions.map((s) => ({
          id: s.id,
          userId: s.userId,
          agentComposeId: s.agentComposeId,
          conversationId: s.conversationId,
          artifactName: s.artifactName,
          templateVars: s.templateVars,
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
        })),
      },
    };
  },
});

const handler = createNextHandler(sessionsMainContract, router, {
  handlerType: "app-router",
  jsonQuery: true,
});

export { handler as GET };
