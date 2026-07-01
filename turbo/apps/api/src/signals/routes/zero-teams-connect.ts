import { command, computed } from "ccstate";
import { zeroTeamsConnectContract } from "@vm0/api-contracts/contracts/zero-teams-connect";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, queryOf } from "../context/request";
import {
  connectTeamsInstallation$,
  disconnectTeamsConnection$,
  publishTeamsChanged$,
  uninstallTeamsInstallation$,
  zeroTeamsConnectStatus,
} from "../services/zero-teams-connect.service";
import type { RouteEntry } from "../route-entry";

function errorResponse(
  status: 403 | 404,
  message: string,
  code: "FORBIDDEN" | "NOT_FOUND",
) {
  return {
    status,
    body: {
      error: { message, code },
    },
  };
}

const getTeamsConnectStatusInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const body = await get(
    zeroTeamsConnectStatus({
      orgId: auth.orgId,
      userId: auth.userId,
      isAdmin: "orgRole" in auth && auth.orgRole === "admin",
    }),
  );
  return { status: 200 as const, body };
});

const connectInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  signal.throwIfAborted();

  const bodyResult = await get(bodyResultOf(zeroTeamsConnectContract.connect));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;

  const result = await set(
    connectTeamsInstallation$,
    {
      userId: auth.userId,
      orgId: auth.orgId,
      orgRole:
        "orgRole" in auth && auth.orgRole === "admin" ? "admin" : "member",
      tenantId: body.tenantId,
      teamsUserId: body.teamsUserId,
      teamsUserDisplayName: body.teamsUserDisplayName,
      teamsUserPrincipalName: body.teamsUserPrincipalName,
      teamId: body.teamId,
      teamName: body.teamName,
      serviceUrl: body.serviceUrl,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.kind === "not_found") {
    return errorResponse(404, result.message, "NOT_FOUND");
  }

  if (result.kind === "forbidden") {
    return errorResponse(403, result.message, "FORBIDDEN");
  }

  await set(
    publishTeamsChanged$,
    { orgId: auth.orgId, userIds: [auth.userId] },
    signal,
  );
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      success: true as const,
      connectionId: result.connectionId,
      role: result.role,
    },
  };
});

const disconnectInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(zeroTeamsConnectContract.disconnect));

  if (query.action === "uninstall") {
    if (!("orgRole" in auth) || auth.orgRole !== "admin") {
      return errorResponse(403, "Admin access required", "FORBIDDEN");
    }

    const uninstallResult = await set(
      uninstallTeamsInstallation$,
      { orgId: auth.orgId },
      signal,
    );
    signal.throwIfAborted();

    if (uninstallResult.kind === "not_found") {
      return errorResponse(404, uninstallResult.message, "NOT_FOUND");
    }

    await set(
      publishTeamsChanged$,
      {
        orgId: uninstallResult.orgId,
        userIds: [auth.userId, ...uninstallResult.userIds],
      },
      signal,
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: { success: true as const },
    };
  }

  const result = await set(
    disconnectTeamsConnection$,
    { orgId: auth.orgId, userId: auth.userId },
    signal,
  );
  signal.throwIfAborted();

  if (result.kind === "not_found") {
    return errorResponse(404, result.message, "NOT_FOUND");
  }

  await set(
    publishTeamsChanged$,
    { orgId: result.orgId, userIds: [result.userId] },
    signal,
  );
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: { success: true as const },
  };
});

const teamsConnectAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

export const zeroTeamsConnectRoutes: readonly RouteEntry[] = [
  {
    route: zeroTeamsConnectContract.getStatus,
    handler: authRoute(teamsConnectAuth, getTeamsConnectStatusInner$),
  },
  {
    route: zeroTeamsConnectContract.connect,
    handler: authRoute(teamsConnectAuth, connectInner$),
  },
  {
    route: zeroTeamsConnectContract.disconnect,
    handler: authRoute(teamsConnectAuth, disconnectInner$),
  },
];
