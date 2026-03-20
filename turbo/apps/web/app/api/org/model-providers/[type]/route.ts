/**
 * Backward-compatible route for DELETE /api/org/model-providers/:type.
 *
 * The CLI still uses the old contract (orgModelProvidersByTypeContract)
 * at this path. This route delegates to the shared service layer.
 *
 * Will be removed once the CLI contracts are migrated.
 */
import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import {
  orgModelProvidersByTypeContract,
  createErrorResponse,
} from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
import { deleteOrgModelProvider } from "../../../../../src/lib/model-provider/model-provider-service";
import { logger } from "../../../../../src/lib/logger";
import { isNotFound } from "../../../../../src/lib/errors";

const log = logger("api:org-model-providers-compat");

const router = tsr.router(orgModelProvidersByTypeContract, {
  delete: async ({ params, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org, member } = await resolveOrg(authCtx, orgSlug);

    if (member.role !== "admin") {
      return createErrorResponse(
        "FORBIDDEN",
        "Only admins can manage org model providers",
      );
    }

    log.debug("deleting org model provider (compat)", {
      orgId: org.orgId,
      type: params.type,
    });

    try {
      await deleteOrgModelProvider(org.orgId, params.type);

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

const handler = createHandler(orgModelProvidersByTypeContract, router, {
  errorHandler: createSafeErrorHandler("org-model-providers-compat"),
});

export { handler as DELETE };
