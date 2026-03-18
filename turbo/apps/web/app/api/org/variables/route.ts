import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import {
  orgVariablesMainContract,
  createErrorResponse,
  ApiError,
} from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import {
  listOrgVariables,
  setOrgVariable,
} from "../../../../src/lib/variable/variable-service";
import { logger } from "../../../../src/lib/logger";
import { isBadRequest } from "../../../../src/lib/errors";

const log = logger("api:org-variables");

const router = tsr.router(orgVariablesMainContract, {
  /**
   * GET /api/org/variables - List org-level variables
   * Any org member can list.
   */
  list: async ({ headers }, { request }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(authCtx, orgSlug);
    const vars = await listOrgVariables(org.orgId);

    return {
      status: 200 as const,
      body: {
        variables: vars.map((v) => ({
          id: v.id,
          name: v.name,
          value: v.value,
          description: v.description,
          createdAt: v.createdAt.toISOString(),
          updatedAt: v.updatedAt.toISOString(),
        })),
      },
    };
  },

  /**
   * PUT /api/org/variables - Create or update an org-level variable
   * Admin only.
   */
  set: async ({ body, headers }, { request }) => {
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
        "Only admins can manage org variables",
      );
    }

    const { name, value, description } = body;

    log.debug("setting org variable", { orgId: org.orgId, name });

    try {
      const variable = await setOrgVariable(
        org.orgId,
        name,
        value,
        description,
      );

      return {
        status: 200 as const,
        body: {
          id: variable.id,
          name: variable.name,
          value: variable.value,
          description: variable.description,
          createdAt: variable.createdAt.toISOString(),
          updatedAt: variable.updatedAt.toISOString(),
        },
      };
    } catch (error) {
      if (isBadRequest(error)) {
        return createErrorResponse("BAD_REQUEST", "Invalid request");
      }
      throw error;
    }
  },
});

/**
 * Custom error handler for org variables API
 */
function errorHandler(err: unknown): TsRestResponse | void {
  if (
    err &&
    typeof err === "object" &&
    "bodyError" in err &&
    "queryError" in err
  ) {
    const validationError = err as {
      bodyError: { issues: Array<{ path: string[]; message: string }> } | null;
      queryError: { issues: Array<{ path: string[]; message: string }> } | null;
    };

    if (validationError.bodyError) {
      const issue = validationError.bodyError.issues[0];
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

const handler = createHandler(orgVariablesMainContract, router, {
  errorHandler,
});

export { handler as GET, handler as PUT };
