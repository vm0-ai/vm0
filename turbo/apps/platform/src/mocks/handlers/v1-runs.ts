/**
 * Platform Logs API Handlers
 *
 * Mock handlers for /api/platform/logs endpoints
 */

import { http, HttpResponse } from "msw";
import type {
  LogsListResponse,
  LogDetail,
} from "../../signals/logs-page/types.ts";

// Mock data for log details
const mockLogDetails: LogDetail[] = [
  {
    id: "run_1",
    sessionId: "session_1",
    agentName: "Test Agent",
    framework: "claude-code",
    status: "completed",
    prompt: "Test prompt",
    error: null,
    createdAt: "2024-01-01T00:00:00Z",
    startedAt: "2024-01-01T00:00:01Z",
    completedAt: "2024-01-01T00:00:10Z",
    artifact: {
      name: "test-artifact",
      version: "1.0.0",
    },
  },
  {
    id: "run_2",
    sessionId: "session_2",
    agentName: "Another Agent",
    framework: "claude-code",
    status: "completed",
    prompt: "Another prompt",
    error: null,
    createdAt: "2024-01-02T00:00:00Z",
    startedAt: "2024-01-02T00:00:01Z",
    completedAt: "2024-01-02T00:00:10Z",
    artifact: {
      name: null,
      version: null,
    },
  },
];

export const platformLogsHandlers = [
  // GET /api/platform/logs - List logs (returns only IDs)
  http.get("*/api/platform/logs", ({ request }) => {
    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor");
    const limit = Number.parseInt(url.searchParams.get("limit") || "20", 10);

    // Simple pagination logic
    const cursorIndex = cursor
      ? mockLogDetails.findIndex((r) => r.id === cursor) + 1
      : 0;
    const data = mockLogDetails.slice(cursorIndex, cursorIndex + limit);
    const hasMore = cursorIndex + limit < mockLogDetails.length;
    const nextCursor = hasMore ? data[data.length - 1]?.id || null : null;

    const response: LogsListResponse = {
      data: data.map((log) => ({ id: log.id })),
      pagination: {
        has_more: hasMore,
        next_cursor: nextCursor,
      },
    };

    return HttpResponse.json(response);
  }),

  // GET /api/platform/logs/:id - Get log detail
  http.get("*/api/platform/logs/:id", ({ params }) => {
    const { id } = params;
    const logDetail = mockLogDetails.find((log) => log.id === id);

    if (!logDetail) {
      return HttpResponse.json(
        { error: { message: "Log not found", code: "NOT_FOUND" } },
        { status: 404 },
      );
    }

    return HttpResponse.json(logDetail);
  }),
];
