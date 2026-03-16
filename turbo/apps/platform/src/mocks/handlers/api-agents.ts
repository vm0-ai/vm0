/**
 * Agents API Handlers
 *
 * Mock handlers for agent-related endpoints.
 * Default behavior: user has one agent.
 */

import { http, HttpResponse } from "msw";

export const apiAgentsHandlers = [
  // GET /api/agent/composes/list
  http.get("/api/agent/composes/list", () => {
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

  // GET /api/agent/composes/:id
  http.get("/api/agent/composes/:id", ({ params }) => {
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

  // GET /api/agent/composes/:id/instructions
  http.get("/api/agent/composes/:id/instructions", () => {
    return HttpResponse.json({
      content: null,
      filename: null,
    });
  }),

  // GET /api/agent/schedules
  http.get("/api/agent/schedules", () => {
    return HttpResponse.json({ schedules: [] });
  }),

  // GET /api/agent/required-env
  http.get("/api/agent/required-env", () => {
    return HttpResponse.json({ agents: [] });
  }),
];
