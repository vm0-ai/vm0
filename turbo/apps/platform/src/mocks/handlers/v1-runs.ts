/**
 * v1 API Runs Handlers
 *
 * Mock handlers for /v1/runs endpoint
 */

import { http, HttpResponse } from "msw";
import type { LogResponse, Run } from "../../signals/logs-page/types.ts";

// Mock data
const mockRuns: Run[] = [
  {
    id: "run_1",
    agent_id: "agent_1",
    agent_name: "Test Agent",
    status: "completed",
    prompt: "Test prompt",
    created_at: "2024-01-01T00:00:00Z",
    started_at: "2024-01-01T00:00:01Z",
    completed_at: "2024-01-01T00:00:10Z",
  },
  {
    id: "run_2",
    agent_id: "agent_2",
    agent_name: "Another Agent",
    status: "completed",
    prompt: "Another prompt",
    created_at: "2024-01-02T00:00:00Z",
    started_at: "2024-01-02T00:00:01Z",
    completed_at: "2024-01-02T00:00:10Z",
  },
];

export const v1RunsHandlers = [
  // GET /v1/runs - List runs
  http.get("/v1/runs", ({ request }) => {
    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor");
    const limit = Number.parseInt(url.searchParams.get("limit") || "20", 10);

    // Simple pagination logic
    const cursorIndex = cursor
      ? mockRuns.findIndex((r) => r.id === cursor) + 1
      : 0;
    const data = mockRuns.slice(cursorIndex, cursorIndex + limit);
    const hasMore = cursorIndex + limit < mockRuns.length;
    const nextCursor = hasMore ? data[data.length - 1]?.id || null : null;

    const response: LogResponse = {
      data,
      pagination: {
        has_more: hasMore,
        next_cursor: nextCursor,
      },
    };

    return HttpResponse.json(response);
  }),
];
