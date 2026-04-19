import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import {
  FeatureSwitchKey,
  logsListContract,
  logsByIdContract,
  zeroRunAgentEventsContract,
} from "@vm0/core";
import type {
  LogDetail,
  AgentEventsResponse,
} from "../../../signals/zero-page/log-types.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { setMockComposesList } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();

function mockActivityAPIs() {
  const logs = [
    {
      id: "a0000000-0000-4000-a000-000000000001",
      sessionId: "session-1",
      agentId: "test-agent",
      displayName: "Test Agent",
      framework: "claude-code",
      status: "completed" as const,
      triggerSource: "web" as const,
      triggerAgentName: null,
      scheduleId: null,
      prompt: "Test prompt",
      createdAt: "2026-03-10T14:56:00Z",
      startedAt: "2026-03-10T14:56:01Z",
      completedAt: "2026-03-10T14:56:04Z",
    },
  ];

  const logDetail: LogDetail = {
    id: "a0000000-0000-4000-a000-000000000001",
    sessionId: "session-1",
    agentId: "test-agent",
    displayName: "Test Agent",
    framework: "claude-code",
    modelProvider: null,
    selectedModel: null,
    triggerSource: "web" as const,
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

  setMockComposesList([
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
  server.use(
    mockApi(logsListContract.list, ({ respond }) => {
      return respond(200, {
        data: logs,
        pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
        filters: { statuses: [], sources: [], agents: [] },
      });
    }),
    mockApi(logsByIdContract.getById, ({ params, respond }) => {
      if (params.id === "a0000000-0000-4000-a000-000000000001") {
        return respond(200, logDetail);
      }
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }),
    mockApi(zeroRunAgentEventsContract.getAgentEvents, ({ respond }) => {
      return respond(200, eventsResponse);
    }),
  );
}

describe("activity page routing", () => {
  it("should load detail view when clicking an activity row from the list", async () => {
    const user = userEvent.setup();
    mockActivityAPIs();

    detachedSetupPage({
      context,
      path: "/activities",
    });

    // Wait for the list to render with the activity row
    await waitFor(() => {
      expect(screen.getByText("Test Agent")).toBeInTheDocument();
    });

    // Click the activity row — this navigates to /activity/a0000000-0000-4000-a000-000000000001
    const row = screen.getByText("Test Agent").closest("a");
    expect(row).not.toBeNull();
    await user.click(row!);

    // The detail page should render with the agent name heading
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Test Agent" }),
      ).toBeInTheDocument();
    });

    // Verify detail content loaded (duration)
    expect(screen.getByText("3.0s")).toBeInTheDocument();
  });

  it("should navigate back to list from detail breadcrumb", async () => {
    const user = userEvent.setup();
    mockActivityAPIs();

    detachedSetupPage({
      context,
      path: "/activities",
      featureSwitches: { [FeatureSwitchKey.ActivityLogList]: true },
    });

    // Wait for list
    await waitFor(() => {
      expect(screen.getByText("Test Agent")).toBeInTheDocument();
    });

    // Navigate to detail
    const row = screen.getByText("Test Agent").closest("a");
    await user.click(row!);

    // Wait for detail
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Test Agent" }),
      ).toBeInTheDocument();
    });

    // Click the "Activity" breadcrumb to go back
    const breadcrumb = screen.getByText("Activity").closest("a");
    expect(breadcrumb).not.toBeNull();
    await user.click(breadcrumb!);

    // Should be back on the list page with the "Activity" heading
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Activity" }),
      ).toBeInTheDocument();
    });
  });

  it("should display 'Agent (displayName)' for delegated runs with triggerAgentName", async () => {
    setMockComposesList([
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
    server.use(
      mockApi(logsListContract.list, ({ respond }) => {
        return respond(200, {
          data: [
            {
              id: "b0000000-0000-4000-a000-000000000001",
              sessionId: "session-delegated",
              agentId: "child-agent",
              displayName: "Child Agent",
              framework: "claude-code",
              status: "completed",
              triggerSource: "agent" as const,
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
      }),
    );

    detachedSetupPage({
      context,
      path: "/activities",
    });

    // The source column should show "Agent (Parent Bot)" for the delegated run
    await waitFor(() => {
      expect(screen.getByText("Agent (Parent Bot)")).toBeInTheDocument();
    });
  });
});
