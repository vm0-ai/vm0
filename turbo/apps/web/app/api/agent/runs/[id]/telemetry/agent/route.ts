import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../../../src/lib/ts-rest-handler";
import { runAgentEventsContract } from "@vm0/core";
import { initServices } from "../../../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../../../src/lib/zero/org/resolve-org";
import { getRunAgentEvents } from "../../../../../../../src/lib/infra/run/run-telemetry-service";
import { isNotFound } from "../../../../../../../src/lib/shared/errors";

const router = tsr.router(runAgentEventsContract, {
  getAgentEvents: async ({ params, query, headers }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization, {
      acceptAnySandboxCapability: true,
    });
    if (!authCtx) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);

    try {
      const result = await getRunAgentEvents(
        params.id,
        userId,
        org.orgId,
        query,
      );
      return { status: 200 as const, body: result };
    } catch (error) {
      if (isNotFound(error)) {
        return {
          status: 404 as const,
          body: {
            error: { message: "Agent run not found", code: "NOT_FOUND" },
          },
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
  if (
    err &&
    typeof err === "object" &&
    ("pathParamsError" in err || "queryError" in err)
  ) {
    const validationError = err as {
      pathParamsError: {
        issues: Array<{ path: string[]; message: string }>;
      } | null;
      queryError: {
        issues: Array<{ path: string[]; message: string }>;
      } | null;
    };

    if (validationError.pathParamsError) {
      const issue = validationError.pathParamsError.issues[0];
      if (issue) {
        const path = issue.path.join(".");
        const message = path ? `${path}: ${issue.message}` : issue.message;
        return TsRestResponse.fromJson(
          { error: { message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }

    if (validationError.queryError) {
      const issue = validationError.queryError.issues[0];
      if (issue) {
        const path = issue.path.join(".");
        const message = path ? `${path}: ${issue.message}` : issue.message;
        return TsRestResponse.fromJson(
          { error: { message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }
  }

  return undefined;
}

const handler = createHandler(runAgentEventsContract, router, {
  routeName: "agent.runs.telemetry.agent",
  errorHandler,
});

export { handler as GET };
