/**
 * Backward-compatible route for POST /api/org/model-providers/:type/set-default.
 *
 * The CLI still uses the old contract (orgModelProvidersSetDefaultContract)
 * at this path. This route delegates to the shared service layer.
 *
 * Will be removed once the CLI contracts are migrated.
 */
import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../../src/lib/ts-rest-handler";
import {
  orgModelProvidersSetDefaultContract,
  createErrorResponse,
} from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../../src/lib/org/resolve-org";
import { setOrgModelProviderDefault } from "../../../../../../src/lib/model-provider/model-provider-service";
import { logger } from "../../../../../../src/lib/logger";
import { isNotFound } from "../../../../../../src/lib/errors";

const log = logger("api:org-model-providers-compat");

const router = tsr.router(orgModelProvidersSetDefaultContract, {
  setDefault: async ({ params, headers }, { request }) => {
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

    log.debug("setting org model provider as default (compat)", {
      orgId: org.orgId,
      type: params.type,
    });

    try {
      const provider = await setOrgModelProviderDefault(org.orgId, params.type);

      return {
        status: 200 as const,
        body: {
          id: provider.id,
          type: provider.type,
          framework: provider.framework,
          secretName: provider.secretName,
          authMethod: provider.authMethod ?? null,
          secretNames: provider.secretNames ?? null,
          isDefault: provider.isDefault,
          selectedModel: provider.selectedModel,
          createdAt: provider.createdAt.toISOString(),
          updatedAt: provider.updatedAt.toISOString(),
        },
      };
    } catch (error) {
      if (isNotFound(error)) {
        return createErrorResponse("NOT_FOUND", "Resource not found");
      }
      throw error;
    }
  },
});

const handler = createHandler(orgModelProvidersSetDefaultContract, router, {
  errorHandler: createSafeErrorHandler("org-model-providers-compat"),
});

export { handler as POST };
