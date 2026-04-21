import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import {
  zeroComputerUseRegisterContract,
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
import { registerHost } from "../../../../../src/lib/zero/computer-use/computer-use-service";
import { loadFeatureSwitchOverrides } from "../../../../../src/lib/zero/user/feature-switches-service";

const router = tsr.router(zeroComputerUseRegisterContract, {
  register: async ({ headers }) => {
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

    const result = await registerHost(org.orgId, userId);
    return { status: 200 as const, body: result };
  },
});

const handler = createHandler(zeroComputerUseRegisterContract, router, {
  routeName: "zero.computer-use.register",
});

export { handler as POST };
