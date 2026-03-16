import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { sessionsContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { listAgentSessions } from "../../../../src/lib/agent-session";
import { verifyComposeOrgAccess } from "../../../../src/lib/org/verify-compose-org-access";

const router = tsr.router(sessionsContract, {
  list: async ({ query, headers }, { request }) => {
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

    // Verify the requested compose belongs to the caller's active org
    const hasOrgAccess = await verifyComposeOrgAccess(
      query.agentComposeId,
      userId,
      request.url,
    );
    if (!hasOrgAccess) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent not found", code: "NOT_FOUND" },
        },
      };
    }

    const sessions = await listAgentSessions(userId, query.agentComposeId);

    return {
      status: 200 as const,
      body: {
        sessions: sessions.map((s) => ({
          id: s.id,
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
          messageCount: s.messageCount,
          preview: s.preview,
        })),
      },
    };
  },
});

const handler = createHandler(sessionsContract, router);

export { handler as GET };
