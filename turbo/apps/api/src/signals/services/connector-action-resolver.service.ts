import { computed, type Computed } from "ccstate";
import type {
  ConnectorCatalogAuthMethodId,
  ConnectorCatalogRef,
} from "@vm0/api-contracts/contracts/connector-identity";
import type {
  PublicConnectorCatalogAuthMethodDetail,
  PublicConnectorCatalogDetail,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import type { ConnectorAuthMethodRuntimeConfig } from "@vm0/connectors/connectors";
import { getAllFeatureStates } from "@vm0/core/feature-switch";

import { db$ } from "../external/db";
import {
  getConnectorRuntimeAvailableCatalogDetail,
  getConnectorRuntimeConnector,
  getConnectorRuntimeMethod,
  loadConnectorRuntimeSnapshot,
  type ConnectorRuntimeConnector,
  type ConnectorRuntimeMethod,
  type ConnectorRuntimeSnapshot,
} from "./connector-catalog-runtime.service";
import { userFeatureSwitchOverrides } from "./feature-switches.service";

type ConnectorCatalogGrantKind =
  PublicConnectorCatalogAuthMethodDetail["grantKind"];

export type ConnectorRefResolutionFailure =
  | { readonly ok: false; readonly reason: "unknown_connector" }
  | { readonly ok: false; readonly reason: "unavailable_connector" }
  | {
      readonly ok: false;
      readonly reason: "missing_executable_capability";
    };

export type ConnectorActionResolutionFailure =
  | ConnectorRefResolutionFailure
  | {
      readonly ok: false;
      readonly reason: "unknown_auth_method";
      readonly catalogConnector: PublicConnectorCatalogDetail;
    }
  | {
      readonly ok: false;
      readonly reason: "wrong_grant_kind";
      readonly actualGrantKind: ConnectorCatalogGrantKind;
      readonly catalogConnector: PublicConnectorCatalogDetail;
    }
  | { readonly ok: false; readonly reason: "unavailable_auth_method" };

export type ResolvedConnectorRef = {
  readonly ok: true;
  readonly connectorRef: ConnectorCatalogRef;
  readonly catalogConnector: PublicConnectorCatalogDetail;
  readonly runtimeConnector: ConnectorRuntimeConnector;
  readonly snapshot: ConnectorRuntimeSnapshot;
};

export type ResolvedConnectorActionMethod = ResolvedConnectorRef & {
  readonly authMethodId: ConnectorCatalogAuthMethodId;
  readonly catalogMethod: PublicConnectorCatalogAuthMethodDetail;
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly runtimeMethod: ConnectorRuntimeMethod;
};

export type ConnectorRefResolution =
  | ResolvedConnectorRef
  | ConnectorRefResolutionFailure;

export type ConnectorActionMethodResolution =
  | ResolvedConnectorActionMethod
  | ConnectorActionResolutionFailure;

export type ConnectorRefsResolution =
  | {
      readonly ok: true;
      readonly connectors: readonly ResolvedConnectorRef[];
    }
  | (ConnectorRefResolutionFailure & {
      readonly connectorRef: ConnectorCatalogRef;
    });

export interface ConnectorActionResolver {
  readonly resolveRef: (args: {
    readonly connectorRef: ConnectorCatalogRef;
    readonly requireAvailable: boolean;
    readonly requireExecutable: boolean;
  }) => Promise<ConnectorRefResolution>;
  readonly resolveMethod: (args: {
    readonly connectorRef: ConnectorCatalogRef;
    readonly authMethodId: ConnectorCatalogAuthMethodId;
    readonly expectedGrantKind: ConnectorCatalogGrantKind;
    readonly requireAvailable: boolean;
  }) => Promise<ConnectorActionMethodResolution>;
  readonly resolveRefs: (args: {
    readonly connectorRefs: readonly ConnectorCatalogRef[];
    readonly requireAvailable: boolean;
    readonly requireExecutable: boolean;
  }) => Promise<ConnectorRefsResolution>;
}

function resolvedRef(args: {
  readonly connectorRef: ConnectorCatalogRef;
  readonly requireExecutable: boolean;
  readonly runtimeConnector: ConnectorRuntimeConnector;
  readonly snapshot: ConnectorRuntimeSnapshot;
}): ResolvedConnectorRef | ConnectorRefResolutionFailure {
  if (
    args.requireExecutable &&
    ![...args.runtimeConnector.methods.values()].some((method) => {
      return method.executable;
    })
  ) {
    return { ok: false, reason: "missing_executable_capability" };
  }
  return {
    ok: true,
    connectorRef: args.connectorRef,
    catalogConnector: args.runtimeConnector.catalogConnector,
    runtimeConnector: args.runtimeConnector,
    snapshot: args.snapshot,
  };
}

function executableMethod(args: {
  readonly resolvedRef: ResolvedConnectorRef;
  readonly authMethodId: ConnectorCatalogAuthMethodId;
  readonly catalogMethod: PublicConnectorCatalogAuthMethodDetail;
}): ResolvedConnectorActionMethod | ConnectorActionResolutionFailure {
  const runtimeMethod = getConnectorRuntimeMethod({
    snapshot: args.resolvedRef.snapshot,
    connectorRef: args.resolvedRef.connectorRef,
    authMethodId: args.authMethodId,
    requireExecutable: true,
  });
  if (
    runtimeMethod === undefined ||
    runtimeMethod.method.grant.kind !== args.catalogMethod.grantKind
  ) {
    return { ok: false, reason: "missing_executable_capability" };
  }
  return {
    ...args.resolvedRef,
    authMethodId: args.authMethodId,
    catalogMethod: args.catalogMethod,
    method: runtimeMethod.method,
    runtimeMethod,
  };
}

function createConnectorActionResolver(args: {
  readonly featureStates: ReturnType<typeof getAllFeatureStates>;
  readonly snapshot: ConnectorRuntimeSnapshot;
}): ConnectorActionResolver {
  const readAvailableConnector = async (connectorRef: ConnectorCatalogRef) => {
    return await getConnectorRuntimeAvailableCatalogDetail({
      snapshot: args.snapshot,
      connectorRef,
      featureStates: args.featureStates,
    });
  };

  const resolveRef: ConnectorActionResolver["resolveRef"] = async (input) => {
    const runtimeConnector = getConnectorRuntimeConnector(
      args.snapshot,
      input.connectorRef,
    );
    if (runtimeConnector === undefined) {
      return { ok: false, reason: "unknown_connector" };
    }
    if (input.requireAvailable) {
      const availableConnector = await readAvailableConnector(
        input.connectorRef,
      );
      if (!availableConnector) {
        return { ok: false, reason: "unavailable_connector" };
      }
    }
    return resolvedRef({
      connectorRef: input.connectorRef,
      requireExecutable: input.requireExecutable,
      runtimeConnector,
      snapshot: args.snapshot,
    });
  };

  return {
    resolveRef,

    async resolveMethod(input) {
      const runtimeConnector = getConnectorRuntimeConnector(
        args.snapshot,
        input.connectorRef,
      );
      if (runtimeConnector === undefined) {
        return { ok: false, reason: "unknown_connector" };
      }
      const catalogConnector = runtimeConnector.catalogConnector;
      const catalogMethod = catalogConnector.authMethods.find((method) => {
        return method.id === input.authMethodId;
      });
      if (!catalogMethod) {
        return {
          ok: false,
          reason: "unknown_auth_method",
          catalogConnector,
        };
      }
      if (catalogMethod.grantKind !== input.expectedGrantKind) {
        return {
          ok: false,
          reason: "wrong_grant_kind",
          actualGrantKind: catalogMethod.grantKind,
          catalogConnector,
        };
      }

      if (input.requireAvailable) {
        const availableConnector = await readAvailableConnector(
          input.connectorRef,
        );
        if (!availableConnector) {
          return { ok: false, reason: "unavailable_connector" };
        }
        if (
          !availableConnector.authMethods.some((method) => {
            return method.id === input.authMethodId;
          })
        ) {
          return { ok: false, reason: "unavailable_auth_method" };
        }
      }

      const selectedRef = resolvedRef({
        connectorRef: input.connectorRef,
        requireExecutable: true,
        runtimeConnector,
        snapshot: args.snapshot,
      });
      if (!selectedRef.ok) {
        return selectedRef;
      }
      return executableMethod({
        resolvedRef: selectedRef,
        authMethodId: input.authMethodId,
        catalogMethod,
      });
    },

    async resolveRefs(input) {
      const connectors: ResolvedConnectorRef[] = [];
      for (const connectorRef of input.connectorRefs) {
        const resolved = await resolveRef({
          connectorRef,
          requireAvailable: input.requireAvailable,
          requireExecutable: input.requireExecutable,
        });
        if (!resolved.ok) {
          return { ...resolved, connectorRef };
        }
        connectors.push(resolved);
      }
      return { ok: true, connectors };
    },
  };
}

export function userConnectorActionResolver(
  orgId: string,
  userId: string,
): Computed<Promise<ConnectorActionResolver>> {
  return computed(async (get): Promise<ConnectorActionResolver> => {
    const [overrides, snapshot] = await Promise.all([
      get(userFeatureSwitchOverrides(orgId, userId)),
      loadConnectorRuntimeSnapshot(get(db$)),
    ]);
    return createConnectorActionResolver({
      featureStates: getAllFeatureStates({ orgId, userId, overrides }),
      snapshot,
    });
  });
}

export function userConnectorActionResolverForSnapshot(
  orgId: string,
  userId: string,
  snapshot: ConnectorRuntimeSnapshot,
): Computed<Promise<ConnectorActionResolver>> {
  return computed(async (get): Promise<ConnectorActionResolver> => {
    const overrides = await get(userFeatureSwitchOverrides(orgId, userId));
    return createConnectorActionResolver({
      featureStates: getAllFeatureStates({ orgId, userId, overrides }),
      snapshot,
    });
  });
}
