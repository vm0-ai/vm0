/**
 * Agents API Handlers
 *
 * Mock handlers for agent-related endpoints.
 * Default behavior: user has one agent.
 */

import { http, HttpResponse } from "msw";

export const apiAgentsHandlers = [
  // GET /api/zero/team
  http.get("*/api/zero/team", () => {
    return HttpResponse.json([
      {
        id: "c0000000-0000-4000-a000-000000000001",
        displayName: null,
        description: null,
        sound: null,
        avatarUrl: null,
        headVersionId: "version_1",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);
  }),

  // GET /api/zero/composes/list
  http.get("*/api/zero/composes/list", () => {
    return HttpResponse.json({
      composes: [
        {
          id: "c0000000-0000-4000-a000-000000000001",
          name: "zero",
          displayName: null,
          description: null,
          sound: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ],
    });
  }),

  // GET /api/zero/composes/:id (kept for backwards compat with other tests)
  http.get("*/api/zero/composes/:id", ({ params }) => {
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

  // GET /api/zero/agents/:id/user-connectors
  http.get("*/api/zero/agents/:id/user-connectors", () => {
    return HttpResponse.json({ enabledTypes: [] });
  }),

  // PUT /api/zero/agents/:id/user-connectors
  http.put("*/api/zero/agents/:id/user-connectors", async ({ request }) => {
    const body = (await request.json()) as { enabledTypes: string[] };
    return HttpResponse.json({ enabledTypes: body.enabledTypes ?? [] });
  }),

  // GET /api/zero/agents/:name
  http.get("*/api/zero/agents/:name", ({ params }) => {
    // Skip if it matches sub-routes like "instructions"
    if (
      params.name === "instructions" ||
      (typeof params.name === "string" && params.name.includes("/"))
    ) {
      return;
    }

    return HttpResponse.json({
      agentId: "c0000000-0000-4000-a000-000000000001",
      ownerId: "test-user-123",
      description: null,
      displayName: null,
      sound: null,
      avatarUrl: null,
      permissionPolicies: null,
    });
  }),

  // GET /api/zero/agents/:name/instructions
  http.get("*/api/zero/agents/:name/instructions", () => {
    return HttpResponse.json({
      content: null,
      filename: null,
    });
  }),

  // GET /api/zero/schedules
  http.get("*/api/zero/schedules", () => {
    return HttpResponse.json({ schedules: [] });
  }),

  // GET /api/zero/chat-threads
  http.get("*/api/zero/chat-threads", () => {
    return HttpResponse.json({ threads: [] });
  }),

  // POST /api/zero/chat-threads (create new thread)
  http.post("*/api/zero/chat-threads", () => {
    return HttpResponse.json(
      {
        id: "b0000000-0000-4000-a000-000000000001",
        title: null,
        createdAt: "2026-03-10T00:00:00Z",
      },
      { status: 201 },
    );
  }),

  // GET /api/zero/chat-threads/:id (thread detail)
  http.get("*/api/zero/chat-threads/:id", () => {
    return HttpResponse.json({
      id: "b0000000-0000-4000-a000-000000000001",
      title: null,
      agentId: "c0000000-0000-4000-a000-000000000001",
      chatMessages: [],
      latestSessionId: null,
      unsavedRuns: [],
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:00:00Z",
    });
  }),
];
