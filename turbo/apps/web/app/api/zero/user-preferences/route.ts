import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import {
  zeroUserPreferencesContract,
  userPreferencesContract,
  createErrorResponse,
} from "@vm0/core";
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

/** Shared get implementation used by both new and legacy contracts. */
async function handleGet(authorization: string | undefined, request: Request) {
  initServices();

  const authCtx = await requireAuth(authorization);
  if (isAuthError(authCtx)) return authCtx;

  const orgSlug = new URL(request.url).searchParams.get("org");
  const { org } = await resolveOrg(authCtx, orgSlug);

  const prefs = await getUserPreferences(org.orgId, authCtx.userId);

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
}

/** Shared update implementation used by both new and legacy contracts. */
async function handleUpdate(
  authorization: string | undefined,
  request: Request,
  body: {
    timezone?: string;
    notifyEmail?: boolean;
    notifySlack?: boolean;
    pinnedAgentIds?: string[];
    sendMode?: "enter" | "cmd-enter";
  },
) {
  initServices();

  const authCtx = await requireAuth(authorization);
  if (isAuthError(authCtx)) return authCtx;

  const orgSlug = new URL(request.url).searchParams.get("org");
  const { org } = await resolveOrg(authCtx, orgSlug);

  try {
    const prefs = await updateUserPreferences(org.orgId, authCtx.userId, {
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
}

// Primary handler for the new zero contract (GET + POST)
const router = tsr.router(zeroUserPreferencesContract, {
  get: async ({ headers }, { request }) =>
    handleGet(headers.authorization, request),
  update: async ({ body, headers }, { request }) =>
    handleUpdate(headers.authorization, request, body),
});

const handler = createHandler(zeroUserPreferencesContract, router, {
  errorHandler: createSafeErrorHandler("zero-user-preferences"),
});

// Backward-compatible PUT handler: the old CLI contract uses PUT for update,
// and next.config.js rewrites /api/user/preferences → this route.
// We register a separate handler using the old contract which expects PUT.
const legacyRouter = tsr.router(userPreferencesContract, {
  get: async ({ headers }, { request }) =>
    handleGet(headers.authorization, request),
  update: async ({ body, headers }, { request }) =>
    handleUpdate(headers.authorization, request, body),
});

const legacyHandler = createHandler(userPreferencesContract, legacyRouter, {
  errorHandler: createSafeErrorHandler("zero-user-preferences-legacy"),
});

export { handler as GET, handler as POST, legacyHandler as PUT };
