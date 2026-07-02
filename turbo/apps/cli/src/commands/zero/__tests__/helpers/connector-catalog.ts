import { http, HttpResponse } from "msw";
import type {
  PublicConnectorCatalogAuthMethodDetail,
  PublicConnectorCatalogManualField,
  PublicConnectorCatalogStatusItem,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";

function permissionSummary(): PublicConnectorCatalogStatusItem["permissionSummary"] {
  return {
    hasPermissions: false,
    permissionCount: 0,
    hasCategories: false,
    hasDefaultPolicyOverrides: false,
  };
}

function manualField(
  id: string,
  label = id,
): PublicConnectorCatalogManualField {
  return {
    id,
    label,
    required: true,
    placeholder: null,
    inputType: "password",
  };
}

export function manualAuthMethod(
  id = "api-token",
  fields: readonly PublicConnectorCatalogManualField[] = [
    manualField("apiKey"),
  ],
): PublicConnectorCatalogAuthMethodDetail {
  return {
    id,
    label: id,
    description: null,
    grantKind: "manual",
    manualFields: [...fields],
    startOptions: [],
  };
}

export function authCodeMethod(
  id = "oauth",
): PublicConnectorCatalogAuthMethodDetail {
  return {
    id,
    label: id,
    description: null,
    grantKind: "auth-code",
    manualFields: [],
    startOptions: [],
  };
}

export function catalogStatusItem(
  overrides: Partial<PublicConnectorCatalogStatusItem> & {
    readonly connectorRef: string;
  },
): PublicConnectorCatalogStatusItem {
  const connection = overrides.connection ?? null;
  const connectionStatus =
    overrides.connectionStatus ?? (connection ? "connected" : "not-connected");
  return {
    connectorRef: overrides.connectorRef,
    label: overrides.label ?? overrides.connectorRef,
    description: overrides.description ?? `${overrides.connectorRef} connector`,
    category: overrides.category ?? "developer-tools",
    generation: overrides.generation ?? [],
    tags: overrides.tags ?? [],
    authMethods: overrides.authMethods ?? [],
    permissionSummary: overrides.permissionSummary ?? permissionSummary(),
    connection,
    connected: overrides.connected ?? connection !== null,
    connectionStatus,
    scopeMismatch:
      overrides.scopeMismatch ?? connectionStatus === "scope-mismatch",
    authMethodSupportsRefresh: overrides.authMethodSupportsRefresh ?? false,
    tokenExpiresAt: overrides.tokenExpiresAt ?? null,
    singleAuthCodeAuthMethodId: overrides.singleAuthCodeAuthMethodId ?? null,
    connectNotice: overrides.connectNotice ?? null,
  };
}

export function stubConnectorCatalogStatus(
  connectors: readonly PublicConnectorCatalogStatusItem[],
) {
  return http.get(
    "http://localhost:3000/api/zero/connector-catalog/status",
    () => {
      return HttpResponse.json({ connectors });
    },
  );
}
