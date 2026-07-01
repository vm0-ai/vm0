import { zeroConnectorCatalogContract } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { getAllFeatureStates } from "@vm0/core/feature-switch";
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
  listPublicConnectorCatalogStatus,
} from "../services/connector-catalog-reader.service";
import { zeroConnectorList } from "../services/zero-connector-data.service";
import { notFound } from "../../lib/error";

const connectorCatalogAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "connector:read",
} as const;

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
    featureStates: getAllFeatureStates(featureSwitchContext),
  };
});

const listConnectorCatalogInner$ = command(
  async ({ set }, signal: AbortSignal) => {
    const context = await set(connectorCatalogRequestContext$);
    signal.throwIfAborted();

    const connectors = await listPublicConnectorCatalog({
      featureStates: context.featureStates,
      apiAuthMethodPolicy: "include",
    });
    signal.throwIfAborted();

    return { status: 200 as const, body: { connectors } };
  },
);

const listConnectorCatalogStatusInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const context = await set(connectorCatalogRequestContext$);
    signal.throwIfAborted();

    const connectorState = await get(
      zeroConnectorList({
        orgId: auth.orgId,
        userId: auth.userId,
        featureStates: context.featureStates,
      }),
    );
    signal.throwIfAborted();

    const connectors = await listPublicConnectorCatalogStatus({
      featureStates: context.featureStates,
      apiAuthMethodPolicy: "include",
      connectors: connectorState.connectors,
    });
    signal.throwIfAborted();

    return { status: 200 as const, body: { connectors } };
  },
);

const getConnectorCatalogInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const context = await set(connectorCatalogRequestContext$);
    signal.throwIfAborted();

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
    route: zeroConnectorCatalogContract.status,
    handler: authRoute(connectorCatalogAuth, listConnectorCatalogStatusInner$),
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
