import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { zeroUserPreferencesContract } from "@vm0/api-contracts/contracts/zero-user-preferences";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import {
  getUserPreferences,
  updateUserPreferences,
} from "../../../../src/lib/zero/user/user-preferences-service";
import { isBadRequest } from "../../../../src/lib/shared/errors";

const router = tsr.router(zeroUserPreferencesContract, {
  get: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const { org } = await resolveOrg(authCtx);

    const prefs = await getUserPreferences(org.orgId, authCtx.userId);

    return {
      status: 200 as const,
      body: {
        timezone: prefs.timezone,
        pinnedAgentIds: prefs.pinnedAgentIds,
        sendMode: prefs.sendMode,
        captureNetworkBodiesRemaining: prefs.captureNetworkBodiesRemaining,
      },
    };
  },

  update: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const { org } = await resolveOrg(authCtx);

    try {
      const prefs = await updateUserPreferences(org.orgId, authCtx.userId, {
        timezone: body.timezone,
        pinnedAgentIds: body.pinnedAgentIds,
        sendMode: body.sendMode,
        captureNetworkBodiesRemaining: body.captureNetworkBodiesRemaining,
      });

      return {
        status: 200 as const,
        body: {
          timezone: prefs.timezone,
          pinnedAgentIds: prefs.pinnedAgentIds,
          sendMode: prefs.sendMode,
          captureNetworkBodiesRemaining: prefs.captureNetworkBodiesRemaining,
        },
      };
    } catch (error) {
      if (isBadRequest(error)) {
        return createErrorResponse("BAD_REQUEST", "Invalid request");
      }
      throw error;
    }
  },
});

const handler = createHandler(zeroUserPreferencesContract, router, {
  routeName: "zero.user-preferences",
});

export { handler as GET, handler as POST };
