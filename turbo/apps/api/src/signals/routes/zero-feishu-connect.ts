import { command, computed } from "ccstate";
import { eq } from "drizzle-orm";
import { zeroFeishuConnectContract } from "@vm0/api-contracts/contracts/zero-feishu-connect";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";

import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { db$ } from "../external/db";
import { InvalidFeishuCredentialsError } from "../external/feishu-client";
import type { RouteEntry } from "../route-entry";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import { settle } from "../utils";
import {
  checkFeishuInstallationManagementAccess$,
  configureFeishuInstallation$,
  type ConfigureFeishuResult,
  disconnectFeishuConnection$,
  feishuConnectStatus,
  removeFeishuInstallation$,
  updateFeishuInstallationAgent$,
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

function managementRequired() {
  return {
    status: 403 as const,
    body: {
      error: {
        message:
          "Only the bot owner or organization admins can manage this Feishu bot",
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

const checkAppId$ = computed(async (get) => {
  if (!(await get(feishuIntegrationEnabled$))) {
    return feishuIntegrationDisabled;
  }
  const query = get(queryOf(zeroFeishuConnectContract.checkAppId));
  const [installation] = await get(db$)
    .select({ id: feishuOrgInstallations.id })
    .from(feishuOrgInstallations)
    .where(eq(feishuOrgInstallations.appId, query.appId))
    .limit(1);
  return installation
    ? conflict("This Feishu App ID is already registered in VM0")
    : { status: 200 as const, body: { available: true as const } };
});

const setup$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(feishuIntegrationEnabled$))) {
    return feishuIntegrationDisabled;
  }
  const auth = get(organizationAuthContext$);
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
        isAdmin: auth.orgRole === "admin",
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
  if (result.kind === "installation_not_found") {
    return notFound("Feishu integration not found");
  }
  if (result.kind === "app_in_use") {
    return conflict("This Feishu App ID is already registered in VM0");
  }
  if (result.kind === "forbidden") {
    return managementRequired();
  }
  const status = await get(
    feishuConnectStatus({
      orgId: auth.orgId,
      userId: auth.userId,
      isAdmin: auth.orgRole === "admin",
      preferredInstallationId: result.installationId,
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
  const status = await get(
    feishuConnectStatus({
      orgId: auth.orgId,
      userId: auth.userId,
      isAdmin: true,
    }),
  );
  signal.throwIfAborted();
  if (!status.installationId) {
    return notFound("Feishu integration not found");
  }
  const removed = await set(
    removeFeishuInstallation$,
    { orgId: auth.orgId, installationId: status.installationId },
    signal,
  );
  signal.throwIfAborted();
  return removed
    ? { status: 200 as const, body: { success: true as const } }
    : notFound("Feishu integration not found");
});

const updateInstallation$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!(await get(feishuIntegrationEnabled$))) {
      return feishuIntegrationDisabled;
    }
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(zeroFeishuConnectContract.updateInstallation),
    );
    const access = await set(
      checkFeishuInstallationManagementAccess$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        isAdmin: auth.orgRole === "admin",
        installationId: params.installationId,
      },
      signal,
    );
    if (access === "not_found") {
      return notFound("Feishu integration not found");
    }
    if (access === "forbidden") {
      return managementRequired();
    }
    const bodyResult = await get(
      bodyResultOf(zeroFeishuConnectContract.updateInstallation),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const updated = await set(
      updateFeishuInstallationAgent$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        installationId: params.installationId,
        defaultAgentId: bodyResult.data.defaultAgentId,
        setupCompleted: bodyResult.data.setupCompleted,
      },
      signal,
    );
    if (updated.kind === "agent_not_found") {
      return badRequestMessage("Select an agent from this organization");
    }
    if (updated.kind === "installation_not_found") {
      return notFound("Feishu integration not found");
    }
    const status = await get(
      feishuConnectStatus({
        orgId: auth.orgId,
        userId: auth.userId,
        isAdmin: auth.orgRole === "admin",
        preferredInstallationId: params.installationId,
      }),
    );
    signal.throwIfAborted();
    const installation = status.installations?.find((item) => {
      return item.id === params.installationId;
    });
    return installation
      ? { status: 200 as const, body: installation }
      : notFound("Feishu integration not found");
  },
);

const removeInstallation$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!(await get(feishuIntegrationEnabled$))) {
      return feishuIntegrationDisabled;
    }
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(zeroFeishuConnectContract.removeInstallation),
    );
    const access = await set(
      checkFeishuInstallationManagementAccess$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        isAdmin: auth.orgRole === "admin",
        installationId: params.installationId,
      },
      signal,
    );
    if (access === "not_found") {
      return notFound("Feishu integration not found");
    }
    if (access === "forbidden") {
      return managementRequired();
    }
    const removed = await set(
      removeFeishuInstallation$,
      { orgId: auth.orgId, installationId: params.installationId },
      signal,
    );
    signal.throwIfAborted();
    return removed
      ? { status: 200 as const, body: { success: true as const } }
      : notFound("Feishu integration not found");
  },
);

const disconnect$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(feishuIntegrationEnabled$))) {
    return feishuIntegrationDisabled;
  }
  const auth = get(organizationAuthContext$);
  const status = await get(
    feishuConnectStatus({
      orgId: auth.orgId,
      userId: auth.userId,
      isAdmin: auth.orgRole === "admin",
    }),
  );
  signal.throwIfAborted();
  if (!status.installationId) {
    return notFound("Feishu connection not found");
  }
  const disconnected = await set(
    disconnectFeishuConnection$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      installationId: status.installationId,
    },
    signal,
  );
  signal.throwIfAborted();
  return disconnected
    ? { status: 200 as const, body: { success: true as const } }
    : notFound("Feishu connection not found");
});

const disconnectInstallation$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!(await get(feishuIntegrationEnabled$))) {
      return feishuIntegrationDisabled;
    }
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(zeroFeishuConnectContract.disconnectInstallation),
    );
    const disconnected = await set(
      disconnectFeishuConnection$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        installationId: params.installationId,
      },
      signal,
    );
    signal.throwIfAborted();
    return disconnected
      ? { status: 200 as const, body: { success: true as const } }
      : notFound("Feishu connection not found");
  },
);

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
    route: zeroFeishuConnectContract.checkAppId,
    handler: authRoute(auth, checkAppId$),
  },
  {
    route: zeroFeishuConnectContract.setup,
    handler: authRoute(auth, setup$),
  },
  {
    route: zeroFeishuConnectContract.updateInstallation,
    handler: authRoute(auth, updateInstallation$),
  },
  {
    route: zeroFeishuConnectContract.removeInstallation,
    handler: authRoute(auth, removeInstallation$),
  },
  {
    route: zeroFeishuConnectContract.disconnectInstallation,
    handler: authRoute(auth, disconnectInstallation$),
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
