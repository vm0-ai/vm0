import { zeroConnectorCatalogContract } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { getAllFeatureStates } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { connectorCatalogDiagnostics$ } from "../services/connector-catalog-diagnostics.service";
import {
  getPublicConnectorCatalogDetail,
  getPublicConnectorCatalogPermissionDetail,
  isConnectorCatalogUnavailableError,
  listPublicConnectorCatalog,
  listPublicConnectorCatalogStatus,
} from "../services/connector-catalog-reader.service";
import { zeroConnectorList } from "../services/zero-connector-data.service";
import { notFound, providerUnavailable } from "../../lib/error";
import { settle } from "../utils";

const connectorCatalogAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "connector:read",
} as const;

const connectorCatalogDiagnosticsAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  accept: ["session"],
} as const;

const connectorCatalogDiagnosticsDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Connector catalog diagnostics are not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

function connectorCatalogNotFound() {
  return notFound("Connector catalog item not found");
}

function connectorCatalogUnavailable() {
  return providerUnavailable("Connector catalog is temporarily unavailable");
}

async function settleConnectorCatalogRead<T>(
  read: Promise<T>,
  signal: AbortSignal,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false }> {
  const result = await settle(read, signal);
  if (result.ok) {
    return result;
  }
  if (isConnectorCatalogUnavailableError(result.error)) {
    return { ok: false };
  }
  throw result.error;
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
    db: get(db$),
    featureStates: getAllFeatureStates(featureSwitchContext),
  };
});

const listConnectorCatalogInner$ = command(
  async ({ set }, signal: AbortSignal) => {
    const context = await set(connectorCatalogRequestContext$);
    signal.throwIfAborted();

    const catalog = await settleConnectorCatalogRead(
      listPublicConnectorCatalog({
        db: context.db,
        featureStates: context.featureStates,
      }),
      signal,
    );
    if (!catalog.ok) {
      return connectorCatalogUnavailable();
    }

    return { status: 200 as const, body: catalog.value };
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

    const catalog = await settleConnectorCatalogRead(
      listPublicConnectorCatalogStatus({
        db: context.db,
        featureStates: context.featureStates,
        connectors: connectorState.connectors,
      }),
      signal,
    );
    if (!catalog.ok) {
      return connectorCatalogUnavailable();
    }

    return { status: 200 as const, body: catalog.value };
  },
);

const getConnectorCatalogDiagnosticsInner$ = command(
  async ({ set }, signal: AbortSignal) => {
    const context = await set(connectorCatalogRequestContext$);
    signal.throwIfAborted();
    if (!context.featureStates[FeatureSwitchKey.ZeroDebug]) {
      return connectorCatalogDiagnosticsDisabled;
    }

    const diagnostics = await set(connectorCatalogDiagnostics$, signal);
    return { status: 200 as const, body: diagnostics };
  },
);

const getConnectorCatalogInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const context = await set(connectorCatalogRequestContext$);
    signal.throwIfAborted();

    const params = get(pathParamsOf(zeroConnectorCatalogContract.get));
    const connector = await settleConnectorCatalogRead(
      getPublicConnectorCatalogDetail({
        db: context.db,
        connectorRef: params.connectorRef,
        featureStates: context.featureStates,
      }),
      signal,
    );
    if (!connector.ok) {
      return connectorCatalogUnavailable();
    }
    if (!connector.value) {
      return connectorCatalogNotFound();
    }

    return { status: 200 as const, body: { connector: connector.value } };
  },
);

const getConnectorCatalogPermissionsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const context = await set(connectorCatalogRequestContext$);
    signal.throwIfAborted();

    const params = get(pathParamsOf(zeroConnectorCatalogContract.permissions));
    const permissions = await settleConnectorCatalogRead(
      getPublicConnectorCatalogPermissionDetail({
        db: context.db,
        connectorRef: params.connectorRef,
        featureStates: context.featureStates,
      }),
      signal,
    );
    if (!permissions.ok) {
      return connectorCatalogUnavailable();
    }
    if (!permissions.value) {
      return connectorCatalogNotFound();
    }

    return { status: 200 as const, body: { permissions: permissions.value } };
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
    route: zeroConnectorCatalogContract.diagnostics,
    handler: authRoute(
      connectorCatalogDiagnosticsAuth,
      getConnectorCatalogDiagnosticsInner$,
    ),
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
