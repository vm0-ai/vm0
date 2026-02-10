import { http, HttpResponse } from "msw";

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

  // GET /api/secrets - listSecrets
  http.get("http://localhost:3000/api/secrets", () => {
    return HttpResponse.json({ secrets: [] }, { status: 200 });
  }),

  // GET /api/variables - listVariables
  http.get("http://localhost:3000/api/variables", () => {
    return HttpResponse.json({ variables: [] }, { status: 200 });
  }),

  // GET /api/connectors - listConnectors
  http.get("http://localhost:3000/api/connectors", () => {
    return HttpResponse.json({ connectors: [] }, { status: 200 });
  }),

  // GET /api/scope - getScope
  http.get("http://localhost:3000/api/scope", () => {
    return HttpResponse.json(
      {
        id: "scope-default",
        slug: "user-default",
        type: "personal",
        displayName: null,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      },
      { status: 200 },
    );
  }),
];
