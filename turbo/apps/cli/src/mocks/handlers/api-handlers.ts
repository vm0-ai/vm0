import { http, HttpResponse } from "msw";
import {
  CONNECTOR_TYPE_KEYS,
  CONNECTOR_TYPES,
  type ConnectorAuthMethodConfig,
  connectorAuthMethodIdSchema,
  type ConnectorAuthMethodId,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import type {
  PublicConnectorCatalogAuthMethodDetail,
  PublicConnectorCatalogItem,
  PublicConnectorCatalogStatusItem,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import {
  getAvailableConnectorAuthMethodIds,
  getConnectorAuthMethod,
  getConnectorGenerationTypes,
  getConnectorTags,
} from "@vm0/connectors/connector-utils";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isConnectorAuthMethodId(
  value: unknown,
): value is ConnectorAuthMethodId {
  return connectorAuthMethodIdSchema.safeParse(value).success;
}

function defaultAvailableConnectors() {
  return CONNECTOR_TYPE_KEYS.map((type) => {
    const authMethods = getAvailableConnectorAuthMethodIds(type, {});
    return { type, authMethods };
  })
    .filter((item) => {
      return item.authMethods.length > 0;
    })
    .map(({ type, authMethods }) => {
      return {
        id: type,
        label: CONNECTOR_TYPES[type].label,
        description: CONNECTOR_TYPES[type].helpText,
        authMethods,
      };
    });
}

function defaultPermissionSummary() {
  return {
    hasPermissions: false,
    permissionCount: 0,
    hasCategories: false,
    hasDefaultPolicyOverrides: false,
  };
}

function defaultManualFieldsForCatalog(
  method: ConnectorAuthMethodConfig,
): PublicConnectorCatalogAuthMethodDetail["manualFields"] {
  if (method.grant.kind !== "manual") {
    return [];
  }
  return Object.values(method.grant.fields).map((field) => {
    return {
      id: field.publicId,
      label: field.label,
      required: field.required,
      placeholder: field.placeholder ?? null,
      inputType: field.storage === "variable" ? "text" : "password",
    };
  });
}

function defaultStartOptionsForCatalog(
  method: ConnectorAuthMethodConfig,
): PublicConnectorCatalogAuthMethodDetail["startOptions"] {
  if (method.grant.kind !== "device-auth") {
    return [];
  }
  return Object.values(method.grant.startOptions ?? {}).map((option) => {
    return {
      id: option.publicId,
      kind: option.kind,
      label: option.label,
      required: option.required,
      defaultValue: option.defaultValue ?? null,
      options: option.options.map((choice) => {
        return { value: choice.value, label: choice.label };
      }),
    };
  });
}

function defaultCatalogAuthMethods(
  type: ConnectorType,
): PublicConnectorCatalogAuthMethodDetail[] {
  return getAvailableConnectorAuthMethodIds(type, {}).flatMap((authMethod) => {
    const method = getConnectorAuthMethod(type, authMethod);
    if (!method) return [];
    return [
      {
        id: authMethod,
        label: method.label,
        description: null,
        grantKind: method.grant.kind,
        manualFields: defaultManualFieldsForCatalog(method),
        startOptions: defaultStartOptionsForCatalog(method),
      },
    ];
  });
}

function defaultPublicCatalogItem(
  type: ConnectorType,
): PublicConnectorCatalogItem | null {
  const authMethods = defaultCatalogAuthMethods(type);
  if (authMethods.length === 0) {
    return null;
  }
  const config = CONNECTOR_TYPES[type];
  return {
    connectorRef: type,
    label: config.label,
    description: config.helpText,
    category: config.category,
    generation: [...getConnectorGenerationTypes(type)],
    tags: [...getConnectorTags(type)],
    authMethods: authMethods.map((authMethod) => {
      return {
        id: authMethod.id,
        label: authMethod.label,
        description: authMethod.description,
        grantKind: authMethod.grantKind,
      };
    }),
    permissionSummary: defaultPermissionSummary(),
  };
}

function defaultPublicCatalog() {
  return CONNECTOR_TYPE_KEYS.flatMap((type) => {
    const item = defaultPublicCatalogItem(type);
    return item ? [item] : [];
  });
}

function defaultPublicCatalogStatusItem(
  type: ConnectorType,
): PublicConnectorCatalogStatusItem | null {
  const item = defaultPublicCatalogItem(type);
  if (!item) {
    return null;
  }
  return {
    ...item,
    authMethods: defaultCatalogAuthMethods(type),
    connection: null,
    connected: false,
    connectionStatus: "not-connected",
    scopeMismatch: false,
    authMethodSupportsRefresh: false,
    tokenExpiresAt: null,
    singleAuthCodeAuthMethodId: null,
    connectNotice: null,
  };
}

function defaultPublicCatalogStatus() {
  return CONNECTOR_TYPE_KEYS.flatMap((type) => {
    const item = defaultPublicCatalogStatusItem(type);
    return item ? [item] : [];
  });
}

function manualGrantAuthMethodFromBody(body: unknown): ConnectorAuthMethodId {
  if (isRecord(body) && isConnectorAuthMethodId(body.authMethod)) {
    return body.authMethod;
  }
  return "api-token";
}

function connectorManualGrantResponse(
  type: string,
  authMethod: ConnectorAuthMethodId,
) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    type,
    authMethod,
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: null,
    connectionStatus: "connected",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

export const apiHandlers = [
  // GET /api/agent/composes - getComposeByName
  http.get("http://localhost:3000/api/agent/composes", () => {
    return HttpResponse.json(
      { error: "Not found", message: "Compose not found" },
      { status: 404 },
    );
  }),

  // POST /api/agent/composes - createOrUpdateCompose
  http.post("http://localhost:3000/api/agent/composes", () => {
    return HttpResponse.json(
      { composeId: "default", name: "default", action: "created" },
      { status: 201 },
    );
  }),

  // POST /api/agent/runs - createRun
  http.post("http://localhost:3000/api/agent/runs", () => {
    return HttpResponse.json(
      {
        runId: "default",
        status: "pending",
        createdAt: new Date().toISOString(),
      },
      { status: 201 },
    );
  }),

  // GET /api/agent/runs/:id/events - getEvents
  http.get("http://localhost:3000/api/agent/runs/:id/events", () => {
    return HttpResponse.json(
      { events: [], hasMore: false, nextSequence: 0 },
      { status: 200 },
    );
  }),

  // GET /api/agent/composes/versions - getComposeVersion
  http.get("http://localhost:3000/api/agent/composes/versions", () => {
    return HttpResponse.json({ versionId: "default" }, { status: 200 });
  }),

  // GET /api/zero/secrets - listZeroSecrets
  http.get("http://localhost:3000/api/zero/secrets", () => {
    return HttpResponse.json({ secrets: [] }, { status: 200 });
  }),

  // GET /api/zero/variables - listZeroVariables
  http.get("http://localhost:3000/api/zero/variables", () => {
    return HttpResponse.json({ variables: [] }, { status: 200 });
  }),

  // GET /api/zero/connectors - listZeroConnectors
  http.get("http://localhost:3000/api/zero/connectors", () => {
    return HttpResponse.json(
      { connectors: [], configuredTypes: [], connectorProvidedBindings: [] },
      { status: 200 },
    );
  }),
  http.get("https://www.vm0.ai/api/zero/connectors", () => {
    return HttpResponse.json(
      { connectors: [], configuredTypes: [], connectorProvidedBindings: [] },
      { status: 200 },
    );
  }),

  // GET /api/zero/connector-catalog - list public connector catalog
  http.get("http://localhost:3000/api/zero/connector-catalog", () => {
    return HttpResponse.json(
      { connectors: defaultPublicCatalog() },
      { status: 200 },
    );
  }),
  http.get("https://app.vm0.ai/api/zero/connector-catalog", () => {
    return HttpResponse.json(
      { connectors: defaultPublicCatalog() },
      { status: 200 },
    );
  }),
  http.get("https://www.vm0.ai/api/zero/connector-catalog", () => {
    return HttpResponse.json(
      { connectors: defaultPublicCatalog() },
      { status: 200 },
    );
  }),

  // GET /api/zero/connector-catalog/status - public catalog with connection status
  http.get("http://localhost:3000/api/zero/connector-catalog/status", () => {
    return HttpResponse.json(
      { connectors: defaultPublicCatalogStatus() },
      { status: 200 },
    );
  }),
  http.get("https://app.vm0.ai/api/zero/connector-catalog/status", () => {
    return HttpResponse.json(
      { connectors: defaultPublicCatalogStatus() },
      { status: 200 },
    );
  }),
  http.get("https://www.vm0.ai/api/zero/connector-catalog/status", () => {
    return HttpResponse.json(
      { connectors: defaultPublicCatalogStatus() },
      { status: 200 },
    );
  }),
  http.post(
    "http://localhost:3000/api/zero/connectors/:type/manual-grant",
    async ({ params, request }) => {
      const body: unknown = await request.json();
      return HttpResponse.json(
        connectorManualGrantResponse(
          String(params.type),
          manualGrantAuthMethodFromBody(body),
        ),
      );
    },
  ),
  http.post(
    "https://app.vm0.ai/api/zero/connectors/:type/manual-grant",
    async ({ params, request }) => {
      const body: unknown = await request.json();
      return HttpResponse.json(
        connectorManualGrantResponse(
          String(params.type),
          manualGrantAuthMethodFromBody(body),
        ),
      );
    },
  ),
  http.post(
    "https://www.vm0.ai/api/zero/connectors/:type/manual-grant",
    async ({ params, request }) => {
      const body: unknown = await request.json();
      return HttpResponse.json(
        connectorManualGrantResponse(
          String(params.type),
          manualGrantAuthMethodFromBody(body),
        ),
      );
    },
  ),

  // GET /api/zero/connectors/search - searchZeroConnectors
  http.get("http://localhost:3000/api/zero/connectors/search", () => {
    return HttpResponse.json(
      { connectors: defaultAvailableConnectors() },
      { status: 200 },
    );
  }),
  http.get("https://app.vm0.ai/api/zero/connectors/search", () => {
    return HttpResponse.json(
      { connectors: defaultAvailableConnectors() },
      { status: 200 },
    );
  }),
  http.get("https://www.vm0.ai/api/zero/connectors/search", () => {
    return HttpResponse.json(
      { connectors: defaultAvailableConnectors() },
      { status: 200 },
    );
  }),

  // GET /api/zero/org - getZeroOrg
  http.get("http://localhost:3000/api/zero/org", () => {
    return HttpResponse.json(
      {
        id: "org-default",
        slug: "user-default",
        displayName: null,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      },
      { status: 200 },
    );
  }),
];
