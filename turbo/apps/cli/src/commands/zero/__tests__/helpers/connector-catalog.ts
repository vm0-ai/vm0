import { http, HttpResponse } from "msw";
import type {
  PublicConnectorCatalogAuthMethodDetail,
  PublicConnectorCatalogAuthMethodSummary,
  PublicConnectorCatalogItem,
  PublicConnectorCatalogManualField,
  PublicConnectorCatalogPermissionDetail,
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

function authMethodSummary(
  method: PublicConnectorCatalogAuthMethodSummary,
): PublicConnectorCatalogAuthMethodSummary {
  return {
    id: method.id,
    label: method.label,
    description: method.description,
    grantKind: method.grantKind,
  };
}

export function catalogItem(
  overrides: Partial<PublicConnectorCatalogItem> & {
    readonly connectorSlug: string;
  },
): PublicConnectorCatalogItem {
  return {
    connectorRef: overrides.connectorSlug,
    slug: overrides.connectorSlug,
    label: overrides.label ?? overrides.connectorSlug,
    description:
      overrides.description ?? `${overrides.connectorSlug} connector`,
    icon: overrides.icon ?? {
      url: `https://icons.example.test/${overrides.connectorSlug}.svg`,
      invertInDarkMode: false,
    },
    category: overrides.category ?? "developer-tools",
    generation: overrides.generation ?? [],
    tags: overrides.tags ?? [],
    authMethods: (overrides.authMethods ?? []).map(authMethodSummary),
    permissionSummary: overrides.permissionSummary ?? permissionSummary(),
  };
}

export function catalogStatusItem(
  overrides: Partial<PublicConnectorCatalogStatusItem> & {
    readonly connectorSlug: string;
  },
): PublicConnectorCatalogStatusItem {
  const connection = overrides.connection ?? null;
  const connectionStatus =
    overrides.connectionStatus ?? (connection ? "connected" : "not-connected");
  return {
    connectorRef: overrides.connectorSlug,
    slug: overrides.connectorSlug,
    label: overrides.label ?? overrides.connectorSlug,
    description:
      overrides.description ?? `${overrides.connectorSlug} connector`,
    icon: overrides.icon ?? {
      url: `https://icons.example.test/${overrides.connectorSlug}.svg`,
      invertInDarkMode: false,
    },
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

export function catalogPermissionDetail(
  overrides: Partial<PublicConnectorCatalogPermissionDetail> & {
    readonly connectorSlug: string;
  },
): PublicConnectorCatalogPermissionDetail {
  const permissions = overrides.permissions ?? [];
  return {
    connectorRef: overrides.connectorSlug,
    connectorSlug: overrides.connectorSlug,
    label: overrides.label ?? overrides.connectorSlug,
    icon: overrides.icon ?? {
      url: `https://icons.example.test/${overrides.connectorSlug}.svg`,
      invertInDarkMode: false,
    },
    permissionCount: overrides.permissionCount ?? permissions.length,
    permissions,
    categories: overrides.categories ?? null,
    defaultPolicy: overrides.defaultPolicy ?? {
      permissionDefault: "allow",
      unknownPolicy: "allow",
    },
  };
}

export function stubConnectorCatalog(
  connectors: readonly PublicConnectorCatalogItem[],
) {
  return http.get("http://localhost:3000/api/zero/connector-catalog", () => {
    return HttpResponse.json({ connectors });
  });
}

export function stubConnectorCatalogStatus(
  connectors: readonly PublicConnectorCatalogStatusItem[],
  origin = "http://localhost:3000",
) {
  return http.get(`${origin}/api/zero/connector-catalog/status`, () => {
    return HttpResponse.json({ connectors });
  });
}

export function stubConnectorCatalogPermissions(
  details: readonly PublicConnectorCatalogPermissionDetail[],
  origin = "http://localhost:3000",
) {
  const detailsBySlug = new Map(
    details.map((detail) => {
      return [detail.connectorSlug ?? detail.connectorRef, detail] as const;
    }),
  );
  return http.get(
    `${origin}/api/zero/connector-catalog/:connectorSlug/permissions`,
    ({ params }) => {
      const connectorSlug = String(params.connectorSlug);
      const permissions = detailsBySlug.get(connectorSlug);
      if (!permissions) {
        return HttpResponse.json(
          {
            error: {
              message: "Connector catalog item not found",
              code: "NOT_FOUND",
            },
          },
          { status: 404 },
        );
      }
      return HttpResponse.json({ permissions });
    },
  );
}
