import {
  createHandler,
  tsr,
} from "../../../../../../../src/lib/ts-rest-handler";
import { zeroPersonalModelProvidersUpdateModelContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { initServices } from "../../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../../../src/lib/zero/org/resolve-org";
import { updateUserModelProviderModel } from "../../../../../../../src/lib/zero/model-provider/model-provider-service";
import { loadFeatureSwitchOverrides } from "../../../../../../../src/lib/zero/user/feature-switches-service";
import { logger } from "../../../../../../../src/lib/shared/logger";
import { isNotFound } from "@vm0/api-services/errors";

const log = logger("api:zero-me-model-providers");

const router = tsr.router(zeroPersonalModelProvidersUpdateModelContract, {
  updateModel: async ({ params, body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const { org } = await resolveOrg(authCtx);

    const overrides = await loadFeatureSwitchOverrides(
      org.orgId,
      authCtx.userId,
    );
    const personalEnabled = isFeatureEnabled(
      FeatureSwitchKey.PersonalModelProvider,
      { userId: authCtx.userId, orgId: org.orgId, overrides },
    );
    if (!personalEnabled) {
      return createErrorResponse("NOT_FOUND", "Not found");
    }

    log.debug("updating personal model provider model", {
      orgId: org.orgId,
      userId: authCtx.userId,
      type: params.type,
      selectedModel: body.selectedModel,
    });

    try {
      const provider = await updateUserModelProviderModel(
        org.orgId,
        authCtx.userId,
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

const handler = createHandler(
  zeroPersonalModelProvidersUpdateModelContract,
  router,
  {
    routeName: "zero.me.model-providers.model",
  },
);

export { handler as PATCH };
