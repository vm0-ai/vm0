import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import {
  orgSecretsMainContract,
  createErrorResponse,
  ApiError,
} from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-user-id";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import {
  listOrgSecrets,
  setOrgSecret,
} from "../../../../src/lib/secret/secret-service";
import { logger } from "../../../../src/lib/logger";
import { isBadRequest } from "../../../../src/lib/errors";

const log = logger("api:org-secrets");

const router = tsr.router(orgSecretsMainContract, {
  /**
   * GET /api/org/secrets - List org-level secrets
   * Any org member can list.
   */
  list: async ({ headers }, { request }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }
    const { userId } = authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(userId, orgSlug);
    const secrets = await listOrgSecrets(org.orgId);

    return {
      status: 200 as const,
      body: {
        secrets: secrets.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          type: s.type,
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
        })),
      },
    };
  },

  /**
   * PUT /api/org/secrets - Create or update an org-level secret
   * Admin only.
   */
  set: async ({ body, headers }, { request }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }
    const { userId } = authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org, member } = await resolveOrg(userId, orgSlug);

    if (member.role !== "admin") {
      return createErrorResponse(
        "FORBIDDEN",
        "Only admins can manage org secrets",
      );
    }

    const { name, value, description } = body;

    log.debug("setting org secret", { orgId: org.orgId, name });

    try {
      const secret = await setOrgSecret(org.orgId, name, value, description);

      return {
        status: 200 as const,
        body: {
          id: secret.id,
          name: secret.name,
          description: secret.description,
          type: secret.type,
          createdAt: secret.createdAt.toISOString(),
          updatedAt: secret.updatedAt.toISOString(),
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
 * Custom error handler for org secrets API
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

const handler = createHandler(orgSecretsMainContract, router, {
  errorHandler,
});

export { handler as GET, handler as PUT };
