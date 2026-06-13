import { screen, waitFor } from "@testing-library/react";
import {
  logsByIdContract,
  logsListContract,
} from "@vm0/api-contracts/contracts/logs";
import { zeroRunAgentEventsContract } from "@vm0/api-contracts/contracts/zero-runs";
import { describe, expect, it } from "vitest";

import { click, detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type {
  AgentEventsResponse,
  LogEntry,
  LogDetail,
} from "../../../signals/zero-page/log-types.ts";

const context = testContext();

function mockActivityAPIs(): void {
  const runId = "a0000000-0000-4000-a000-000000000001";
  const logDetail: LogDetail = {
    id: runId,
    sessionId: "session-1",
    agentId: "test-agent",
    displayName: "Test Agent",
    framework: "claude-code",
    modelProvider: null,
    selectedModel: null,
    triggerSource: "web",
    triggerAgentName: null,
    automationId: null,
    status: "completed",
    prompt: "Summarize today",
    appendSystemPrompt: null,
    error: null,
    createdAt: "2026-03-10T14:56:00Z",
    startedAt: "2026-03-10T14:56:01Z",
    completedAt: "2026-03-10T14:56:04Z",
    artifact: { name: null, version: null },
  };

  const eventsResponse: AgentEventsResponse = {
    events: [
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: { content: [{ type: "text", text: "Summary done." }] },
        },
        createdAt: "2026-03-10T14:56:02Z",
      },
    ],
    hasMore: false,
    framework: "claude-code",
  };

  context.mocks.data.composesList([
    {
      id: "c0000000-0000-4000-a000-000000000001",
      name: "test-agent",
      displayName: "Test Agent",
      description: null,
      sound: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);

  context.mocks.api(logsListContract.list, ({ respond }) => {
    return respond(200, {
      data: [
        {
          id: runId,
          sessionId: "session-1",
          agentId: "test-agent",
          displayName: "Test Agent",
          framework: "claude-code",
          status: "completed",
          triggerSource: "web",
          triggerAgentName: null,
          automationId: null,
          prompt: "Test prompt",
          createdAt: "2026-03-10T14:56:00Z",
          startedAt: "2026-03-10T14:56:01Z",
          completedAt: "2026-03-10T14:56:04Z",
        },
      ],
      pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
      filters: { statuses: [], sources: [], agents: [] },
    });
  });
  context.mocks.api(logsByIdContract.getById, ({ params, respond }) => {
    if (params.id === runId) {
      return respond(200, logDetail);
    }

    return respond(404, {
      error: { message: "Not found", code: "NOT_FOUND" },
    });
  });
  context.mocks.api(
    zeroRunAgentEventsContract.getAgentEvents,
    ({ respond }) => {
      return respond(200, eventsResponse);
    },
  );
}

function makeActivityRow(
  idSuffix: string,
  overrides: Partial<LogEntry> = {},
): LogEntry {
  return {
    id: `b0000000-0000-4000-a000-000000000${idSuffix}`,
    sessionId: `session-${idSuffix}`,
    agentId: "c0000000-0000-4000-a000-000000000101",
    displayName: "Research Agent",
    framework: "claude-code",
    status: "completed",
    triggerSource: "web",
    triggerAgentName: null,
    automationId: null,
    prompt: "Review activity",
    createdAt: "2026-03-10T15:00:00Z",
    startedAt: "2026-03-10T15:00:01Z",
    completedAt: "2026-03-10T15:00:04Z",
    ...overrides,
  };
}

describe("activity page routing", () => {
  it("opens an activity detail from the list and returns by breadcrumb", async () => {
    mockActivityAPIs();

    detachedSetupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(screen.getByText("Test Agent")).toBeInTheDocument();
    });

    const row = screen.getByText("Test Agent").closest("a");
    expect(row).not.toBeNull();
    click(row!);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Test Agent" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("3.0s")).toBeInTheDocument();

    expect(screen.getByText("Summary done.")).toBeInTheDocument();
  });

  it("identifies delegated activity with the parent agent source", async () => {
    context.mocks.data.composesList([
      {
        id: "c0000000-0000-4000-a000-000000000001",
        name: "child-agent",
        displayName: "Child Agent",
        description: null,
        sound: null,
        headVersionId: null,
        updatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
    context.mocks.api(logsListContract.list, ({ respond }) => {
      return respond(200, {
        data: [
          {
            id: "b0000000-0000-4000-a000-000000000001",
            sessionId: "session-delegated",
            agentId: "child-agent",
            displayName: "Child Agent",
            framework: "claude-code",
            status: "completed",
            triggerSource: "agent",
            triggerAgentName: "Parent Bot",
            automationId: null,
            prompt: "Test prompt",
            createdAt: "2026-03-10T15:00:00Z",
            startedAt: "2026-03-10T15:00:01Z",
            completedAt: "2026-03-10T15:00:05Z",
          },
        ],
        pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
        filters: { statuses: [], sources: [], agents: [] },
      });
    });

    detachedSetupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(screen.getByText("Agent (Parent Bot)")).toBeInTheDocument();
    });
  });

  it("filters and paginates activity runs from the list controls", async () => {
    const agentId = "c0000000-0000-4000-a000-000000000101";
    context.mocks.data.composesList([
      {
        id: agentId,
        name: "research-agent",
        displayName: "Research Agent",
        description: null,
        sound: null,
        headVersionId: null,
        updatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
    context.mocks.api(logsListContract.list, ({ query, respond }) => {
      const filters: {
        statuses: LogEntry["status"][];
        sources: NonNullable<LogEntry["triggerSource"]>[];
        agents: string[];
      } = {
        statuses: ["completed", "failed"],
        sources: ["web", "telegram"],
        agents: [agentId],
      };

      if (query.status === "failed" && query.triggerSource === "telegram") {
        return respond(200, {
          data: [
            makeActivityRow("301", {
              displayName: "Telegram Agent",
              status: "failed",
              triggerSource: "telegram",
              startedAt: "2026-03-10T15:20:01Z",
              completedAt: "2026-03-10T15:20:06Z",
            }),
          ],
          pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
          filters,
        });
      }

      if (query.status === "failed") {
        return respond(200, {
          data: [
            makeActivityRow("201", {
              displayName: "Incident Agent",
              status: "failed",
              triggerSource: "web",
              startedAt: "2026-03-10T15:10:01Z",
              completedAt: "2026-03-10T15:10:06Z",
            }),
          ],
          pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
          filters,
        });
      }

      if (query.cursor === "page-3") {
        return respond(200, {
          data: [makeActivityRow("103", { displayName: "Archive Agent" })],
          pagination: { hasMore: false, nextCursor: null, totalPages: 3 },
          filters,
        });
      }

      if (query.cursor === "page-2") {
        return respond(200, {
          data: [makeActivityRow("102", { displayName: "Ops Agent" })],
          pagination: { hasMore: true, nextCursor: "page-3", totalPages: 3 },
          filters,
        });
      }

      return respond(200, {
        data: [makeActivityRow("101")],
        pagination: { hasMore: true, nextCursor: "page-2", totalPages: 3 },
        filters,
      });
    });

    detachedSetupPage({ context, path: "/activities" });

    await waitFor(() => {
      expect(screen.getByText("Research Agent")).toBeInTheDocument();
      expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Forward 2 pages"));

    await waitFor(() => {
      expect(screen.getByText("Archive Agent")).toBeInTheDocument();
      expect(screen.getByText("Page 3 of 3")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Back 2 pages"));

    await waitFor(() => {
      expect(screen.getByText("Research Agent")).toBeInTheDocument();
      expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Rows per page"));
    click(screen.getByRole("option", { name: "20" }));

    await waitFor(() => {
      expect(screen.getByText("Research Agent")).toBeInTheDocument();
      expect(screen.getByText("20")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Status filter"));
    click(screen.getByRole("option", { name: "Failed" }));

    await waitFor(() => {
      expect(screen.getByText("Incident Agent")).toBeInTheDocument();
      expect(screen.queryByText("Research Agent")).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Source filter"));
    click(screen.getByRole("option", { name: "Telegram" }));

    await waitFor(() => {
      expect(screen.getByText("Telegram Agent")).toBeInTheDocument();
      expect(screen.queryByText("Incident Agent")).not.toBeInTheDocument();
      expect(screen.getAllByText("Telegram").length).toBeGreaterThan(0);
    });
  });
});
