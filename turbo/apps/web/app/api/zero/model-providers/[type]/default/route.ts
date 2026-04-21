import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import {
  zeroModelProvidersDefaultContract,
  createErrorResponse,
} from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { setOrgModelProviderDefault } from "../../../../../../src/lib/zero/model-provider/model-provider-service";
import { logger } from "../../../../../../src/lib/shared/logger";
import { isNotFound } from "../../../../../../src/lib/shared/errors";

const log = logger("api:zero-model-providers");

const router = tsr.router(zeroModelProvidersDefaultContract, {
  setDefault: async ({ params, headers }) => {
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

const handler = createHandler(zeroModelProvidersDefaultContract, router, {
  routeName: "zero.model-providers.default",
});

export { handler as POST };
