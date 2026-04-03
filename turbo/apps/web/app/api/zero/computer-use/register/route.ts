import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
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
import { isConflict } from "../../../../../src/lib/shared/errors";

const router = tsr.router(zeroComputerUseRegisterContract, {
  register: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);

    const enabled = await isFeatureEnabled(FeatureSwitchKey.ComputerUse, {
      orgId: org.orgId,
      userId,
    });
    if (!enabled) {
      return createErrorResponse("FORBIDDEN", "Computer use is not enabled");
    }

    try {
      const result = await registerHost(org.orgId, userId);
      return { status: 200 as const, body: result };
    } catch (error) {
      if (isConflict(error)) {
        return createErrorResponse(
          "CONFLICT",
          "Computer-use host already registered",
        );
      }
      throw error;
    }
  },
});

const handler = createHandler(zeroComputerUseRegisterContract, router, {
  errorHandler: createSafeErrorHandler("zero-computer-use:register"),
});

export { handler as POST };
