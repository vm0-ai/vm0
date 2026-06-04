import { http, HttpResponse } from "msw";
import {
  CONNECTOR_TYPE_KEYS,
  CONNECTOR_TYPES,
  connectorAuthMethodIdSchema,
  type ConnectorAuthMethodId,
} from "@vm0/connectors/connectors";
import { getAvailableConnectorAuthMethodIds } from "@vm0/connectors/connector-utils";

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
    needsReconnect: false,
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
