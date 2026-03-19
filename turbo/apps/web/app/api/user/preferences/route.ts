import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { userPreferencesContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import {
  getUserPreferences,
  updateUserPreferences,
} from "../../../../src/lib/user/user-preferences-service";
import { isBadRequest } from "../../../../src/lib/errors";

const router = tsr.router(userPreferencesContract, {
  /**
   * GET /api/user/preferences - Get user preferences
   */
  get: async ({ headers }, { request }) => {
    initServices();

    const ctx = await getAuthContext(headers.authorization);
    if (!ctx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(ctx, orgSlug);

    const prefs = await getUserPreferences(org.orgId, ctx.userId);

    return {
      status: 200 as const,
      body: {
        timezone: prefs.timezone,
        notifyEmail: prefs.notifyEmail,
        notifySlack: prefs.notifySlack,
        pinnedAgentIds: prefs.pinnedAgentIds,
        sendMode: prefs.sendMode,
      },
    };
  },

  /**
   * PUT /api/user/preferences - Update user preferences
   */
  update: async ({ body, headers }, { request }) => {
    initServices();

    const ctx = await getAuthContext(headers.authorization);
    if (!ctx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(ctx, orgSlug);

    try {
      const prefs = await updateUserPreferences(org.orgId, ctx.userId, {
        timezone: body.timezone,
        notifyEmail: body.notifyEmail,
        notifySlack: body.notifySlack,
        pinnedAgentIds: body.pinnedAgentIds,
        sendMode: body.sendMode,
      });

      return {
        status: 200 as const,
        body: {
          timezone: prefs.timezone,
          notifyEmail: prefs.notifyEmail,
          notifySlack: prefs.notifySlack,
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

const handler = createHandler(userPreferencesContract, router);

export { handler as GET, handler as PUT };
