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
          id: "compose_1",
          name: "default-agent",
          headVersionId: "version_1",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ],
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
