import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import {
  modelProvidersCheckContract,
  createErrorResponse,
  getSecretNameForType,
} from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-user-id";
import { resolveScope } from "../../../../../src/lib/scope/resolve-scope";
import { checkSecretExists } from "../../../../../src/lib/model-provider/model-provider-service";

const router = tsr.router(modelProvidersCheckContract, {
  /**
   * GET /api/model-providers/check/:type - Check if secret exists
   */
  check: async ({ params, headers }, { request }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }
    const { userId, scopeId: tokenScopeId } = authCtx;

    const scopeSlug = new URL(request.url).searchParams.get("scope");
    const orgParam = new URL(request.url).searchParams.get("org");
    const { scope } = await resolveScope(
      userId,
      scopeSlug,
      orgParam,
      tokenScopeId,
    );
    const result = await checkSecretExists(
      scope.clerkOrgId,
      userId,
      params.type,
    );

    return {
      status: 200 as const,
      body: {
        exists: result.exists,
        secretName: getSecretNameForType(params.type) ?? "",
        // Note: currentType is no longer relevant since user and model-provider secrets are isolated
        currentType: result.exists ? "model-provider" : undefined,
      },
    };
  },
});

const handler = createHandler(modelProvidersCheckContract, router);

export { handler as GET };
