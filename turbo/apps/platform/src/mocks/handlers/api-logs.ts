/**
 * App Logs API Handlers
 *
 * Mock handlers for /api/zero/logs endpoints
 */

import {
  logsListContract,
  logsByIdContract,
  type LogDetail,
} from "@vm0/api-contracts/contracts/logs";
import { mockApi } from "../msw-contract.ts";

// Mock data for log details
const mockLogDetails: LogDetail[] = [
  {
    id: "a0000000-0000-4000-a000-000000000001",
    sessionId: "session_1",
    agentId: "test-agent",
    displayName: null,
    framework: "claude-code",
    modelProvider: null,
    selectedModel: null,
    triggerSource: "web",
    triggerAgentName: null,
    scheduleId: null,
    status: "completed",
    prompt: "Test prompt",
    appendSystemPrompt: null,
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
    id: "a0000000-0000-4000-a000-000000000002",
    sessionId: "session_2",
    agentId: "another-agent",
    displayName: null,
    framework: "claude-code",
    modelProvider: null,
    selectedModel: null,
    triggerSource: "cli",
    triggerAgentName: null,
    scheduleId: null,
    status: "completed",
    prompt: "Another prompt",
    appendSystemPrompt: null,
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

export const appLogsHandlers = [
  // GET /api/zero/logs - List logs with basic fields
  mockApi(logsListContract.list, ({ query, respond }) => {
    const { cursor, limit } = query;

    const cursorIndex = cursor
      ? mockLogDetails.findIndex((r) => r.id === cursor) + 1
      : 0;
    const data = mockLogDetails.slice(cursorIndex, cursorIndex + limit);
    const hasMore = cursorIndex + limit < mockLogDetails.length;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;
    const totalPages = Math.max(1, Math.ceil(mockLogDetails.length / limit));

    return respond(200, {
      data: data.map((log) => ({
        id: log.id,
        sessionId: log.sessionId,
        agentId: log.agentId,
        displayName: null,
        framework: log.framework,
        triggerSource: null,
        triggerAgentName: null,
        scheduleId: null,
        status: log.status,
        prompt: log.prompt,
        createdAt: log.createdAt,
        startedAt: log.startedAt,
        completedAt: log.completedAt,
      })),
      pagination: { hasMore, nextCursor, totalPages },
      filters: { statuses: [], sources: [], agents: [] },
    });
  }),

  // GET /api/zero/logs/:id - Get log detail
  mockApi(logsByIdContract.getById, ({ params, respond }) => {
    const { id } = params;
    const logDetail = mockLogDetails.find((log) => log.id === id);

    if (!logDetail) {
      return respond(404, {
        error: { message: "Log not found", code: "NOT_FOUND" },
      });
    }

    return respond(200, logDetail);
  }),
];
