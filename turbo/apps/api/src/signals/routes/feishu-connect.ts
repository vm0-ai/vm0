import { command, computed } from "ccstate";
import { eq } from "drizzle-orm";
import { feishuConnectContract } from "@okouai/api-contracts/contracts/feishu-connect";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { publicBrandPresentation } from "@okouai/core/public-brand";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";

import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { publicBrand$ } from "../context/hono";
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
  updateFeishuInstallationAgent$,
} from "../services/feishu-connect.service";

function adminRequired() {
  return {
    status: 403 as const,
    body: {
      error: {
        message: "Only organization admins can manage Feishu bots",
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

function appIdInUse(publicBrand: PublicBrand) {
  return conflict(
    `This Feishu App ID is already registered in ${publicBrandPresentation(publicBrand).brandName}`,
  );
}

const getStatus$ = computed(async (get) => {
  if (!(await get(feishuIntegrationEnabled$))) {
    return feishuIntegrationDisabled;
  }
  const auth = get(organizationAuthContext$);
  const body = await get(
    feishuConnectStatus({
      orgId: auth.orgId,
      userId: auth.userId,
      publicBrand: get(publicBrand$),
      isAdmin: auth.orgRole === "admin",
    }),
  );
  return { status: 200 as const, body };
});

const checkAppId$ = computed(async (get) => {
  if (!(await get(feishuIntegrationEnabled$))) {
    return feishuIntegrationDisabled;
  }
  const auth = get(organizationAuthContext$);
  const publicBrand =
    auth.tokenType === "agent" ? auth.publicBrand : get(publicBrand$);
  if (auth.orgRole !== "admin") {
    return adminRequired();
  }
  const query = get(queryOf(feishuConnectContract.checkAppId));
  const [installation] = await get(db$)
    .select({ id: feishuOrgInstallations.id })
    .from(feishuOrgInstallations)
    .where(eq(feishuOrgInstallations.appId, query.appId))
    .limit(1);
  return installation
    ? appIdInUse(publicBrand)
    : { status: 200 as const, body: { available: true as const } };
});

const setup$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(feishuIntegrationEnabled$))) {
    return feishuIntegrationDisabled;
  }
  const auth = get(organizationAuthContext$);
  const publicBrand =
    auth.tokenType === "agent" ? auth.publicBrand : get(publicBrand$);
  if (auth.orgRole !== "admin") {
    return adminRequired();
  }
  const bodyResult = await get(bodyResultOf(feishuConnectContract.setup));
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
        publicBrand,
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
  if (result.kind === "app_identity_mismatch") {
    return conflict(
      "A configured Feishu installation cannot be changed to a different App ID. Add a separate installation instead.",
    );
  }
  if (result.kind === "app_in_use") {
    return appIdInUse(publicBrand);
  }
  if (result.kind === "installation_exists") {
    return conflict("This workspace already has a Feishu bot");
  }
  const status = await get(
    feishuConnectStatus({
      orgId: auth.orgId,
      userId: auth.userId,
      publicBrand,
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
      publicBrand: get(publicBrand$),
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
    if (auth.orgRole !== "admin") {
      return adminRequired();
    }
    const params = get(pathParamsOf(feishuConnectContract.updateInstallation));
    const bodyResult = await get(
      bodyResultOf(feishuConnectContract.updateInstallation),
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
    if (updated.kind === "bot_identity_mismatch") {
      return conflict(
        "The Feishu app now resolves to a different bot identity. Restore the original app credentials or configure a separate installation.",
      );
    }
    const status = await get(
      feishuConnectStatus({
        orgId: auth.orgId,
        userId: auth.userId,
        publicBrand: get(publicBrand$),
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
    if (auth.orgRole !== "admin") {
      return adminRequired();
    }
    const params = get(pathParamsOf(feishuConnectContract.removeInstallation));
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
      publicBrand: get(publicBrand$),
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
      pathParamsOf(feishuConnectContract.disconnectInstallation),
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

export const feishuConnectRoutes: readonly RouteEntry[] = [
  {
    route: feishuConnectContract.getStatus,
    handler: authRoute(auth, getStatus$),
  },
  {
    route: feishuConnectContract.checkAppId,
    handler: authRoute(auth, checkAppId$),
  },
  {
    route: feishuConnectContract.setup,
    handler: authRoute(auth, setup$),
  },
  {
    route: feishuConnectContract.updateInstallation,
    handler: authRoute(auth, updateInstallation$),
  },
  {
    route: feishuConnectContract.removeInstallation,
    handler: authRoute(auth, removeInstallation$),
  },
  {
    route: feishuConnectContract.disconnectInstallation,
    handler: authRoute(auth, disconnectInstallation$),
  },
  {
    route: feishuConnectContract.remove,
    handler: authRoute(auth, remove$),
  },
  {
    route: feishuConnectContract.disconnect,
    handler: authRoute(auth, disconnect$),
  },
];
