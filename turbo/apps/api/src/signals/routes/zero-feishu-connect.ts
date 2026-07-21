import { command, computed } from "ccstate";
import { zeroFeishuConnectContract } from "@vm0/api-contracts/contracts/zero-feishu-connect";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route-entry";
import {
  disconnectFeishuConnection$,
  feishuConnectStatus,
} from "../services/zero-feishu-connect.service";

function notFoundResponse() {
  return {
    status: 404 as const,
    body: {
      error: {
        message: "Feishu connection not found",
        code: "NOT_FOUND" as const,
      },
    },
  };
}

const getStatus$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const body = await get(
    feishuConnectStatus({
      orgId: auth.orgId,
      userId: auth.userId,
      isAdmin: "orgRole" in auth && auth.orgRole === "admin",
    }),
  );
  return { status: 200 as const, body };
});

const disconnect$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const disconnected = await set(
    disconnectFeishuConnection$,
    { orgId: auth.orgId, userId: auth.userId },
    signal,
  );
  signal.throwIfAborted();
  return disconnected
    ? { status: 200 as const, body: { success: true as const } }
    : notFoundResponse();
});

const auth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

export const zeroFeishuConnectRoutes: readonly RouteEntry[] = [
  {
    route: zeroFeishuConnectContract.getStatus,
    handler: authRoute(auth, getStatus$),
  },
  {
    route: zeroFeishuConnectContract.disconnect,
    handler: authRoute(auth, disconnect$),
  },
];
