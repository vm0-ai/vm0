import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import { zeroUserPreferencesContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import {
  getUserPreferences,
  updateUserPreferences,
} from "../../../../src/lib/user/user-preferences-service";
import { isBadRequest } from "../../../../src/lib/errors";

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
      });

      return {
        status: 200 as const,
        body: {
          timezone: prefs.timezone,
          pinnedAgentIds: prefs.pinnedAgentIds,
          sendMode: prefs.sendMode,
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
  errorHandler: createSafeErrorHandler("zero-user-preferences"),
});

export { handler as GET, handler as POST };
