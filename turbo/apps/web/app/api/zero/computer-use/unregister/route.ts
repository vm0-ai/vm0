import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import {
  zeroComputerUseUnregisterContract,
  createErrorResponse,
  FeatureSwitchKey,
  isFeatureEnabled,
} from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { unregisterHost } from "../../../../../src/lib/zero/computer-use/computer-use-service";
import { loadFeatureSwitchOverrides } from "../../../../../src/lib/zero/user/feature-switches-service";
import { isNotFound } from "../../../../../src/lib/shared/errors";

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
