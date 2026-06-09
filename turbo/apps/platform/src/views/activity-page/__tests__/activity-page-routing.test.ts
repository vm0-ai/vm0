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
    scheduleId: null,
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
          scheduleId: null,
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
            scheduleId: null,
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
});
