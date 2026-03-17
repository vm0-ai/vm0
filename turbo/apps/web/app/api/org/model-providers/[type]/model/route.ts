import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import {
  orgModelProvidersUpdateModelContract,
  createErrorResponse,
} from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../../src/lib/auth/get-user-id";
import { resolveOrg } from "../../../../../../src/lib/org/resolve-org";
import { updateOrgModelProviderModel } from "../../../../../../src/lib/model-provider/model-provider-service";
import { logger } from "../../../../../../src/lib/logger";
import { isNotFound } from "../../../../../../src/lib/errors";

const log = logger("api:org-model-providers");

const router = tsr.router(orgModelProvidersUpdateModelContract, {
  /**
   * PATCH /api/org/model-providers/:type/model - Update org provider model selection
   * Admin only.
   */
  updateModel: async ({ params, body, headers }, { request }) => {
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
        "Only admins can manage org model providers",
      );
    }

    log.debug("updating org model provider model", {
      orgId: org.orgId,
      type: params.type,
      selectedModel: body.selectedModel,
    });

    try {
      const provider = await updateOrgModelProviderModel(
        org.orgId,
        params.type,
        body.selectedModel,
      );

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

const handler = createHandler(orgModelProvidersUpdateModelContract, router);

export { handler as PATCH };
