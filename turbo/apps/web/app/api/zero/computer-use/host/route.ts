import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroComputerUseHostContract } from "@vm0/core/contracts/zero-computer-use";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { createErrorResponse } from "@vm0/core/contracts/errors";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { getHost } from "../../../../../src/lib/zero/computer-use/computer-use-service";
import { loadFeatureSwitchOverrides } from "../../../../../src/lib/zero/user/feature-switches-service";

const router = tsr.router(zeroComputerUseHostContract, {
  getHost: async ({ headers }) => {
    initServices();

    // Accept CLI tokens (no capability check) and ZERO_TOKENs with computer-use:write
    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "computer-use:write",
    });
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

    const host = await getHost(org.orgId, userId);
    if (!host) {
      return createErrorResponse("NOT_FOUND", "No active computer-use host");
    }

    return { status: 200 as const, body: host };
  },
});

const handler = createHandler(zeroComputerUseHostContract, router, {
  routeName: "zero.computer-use.host",
});

export { handler as GET };
