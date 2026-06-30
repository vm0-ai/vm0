import { zeroConnectorCatalogContract } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  getAllFeatureStates,
  isFeatureEnabled,
} from "@vm0/core/feature-switch";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import {
  getPublicConnectorCatalogDetail,
  getPublicConnectorCatalogPermissionDetail,
  listPublicConnectorCatalog,
} from "../services/connector-catalog-reader.service";
import { notFound } from "../../lib/error";

const connectorCatalogAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "connector:read",
} as const;

const connectorCatalogApiDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Connector catalog API is not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

function connectorCatalogNotFound() {
  return notFound("Connector catalog item not found");
}

const connectorCatalogRequestContext$ = command(async ({ get }) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  const featureSwitchContext = {
    orgId: auth.orgId,
    userId: auth.userId,
    overrides,
  };
  return {
    enabled: isFeatureEnabled(
      FeatureSwitchKey.ConnectorCatalogApi,
      featureSwitchContext,
    ),
    featureStates: getAllFeatureStates(featureSwitchContext),
  };
});

const listConnectorCatalogInner$ = command(
  async ({ set }, signal: AbortSignal) => {
    const context = await set(connectorCatalogRequestContext$);
    signal.throwIfAborted();
    if (!context.enabled) {
      return connectorCatalogApiDisabled;
    }

    const connectors = await listPublicConnectorCatalog({
      featureStates: context.featureStates,
      apiAuthMethodPolicy: "include",
    });
    signal.throwIfAborted();

    return { status: 200 as const, body: { connectors } };
  },
);

const getConnectorCatalogInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const context = await set(connectorCatalogRequestContext$);
    signal.throwIfAborted();
    if (!context.enabled) {
      return connectorCatalogApiDisabled;
    }

    const params = get(pathParamsOf(zeroConnectorCatalogContract.get));
    const connector = await getPublicConnectorCatalogDetail({
      connectorRef: params.connectorRef,
      featureStates: context.featureStates,
      apiAuthMethodPolicy: "include",
    });
    signal.throwIfAborted();
    if (!connector) {
      return connectorCatalogNotFound();
    }

    return { status: 200 as const, body: { connector } };
  },
);

const getConnectorCatalogPermissionsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const context = await set(connectorCatalogRequestContext$);
    signal.throwIfAborted();
    if (!context.enabled) {
      return connectorCatalogApiDisabled;
    }

    const params = get(pathParamsOf(zeroConnectorCatalogContract.permissions));
    const permissions = await getPublicConnectorCatalogPermissionDetail({
      connectorRef: params.connectorRef,
      featureStates: context.featureStates,
      apiAuthMethodPolicy: "include",
    });
    signal.throwIfAborted();
    if (!permissions) {
      return connectorCatalogNotFound();
    }

    return { status: 200 as const, body: { permissions } };
  },
);

export const zeroConnectorCatalogRoutes: readonly RouteEntry[] = [
  {
    route: zeroConnectorCatalogContract.list,
    handler: authRoute(connectorCatalogAuth, listConnectorCatalogInner$),
  },
  {
    route: zeroConnectorCatalogContract.get,
    handler: authRoute(connectorCatalogAuth, getConnectorCatalogInner$),
  },
  {
    route: zeroConnectorCatalogContract.permissions,
    handler: authRoute(
      connectorCatalogAuth,
      getConnectorCatalogPermissionsInner$,
    ),
  },
];
