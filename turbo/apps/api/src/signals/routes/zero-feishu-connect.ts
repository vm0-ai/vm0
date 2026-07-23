import { command, computed } from "ccstate";
import { zeroFeishuConnectContract } from "@vm0/api-contracts/contracts/zero-feishu-connect";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { db$ } from "../external/db";
import { InvalidFeishuCredentialsError } from "../external/feishu-client";
import type { RouteEntry } from "../route-entry";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import { settle } from "../utils";
import {
  configureFeishuInstallation$,
  type ConfigureFeishuResult,
  disconnectFeishuConnection$,
  feishuConnectStatus,
  removeFeishuInstallation$,
} from "../services/zero-feishu-connect.service";

function adminRequired() {
  return {
    status: 403 as const,
    body: {
      error: {
        message: "Only organization admins can configure Feishu",
        code: "FORBIDDEN" as const,
      },
    },
  };
}

const feishuIntegrationDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Feishu integration is not enabled",
      code: "FORBIDDEN" as const,
    }),
  }),
});

const feishuIntegrationEnabled$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const context = await loadUserFeatureSwitchContext(
    get(db$),
    auth.orgId,
    auth.userId,
  );
  return isFeatureEnabled(FeatureSwitchKey.FeishuIntegration, context);
});

const getStatus$ = computed(async (get) => {
  if (!(await get(feishuIntegrationEnabled$))) {
    return feishuIntegrationDisabled;
  }
  const auth = get(organizationAuthContext$);
  const body = await get(
    feishuConnectStatus({
      orgId: auth.orgId,
      userId: auth.userId,
      isAdmin: auth.orgRole === "admin",
    }),
  );
  return { status: 200 as const, body };
});

const setup$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(feishuIntegrationEnabled$))) {
    return feishuIntegrationDisabled;
  }
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired();
  }
  const bodyResult = await get(bodyResultOf(zeroFeishuConnectContract.setup));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const configured = await settle(
    set(
      configureFeishuInstallation$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        ...bodyResult.data,
      },
      signal,
    ),
    signal,
  );
  signal.throwIfAborted();
  if (!configured.ok) {
    if (configured.error instanceof InvalidFeishuCredentialsError) {
      return badRequestMessage(
        "Invalid App ID or App Secret. Check the credentials in Feishu and try again.",
      );
    }
    throw configured.error;
  }
  const result: ConfigureFeishuResult = configured.value;
  if (result.kind === "agent_not_found") {
    return badRequestMessage("Select an agent from this organization");
  }
  if (result.kind === "app_in_use") {
    return conflict("This Feishu app is already connected to another VM0 org");
  }
  const status = await get(
    feishuConnectStatus({
      orgId: auth.orgId,
      userId: auth.userId,
      isAdmin: true,
    }),
  );
  signal.throwIfAborted();
  return { status: 200 as const, body: status };
});

const remove$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(feishuIntegrationEnabled$))) {
    return feishuIntegrationDisabled;
  }
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired();
  }
  const removed = await set(removeFeishuInstallation$, auth.orgId, signal);
  signal.throwIfAborted();
  return removed
    ? { status: 200 as const, body: { success: true as const } }
    : notFound("Feishu integration not found");
});

const disconnect$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(feishuIntegrationEnabled$))) {
    return feishuIntegrationDisabled;
  }
  const auth = get(organizationAuthContext$);
  const disconnected = await set(
    disconnectFeishuConnection$,
    { orgId: auth.orgId, userId: auth.userId },
    signal,
  );
  signal.throwIfAborted();
  return disconnected
    ? { status: 200 as const, body: { success: true as const } }
    : notFound("Feishu connection not found");
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
    route: zeroFeishuConnectContract.setup,
    handler: authRoute(auth, setup$),
  },
  {
    route: zeroFeishuConnectContract.remove,
    handler: authRoute(auth, remove$),
  },
  {
    route: zeroFeishuConnectContract.disconnect,
    handler: authRoute(auth, disconnect$),
  },
];
