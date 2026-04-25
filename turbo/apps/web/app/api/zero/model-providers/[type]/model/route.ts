import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { zeroModelProvidersUpdateModelContract } from "@vm0/api-contracts/contracts/zero-model-providers";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { updateOrgModelProviderModel } from "../../../../../../src/lib/zero/model-provider/model-provider-service";
import { logger } from "../../../../../../src/lib/shared/logger";
import { isNotFound } from "../../../../../../src/lib/shared/errors";

const log = logger("api:zero-model-providers");

const router = tsr.router(zeroModelProvidersUpdateModelContract, {
  updateModel: async ({ params, body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const { org, member } = await resolveOrg(authCtx);

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

const handler = createHandler(zeroModelProvidersUpdateModelContract, router, {
  routeName: "zero.model-providers.model",
});

export { handler as PATCH };
