import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { zeroFeatureSwitchesContract } from "@vm0/core/contracts/zero-feature-switches";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import {
  deleteUserFeatureSwitches,
  getUserFeatureSwitches,
  updateUserFeatureSwitches,
} from "../../../../src/lib/zero/user/feature-switches-service";

const router = tsr.router(zeroFeatureSwitchesContract, {
  get: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const { org } = await resolveOrg(authCtx);

    const switches = await getUserFeatureSwitches(org.orgId, authCtx.userId);

    return {
      status: 200 as const,
      body: { switches },
    };
  },

  update: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const { org } = await resolveOrg(authCtx);

    const switches = await updateUserFeatureSwitches(
      org.orgId,
      authCtx.userId,
      body.switches,
    );

    return {
      status: 200 as const,
      body: { switches },
    };
  },

  delete: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const { org } = await resolveOrg(authCtx);

    await deleteUserFeatureSwitches(org.orgId, authCtx.userId);

    return {
      status: 200 as const,
      body: { deleted: true as const },
    };
  },
});

const handler = createHandler(zeroFeatureSwitchesContract, router, {
  routeName: "zero.feature-switches",
});

export { handler as GET, handler as POST, handler as DELETE };
