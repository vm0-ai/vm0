import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { sessionsByIdContract, extractAndGroupVariables } from "@vm0/core";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { agentSessions } from "../../../../../src/db/schema/agent-session";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../src/db/schema/agent-compose";

const router = tsr.router(sessionsByIdContract, {
  getById: async ({ params, headers }) => {
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

    const callerOrgId = authCtx.orgId ?? null;
    if (!callerOrgId) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Session not found", code: "NOT_FOUND" },
        },
      };
    }

    const db = globalThis.services.db;

    const [session] = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, params.id))
      .limit(1);

    if (!session) {
      return {
        status: 404 as const,
        body: { error: { message: "Session not found", code: "NOT_FOUND" } },
      };
    }

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

    if (callerOrgId !== session.orgId) {
      return {
        status: 404 as const,
        body: { error: { message: "Session not found", code: "NOT_FOUND" } },
      };
    }

    // Extract secret names from HEAD compose content
    let secretNames: string[] | null = null;
    const [compose] = await db
      .select()
      .from(agentComposes)
      .where(eq(agentComposes.id, session.agentComposeId))
      .limit(1);

    if (compose?.headVersionId) {
      const [version] = await db
        .select()
        .from(agentComposeVersions)
        .where(eq(agentComposeVersions.id, compose.headVersionId))
        .limit(1);

      if (version?.content) {
        const grouped = extractAndGroupVariables(version.content);
        const names = grouped.secrets.map((ref) => {
          return ref.name;
        });
        secretNames = names.length > 0 ? names : null;
      }
    }

    return {
      status: 200 as const,
      body: {
        id: session.id,
        agentComposeId: session.agentComposeId,
        conversationId: session.conversationId,
        artifactName: session.artifactName,
        secretNames,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
      },
    };
  },
});

interface PathParamsValidationError {
  pathParamsError: {
    issues: Array<{ path: string[]; message: string }>;
  } | null;
}

function isPathParamsError(err: unknown): err is PathParamsValidationError {
  return (
    err !== null &&
    typeof err === "object" &&
    "pathParamsError" in err &&
    (err.pathParamsError === null ||
      (typeof err.pathParamsError === "object" &&
        err.pathParamsError !== null &&
        "issues" in err.pathParamsError &&
        Array.isArray(err.pathParamsError.issues)))
  );
}

/**
 * Custom error handler to convert validation errors to API error format
 */
function errorHandler(err: unknown): TsRestResponse | void {
  if (isPathParamsError(err) && err.pathParamsError) {
    const issue = err.pathParamsError.issues[0];
    if (issue) {
      return TsRestResponse.fromJson(
        { error: { message: issue.message, code: "BAD_REQUEST" } },
        { status: 400 },
      );
    }
  }

  return undefined;
}

const handler = createHandler(sessionsByIdContract, router, {
  routeName: "agent.sessions.byId",
  errorHandler,
});

export { handler as GET };
