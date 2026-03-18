import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import {
  orgSecretsByNameContract,
  createErrorResponse,
  ApiError,
} from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-user-id";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
import { deleteOrgSecret } from "../../../../../src/lib/secret/secret-service";
import { logger } from "../../../../../src/lib/logger";
import { isNotFound } from "../../../../../src/lib/errors";

const log = logger("api:org-secrets");

const router = tsr.router(orgSecretsByNameContract, {
  /**
   * DELETE /api/org/secrets/:name - Delete an org-level secret
   * Admin only.
   */
  delete: async ({ params, headers }, { request }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org, member } = await resolveOrg(authCtx, orgSlug);

    if (member.role !== "admin") {
      return createErrorResponse(
        "FORBIDDEN",
        "Only admins can manage org secrets",
      );
    }

    log.debug("deleting org secret", { orgId: org.orgId, name: params.name });

    try {
      await deleteOrgSecret(org.orgId, params.name);

      return {
        status: 204 as const,
        body: undefined,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return createErrorResponse("NOT_FOUND", "Resource not found");
      }
      throw error;
    }
  },
});

/**
 * Custom error handler for org secrets by name API
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
          {
            error: { message: issue.message, code: ApiError.BAD_REQUEST.code },
          },
          { status: ApiError.BAD_REQUEST.status },
        );
      }
    }
  }

  return undefined;
}

const handler = createHandler(orgSecretsByNameContract, router, {
  errorHandler,
});

export { handler as DELETE };
