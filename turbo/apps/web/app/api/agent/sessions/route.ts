import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { sessionsContract } from "@vm0/core";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { listSessionsWithMessages } from "../../../../src/lib/zero/zero-session-service";
import { agentComposes } from "../../../../src/db/schema/agent-compose";

const router = tsr.router(sessionsContract, {
  list: async ({ query, headers }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }
    const { userId } = authCtx;

    // Verify the requested compose belongs to the caller's active org
    const [compose] = await globalThis.services.db
      .select({ orgId: agentComposes.orgId })
      .from(agentComposes)
      .where(eq(agentComposes.id, query.agentComposeId))
      .limit(1);

    if (!compose) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent not found", code: "NOT_FOUND" },
        },
      };
    }

    const callerOrgId = authCtx.orgId ?? null;
    if (callerOrgId !== compose.orgId) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent not found", code: "NOT_FOUND" },
        },
      };
    }

    const sessions = await listSessionsWithMessages(
      userId,
      query.agentComposeId,
    );

    return {
      status: 200 as const,
      body: {
        sessions: sessions.map((s) => {
          return {
            id: s.id,
            createdAt: s.createdAt.toISOString(),
            updatedAt: s.updatedAt.toISOString(),
            messageCount: s.messageCount,
            preview: s.preview,
          };
        }),
      },
    };
  },
});

const handler = createHandler(sessionsContract, router);

export { handler as GET };
