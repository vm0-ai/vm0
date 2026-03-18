import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import {
  orgModelProvidersSetDefaultContract,
  createErrorResponse,
} from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../../src/lib/org/resolve-org";
import { setOrgModelProviderDefault } from "../../../../../../src/lib/model-provider/model-provider-service";
import { logger } from "../../../../../../src/lib/logger";
import { isNotFound } from "../../../../../../src/lib/errors";

const log = logger("api:org-model-providers");

const router = tsr.router(orgModelProvidersSetDefaultContract, {
  /**
   * POST /api/org/model-providers/:type/set-default - Set org provider as default
   * Admin only.
   */
  setDefault: async ({ params, headers }, { request }) => {
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
        "Only admins can manage org model providers",
      );
    }

    log.debug("setting org model provider as default", {
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

const handler = createHandler(orgModelProvidersSetDefaultContract, router);

export { handler as POST };
