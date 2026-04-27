import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroComputerUseUnregisterContract } from "@vm0/api-contracts/contracts/zero-computer-use";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { unregisterHost } from "../../../../../src/lib/zero/computer-use/computer-use-service";
import { loadFeatureSwitchOverrides } from "../../../../../src/lib/zero/user/feature-switches-service";
import { isNotFound } from "@vm0/api-services/errors";

const router = tsr.router(zeroComputerUseUnregisterContract, {
  unregister: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);

    const overrides = await loadFeatureSwitchOverrides(org.orgId, userId);
    const enabled = isFeatureEnabled(FeatureSwitchKey.ComputerUse, {
      orgId: org.orgId,
      userId,
      overrides,
    });
    if (!enabled) {
      return createErrorResponse("FORBIDDEN", "Computer use is not enabled");
    }

    try {
      await unregisterHost(org.orgId, userId);
      return { status: 204 as const, body: undefined };
    } catch (error) {
      if (isNotFound(error)) {
        return createErrorResponse("NOT_FOUND", "Computer-use host not found");
      }
      throw error;
    }
  },
});

const handler = createHandler(zeroComputerUseUnregisterContract, router, {
  routeName: "zero.computer-use.unregister",
});

export { handler as DELETE };
