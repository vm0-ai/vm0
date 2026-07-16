import { computed, type Computed } from "ccstate";
import type {
  ConnectorCatalogAuthMethodId,
  ConnectorCatalogRef,
} from "@vm0/api-contracts/contracts/connector-identity";
import type {
  PublicConnectorCatalogAuthMethodDetail,
  PublicConnectorCatalogDetail,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import {
  connectorAuthMethodIdSchema,
  connectorTypeSchema,
  type ConnectorAuthMethodConfig,
  type ConnectorAuthMethodId,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import { getConnectorAuthProviderRegistryCapabilities } from "@vm0/connectors/auth-providers";
import { getConnectorAuthMethod } from "@vm0/connectors/connector-utils";
import { getAllFeatureStates } from "@vm0/core/feature-switch";

import {
  getStaticConnectorCatalogResolutionDetail,
  getStaticPublicConnectorCatalogDetail,
} from "./connector-catalog-reader.service";
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

export type ResolvedConnectorExecutableRef = {
  readonly ok: true;
  readonly connectorRef: ConnectorCatalogRef;
  readonly catalogConnector: PublicConnectorCatalogDetail;
  readonly type: ConnectorType;
};

export type ResolvedConnectorActionMethod = ResolvedConnectorExecutableRef & {
  readonly authMethodId: ConnectorCatalogAuthMethodId;
  readonly catalogMethod: PublicConnectorCatalogAuthMethodDetail;
  readonly authMethod: ConnectorAuthMethodId;
  readonly method: ConnectorAuthMethodConfig;
};

export type ConnectorExecutableRefResolution =
  | ResolvedConnectorExecutableRef
  | ConnectorRefResolutionFailure;

export type ConnectorActionMethodResolution =
  | ResolvedConnectorActionMethod
  | ConnectorActionResolutionFailure;

export type ConnectorExecutableRefsResolution =
  | {
      readonly ok: true;
      readonly connectors: readonly ResolvedConnectorExecutableRef[];
    }
  | (ConnectorRefResolutionFailure & {
      readonly connectorRef: ConnectorCatalogRef;
    });

export interface ConnectorActionResolver {
  readonly resolveRef: (args: {
    readonly connectorRef: ConnectorCatalogRef;
    readonly requireAvailable: boolean;
  }) => Promise<ConnectorExecutableRefResolution>;
  readonly resolveMethod: (args: {
    readonly connectorRef: ConnectorCatalogRef;
    readonly authMethodId: ConnectorCatalogAuthMethodId;
    readonly expectedGrantKind: ConnectorCatalogGrantKind;
  }) => Promise<ConnectorActionMethodResolution>;
  readonly resolveRefs: (args: {
    readonly connectorRefs: readonly ConnectorCatalogRef[];
    readonly requireAvailable: boolean;
  }) => Promise<ConnectorExecutableRefsResolution>;
}

function providerBackedGrantKind(
  grantKind: ConnectorCatalogGrantKind,
): grantKind is "auth-code" | "device-auth" | "external-code" | "openid-auth" {
  return (
    grantKind === "auth-code" ||
    grantKind === "device-auth" ||
    grantKind === "external-code" ||
    grantKind === "openid-auth"
  );
}

function executableRef(
  connectorRef: ConnectorCatalogRef,
  catalogConnector: PublicConnectorCatalogDetail,
): ResolvedConnectorExecutableRef | ConnectorRefResolutionFailure {
  const type = connectorTypeSchema.safeParse(connectorRef);
  if (!type.success) {
    return { ok: false, reason: "missing_executable_capability" };
  }
  return { ok: true, connectorRef, catalogConnector, type: type.data };
}

const CONNECTOR_AUTH_PROVIDER_CAPABILITIES =
  getConnectorAuthProviderRegistryCapabilities();

function executableMethod(args: {
  readonly resolvedRef: ResolvedConnectorExecutableRef;
  readonly authMethodId: ConnectorCatalogAuthMethodId;
  readonly catalogMethod: PublicConnectorCatalogAuthMethodDetail;
}): ResolvedConnectorActionMethod | ConnectorActionResolutionFailure {
  const authMethod = connectorAuthMethodIdSchema.safeParse(args.authMethodId);
  if (!authMethod.success) {
    return { ok: false, reason: "missing_executable_capability" };
  }
  const method = getConnectorAuthMethod(args.resolvedRef.type, authMethod.data);
  if (!method || method.grant.kind !== args.catalogMethod.grantKind) {
    return { ok: false, reason: "missing_executable_capability" };
  }
  if (providerBackedGrantKind(args.catalogMethod.grantKind)) {
    const capability =
      CONNECTOR_AUTH_PROVIDER_CAPABILITIES[args.resolvedRef.type]?.[
        authMethod.data
      ];
    if (capability?.grant !== args.catalogMethod.grantKind) {
      return { ok: false, reason: "missing_executable_capability" };
    }
  }
  return {
    ...args.resolvedRef,
    authMethodId: args.authMethodId,
    catalogMethod: args.catalogMethod,
    authMethod: authMethod.data,
    method,
  };
}

function createConnectorActionResolver(args: {
  readonly featureStates: ReturnType<typeof getAllFeatureStates>;
}): ConnectorActionResolver {
  const readAvailableConnector = async (connectorRef: ConnectorCatalogRef) => {
    return await getStaticPublicConnectorCatalogDetail({
      connectorRef,
      featureStates: args.featureStates,
      apiAuthMethodPolicy: "include",
    });
  };

  const resolveRef: ConnectorActionResolver["resolveRef"] = async (input) => {
    const catalogConnector = await getStaticConnectorCatalogResolutionDetail(
      input.connectorRef,
    );
    if (!catalogConnector) {
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
    return executableRef(input.connectorRef, catalogConnector);
  };

  return {
    resolveRef,

    async resolveMethod(input) {
      const catalogConnector = await getStaticConnectorCatalogResolutionDetail(
        input.connectorRef,
      );
      if (!catalogConnector) {
        return { ok: false, reason: "unknown_connector" };
      }
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

      const resolvedRef = executableRef(input.connectorRef, catalogConnector);
      if (!resolvedRef.ok) {
        return resolvedRef;
      }
      return executableMethod({
        resolvedRef,
        authMethodId: input.authMethodId,
        catalogMethod,
      });
    },

    async resolveRefs(input) {
      const connectors: ResolvedConnectorExecutableRef[] = [];
      for (const connectorRef of input.connectorRefs) {
        const resolved = await resolveRef({
          connectorRef,
          requireAvailable: input.requireAvailable,
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
    const overrides = await get(userFeatureSwitchOverrides(orgId, userId));
    return createConnectorActionResolver({
      featureStates: getAllFeatureStates({ orgId, userId, overrides }),
    });
  });
}
