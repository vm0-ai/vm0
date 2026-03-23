/**
 * Agents API Handlers
 *
 * Mock handlers for agent-related endpoints.
 * Default behavior: user has one agent.
 */

import { http, HttpResponse } from "msw";

export const apiAgentsHandlers = [
  // GET /api/zero/team
  http.get("/api/zero/team", () => {
    return HttpResponse.json({
      composes: [
        {
          id: "mock-compose-id",
          name: "zero",
          displayName: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
          isOwner: true,
        },
      ],
    });
  }),

  // GET /api/zero/composes/list
  http.get("/api/zero/composes/list", () => {
    return HttpResponse.json({
      composes: [
        {
          id: "mock-compose-id",
          name: "zero",
          displayName: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ],
    });
  }),

  // GET /api/zero/composes/:id (kept for backwards compat with other tests)
  http.get("/api/zero/composes/:id", ({ params }) => {
    // Skip if it matches a sub-route like "list"
    if (params.id === "list") {
      return;
    }

    return HttpResponse.json({
      id: params.id,
      name: "zero",
      headVersionId: "version_1",
      content: {
        version: "1",
        agents: { zero: { framework: "claude-code" } },
      },
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });
  }),

  // GET /api/zero/agents/:name
  http.get("/api/zero/agents/:name", ({ params }) => {
    // Skip if it matches sub-routes like "instructions"
    if (
      params.name === "instructions" ||
      (typeof params.name === "string" && params.name.includes("/"))
    ) {
      return;
    }

    return HttpResponse.json({
      name: params.name,
      agentComposeId: "mock-compose-id",
      description: null,
      displayName: null,
      sound: null,
      connectors: [],
    });
  }),

  // GET /api/zero/agents/:name/instructions
  http.get("/api/zero/agents/:name/instructions", () => {
    return HttpResponse.json({
      content: null,
      filename: null,
    });
  }),

  // GET /api/zero/schedules
  http.get("/api/zero/schedules", () => {
    return HttpResponse.json({ schedules: [] });
  }),
];
