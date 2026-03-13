import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import {
  modelProvidersCheckContract,
  createErrorResponse,
  getSecretNameForType,
} from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-user-id";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
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
    const { userId } = authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(userId, orgSlug);
    const result = await checkSecretExists(org.orgId, userId, params.type);

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
