import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { sessionsByIdContract } from "@vm0/core";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { agentSessions } from "../../../../../src/db/schema/agent-session";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";

const router = tsr.router(sessionsByIdContract, {
  getById: async ({ params, headers }) => {
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

    const [session] = await globalThis.services.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, params.id))
      .limit(1);

    if (!session) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Session not found", code: "NOT_FOUND" },
        },
      };
    }

    // Check authorization - user can only access their own sessions
    if (session.userId !== userId) {
      return {
        status: 403 as const,
        body: {
          error: {
            message: "You do not have permission to access this session",
            code: "FORBIDDEN",
          },
        },
      };
    }

    return {
      status: 200 as const,
      body: {
        id: session.id,
        agentComposeId: session.agentComposeId,
        agentComposeVersionId: session.agentComposeVersionId,
        conversationId: session.conversationId,
        artifactName: session.artifactName,
        vars: session.vars,
        secretNames: session.secretNames,
        volumeVersions: session.volumeVersions,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
      },
    };
  },
});

/**
 * Custom error handler to convert validation errors to API error format
 */
function errorHandler(err: unknown): TsRestResponse | void {
  if (err && typeof err === "object" && "pathParamsError" in err) {
    const validationError = err as {
      pathParamsError: {
        issues: Array<{ path: string[]; message: string }>;
      } | null;
    };

    if (validationError.pathParamsError) {
      const issue = validationError.pathParamsError.issues[0];
      if (issue) {
        return TsRestResponse.fromJson(
          { error: { message: issue.message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }
  }

  return undefined;
}

const handler = createHandler(sessionsByIdContract, router, {
  errorHandler,
});

export { handler as GET };
