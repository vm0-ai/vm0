import { eq } from "drizzle-orm";
import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import { zeroRunsMainContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { createZeroRun } from "../../../../src/lib/zero/zero-run-service";
import { handleCreateRunError } from "../../../../src/lib/zero/zero-run-errors";
import { zeroAgents } from "../../../../src/db/schema/zero-agent";
import { agentSessions } from "../../../../src/db/schema/agent-session";

const router = tsr.router(zeroRunsMainContract, {
  create: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent-run:write",
    });
    if (isAuthError(authCtx)) return authCtx;

    try {
      let agentId = body.agentId;

      // Infer agentId from session when not provided directly
      if (!agentId && body.sessionId) {
        const [session] = await globalThis.services.db
          .select({ agentComposeId: agentSessions.agentComposeId })
          .from(agentSessions)
          .where(eq(agentSessions.id, body.sessionId))
          .limit(1);

        if (!session) {
          return {
            status: 404 as const,
            body: {
              error: {
                message: "Session not found",
                code: "NOT_FOUND" as const,
              },
            },
          };
        }
        agentId = session.agentComposeId;
      }

      if (!agentId) {
        return {
          status: 400 as const,
          body: {
            error: {
              message: "agentId is required",
              code: "BAD_REQUEST" as const,
            },
          },
        };
      }

      // Verify agent exists — agentId is the composeId (= zeroAgents PK)
      const [agent] = await globalThis.services.db
        .select({ id: zeroAgents.id })
        .from(zeroAgents)
        .where(eq(zeroAgents.id, agentId))
        .limit(1);

      if (!agent) {
        return {
          status: 404 as const,
          body: {
            error: { message: "Agent not found", code: "NOT_FOUND" as const },
          },
        };
      }

      const result = await createZeroRun({
        userId: authCtx.userId,
        prompt: body.prompt,
        agentId: agent.id,
        sessionId: body.sessionId,
        appendSystemPrompt: body.appendSystemPrompt,
        modelProvider: body.modelProvider,
        triggerSource: authCtx.runId ? "agent" : "web",
      });

      return {
        status: 201 as const,
        body: {
          runId: result.runId,
          status: result.status,
          sandboxId: result.sandboxId,
          createdAt: result.createdAt.toISOString(),
        },
      };
    } catch (error) {
      const errorResponse = handleCreateRunError(error);
      if (errorResponse) {
        return errorResponse;
      }
      throw error;
    }
  },
});

const handler = createHandler(zeroRunsMainContract, router, {
  errorHandler: createSafeErrorHandler("zero-runs"),
});

export { handler as POST };
