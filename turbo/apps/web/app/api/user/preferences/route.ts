import { auth } from "@clerk/nextjs/server";
import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { userPreferencesContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-user-id";
import {
  getUserPreferences,
  updateUserPreferences,
} from "../../../../src/lib/user/user-preferences-service";
import { isBadRequest } from "../../../../src/lib/errors";

const router = tsr.router(userPreferencesContract, {
  /**
   * GET /api/user/preferences - Get user preferences
   */
  get: async ({ headers }) => {
    initServices();

    const ctx = await getAuthContext(headers.authorization);
    if (!ctx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const { sessionClaims, orgId: authOrgId } = await auth();

    // Clerk session → orgId from JWT; CLI token → use orgId from token
    let orgId = authOrgId;
    if (!orgId && ctx.orgId) {
      orgId = ctx.orgId;
    }
    if (!orgId) {
      return createErrorResponse("BAD_REQUEST", "No organization context");
    }

    const prefs = await getUserPreferences(
      orgId,
      ctx.userId,
      sessionClaims ?? undefined,
    );

    return {
      status: 200 as const,
      body: {
        timezone: prefs.timezone,
        notifyEmail: prefs.notifyEmail,
        notifySlack: prefs.notifySlack,
        pinnedAgentIds: prefs.pinnedAgentIds,
      },
    };
  },

  /**
   * PUT /api/user/preferences - Update user preferences
   */
  update: async ({ body, headers }) => {
    initServices();

    const ctx = await getAuthContext(headers.authorization);
    if (!ctx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    // Clerk session → orgId from JWT; CLI token → use orgId from token
    const { orgId } = await auth();
    let resolvedOrgId = orgId;
    if (!resolvedOrgId && ctx.orgId) {
      resolvedOrgId = ctx.orgId;
    }
    if (!resolvedOrgId) {
      return createErrorResponse("BAD_REQUEST", "No organization context");
    }

    try {
      const prefs = await updateUserPreferences(resolvedOrgId, ctx.userId, {
        timezone: body.timezone,
        notifyEmail: body.notifyEmail,
        notifySlack: body.notifySlack,
        pinnedAgentIds: body.pinnedAgentIds,
      });

      return {
        status: 200 as const,
        body: {
          timezone: prefs.timezone,
          notifyEmail: prefs.notifyEmail,
          notifySlack: prefs.notifySlack,
          pinnedAgentIds: prefs.pinnedAgentIds,
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
