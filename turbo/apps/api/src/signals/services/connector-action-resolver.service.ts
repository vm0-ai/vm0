import { computed, type Computed } from "ccstate";
import type {
  ConnectorAuthMethodId,
  ConnectorRef,
} from "@vm0/api-contracts/contracts/connector-identity";
import type {
  PublicConnectorCatalogAuthMethodDetail,
  PublicConnectorCatalogDetail,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import type { ConnectorAuthMethodRuntimeConfig } from "@vm0/connectors/connectors";

import { db$ } from "../external/db";
import {
  getConnectorRuntimeConnector,
  getConnectorRuntimeMethod,
  loadConnectorRuntimeSnapshot,
  type ConnectorRuntimeConnector,
  type ConnectorRuntimeMethod,
  type ConnectorRuntimeSnapshot,
} from "./connector-catalog-runtime.service";

type ConnectorCatalogGrantKind =
  PublicConnectorCatalogAuthMethodDetail["grantKind"];

export type ConnectorRefResolutionFailure =
  | { readonly ok: false; readonly reason: "unknown_connector" }
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
  | { readonly ok: false; readonly reason: "hidden_auth_method" };

export type ResolvedConnectorRef = {
  readonly ok: true;
  readonly connectorRef: ConnectorRef;
  readonly catalogConnector: PublicConnectorCatalogDetail;
  readonly runtimeConnector: ConnectorRuntimeConnector;
  readonly snapshot: ConnectorRuntimeSnapshot;
};

export type ResolvedConnectorActionMethod = ResolvedConnectorRef & {
  readonly authMethodId: ConnectorAuthMethodId;
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
      readonly connectorRef: ConnectorRef;
    });

/**
 * Resolves connector execution contracts, never connector discovery policy.
 *
 * Feature switches only filter UI/discovery projections. They are not
 * authorization or compatibility boundaries and are never read here. Authored
 * method visibility is separate: it controls new actions through
 * resolveNewActionMethod, while resolveMethod deliberately lets in-flight and
 * persisted credentials continue. Execution fails closed when the connector or
 * method is absent, has the wrong grant kind, is incompatible, or lacks its
 * local executable capability.
 */
export interface ConnectorActionResolver {
  readonly resolveRef: (args: {
    readonly connectorRef: ConnectorRef;
    readonly requireExecutable: boolean;
  }) => ConnectorRefResolution;
  readonly resolveMethod: (args: {
    readonly connectorRef: ConnectorRef;
    readonly authMethodId: ConnectorAuthMethodId;
    readonly expectedGrantKind: ConnectorCatalogGrantKind;
  }) => ConnectorActionMethodResolution;
  readonly resolveNewActionMethod: (args: {
    readonly connectorRef: ConnectorRef;
    readonly authMethodId: ConnectorAuthMethodId;
    readonly expectedGrantKind: ConnectorCatalogGrantKind;
  }) => ConnectorActionMethodResolution;
  readonly resolveRefs: (args: {
    readonly connectorRefs: readonly ConnectorRef[];
    readonly requireExecutable: boolean;
  }) => ConnectorRefsResolution;
}

function resolvedRef(args: {
  readonly connectorRef: ConnectorRef;
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
  readonly authMethodId: ConnectorAuthMethodId;
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

function createConnectorActionResolver(
  snapshot: ConnectorRuntimeSnapshot,
): ConnectorActionResolver {
  const resolveRef: ConnectorActionResolver["resolveRef"] = (input) => {
    const runtimeConnector = getConnectorRuntimeConnector(
      snapshot,
      input.connectorRef,
    );
    if (runtimeConnector === undefined) {
      return { ok: false, reason: "unknown_connector" };
    }
    return resolvedRef({
      connectorRef: input.connectorRef,
      requireExecutable: input.requireExecutable,
      runtimeConnector,
      snapshot,
    });
  };

  const resolveMethod: ConnectorActionResolver["resolveMethod"] = (input) => {
    const runtimeConnector = getConnectorRuntimeConnector(
      snapshot,
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

    const selectedRef = resolvedRef({
      connectorRef: input.connectorRef,
      requireExecutable: true,
      runtimeConnector,
      snapshot,
    });
    if (!selectedRef.ok) {
      return selectedRef;
    }
    return executableMethod({
      resolvedRef: selectedRef,
      authMethodId: input.authMethodId,
      catalogMethod,
    });
  };

  return {
    resolveRef,
    resolveMethod,

    resolveNewActionMethod(input) {
      const runtimeConnector = getConnectorRuntimeConnector(
        snapshot,
        input.connectorRef,
      );
      const catalogMethod = runtimeConnector?.catalogConnector.authMethods.find(
        (method) => {
          return method.id === input.authMethodId;
        },
      );
      if (catalogMethod?.grantKind === input.expectedGrantKind) {
        if (
          !runtimeConnector?.authoredVisibleMethodIds.has(input.authMethodId)
        ) {
          return { ok: false, reason: "hidden_auth_method" };
        }
      }

      return resolveMethod(input);
    },

    resolveRefs(input) {
      const connectors: ResolvedConnectorRef[] = [];
      for (const connectorRef of input.connectorRefs) {
        const resolved = resolveRef({
          connectorRef,
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

export function connectorActionResolver(): Computed<
  Promise<ConnectorActionResolver>
> {
  return computed(async (get): Promise<ConnectorActionResolver> => {
    const snapshot = await loadConnectorRuntimeSnapshot(get(db$));
    return createConnectorActionResolver(snapshot);
  });
}

export function connectorActionResolverForSnapshot(
  snapshot: ConnectorRuntimeSnapshot,
): Computed<ConnectorActionResolver> {
  return computed((): ConnectorActionResolver => {
    return createConnectorActionResolver(snapshot);
  });
}
