import { http, HttpResponse } from "msw";
import {
  CONNECTOR_TYPES,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import { getAvailableConnectorAuthMethods } from "@vm0/connectors/connector-utils";

function defaultAvailableConnectors() {
  return (Object.keys(CONNECTOR_TYPES) as ConnectorType[])
    .map((type) => {
      const authMethods = getAvailableConnectorAuthMethods(type, {});
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
      { connectors: [], configuredTypes: [], connectorProvidedSecretNames: [] },
      { status: 200 },
    );
  }),

  // GET /api/zero/connectors/search - searchZeroConnectors
  http.get("http://localhost:3000/api/zero/connectors/search", () => {
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
