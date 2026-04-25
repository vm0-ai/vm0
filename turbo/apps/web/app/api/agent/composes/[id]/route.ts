import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { composesByIdContract } from "@vm0/api-contracts/contracts/composes";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { isSandboxAuth } from "../../../../../src/lib/auth/capability-check";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import {
  getComposeById,
  getComposeOrgId,
  deleteCompose,
} from "../../../../../src/lib/infra/agent-compose/compose-service";
import { isNotFound, isConflict } from "../../../../../src/lib/shared/errors";

const router = tsr.router(composesByIdContract, {
  getById: async ({ params, headers }) => {
    initServices();

    const authResult = await requireAuth(headers.authorization, {
      acceptAnySandboxCapability: true,
    });
    if (isAuthError(authResult)) return authResult;
    const { userId } = authResult;

    // Sandbox tokens lack org context — pass compose's own orgId to satisfy
    // the canAccessCompose org check. Standard auth resolves org normally.
    let orgId: string;
    if (isSandboxAuth(authResult)) {
      // Sandbox: derive orgId from the compose itself (deferred to service)
      // canAccessCompose(userId, compose.orgId, compose) always matches on orgId
      orgId = await getComposeOrgId(params.id);
    } else {
      orgId = (await resolveOrg(authResult)).org.orgId;
    }

    try {
      const compose = await getComposeById(params.id, userId, orgId);
      return { status: 200 as const, body: compose };
    } catch (error) {
      if (isNotFound(error)) {
        return {
          status: 404 as const,
          body: {
            error: { message: "Agent compose not found", code: "NOT_FOUND" },
          },
        };
      }
      throw error;
    }
  },

  delete: async ({ params, headers }) => {
    initServices();

    const authResult = await requireAuth(headers.authorization, {
      acceptAnySandboxCapability: true,
    });
    if (isAuthError(authResult)) return authResult;
    const { userId } = authResult;

    // Block sandbox tokens — agents cannot delete other agents
    if (isSandboxAuth(authResult)) {
      return {
        status: 403 as const,
        body: {
          error: {
            message: "Agent deletion is not available from sandbox",
            code: "FORBIDDEN",
          },
        },
      };
    }

    try {
      await deleteCompose(params.id, userId);
      return { status: 204 as const, body: undefined };
    } catch (error) {
      if (isNotFound(error)) {
        return {
          status: 404 as const,
          body: { error: { message: "Agent not found", code: "NOT_FOUND" } },
        };
      }
      if (isConflict(error)) {
        return {
          status: 409 as const,
          body: { error: { message: error.message, code: "CONFLICT" } },
        };
      }
      throw error;
    }
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

const handler = createHandler(composesByIdContract, router, {
  routeName: "agent.composes.byId",
  errorHandler,
});

export { handler as GET, handler as DELETE };
