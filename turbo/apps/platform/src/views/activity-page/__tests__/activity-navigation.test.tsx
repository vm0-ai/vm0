import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import type {
  LogDetail,
  AgentEventsResponse,
} from "../../../signals/zero-page/log-types.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import {
  logsListContract,
  logsByIdContract,
  zeroRunAgentEventsContract,
} from "@vm0/core";
import { setMockComposesList } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();

function mockActivityAPIs() {
  const listData = [
    {
      id: "a0000000-0000-4000-a000-000000000001",
      sessionId: "session_1",
      agentId: "test-agent",
      displayName: "Test Agent",
      orgSlug: "test",
      framework: "claude-code",
      status: "completed" as const,
      triggerSource: "web" as const,
      triggerAgentName: null,
      scheduleId: null,
      prompt: "Test prompt",
      createdAt: "2026-03-10T14:56:00Z",
      startedAt: "2026-03-10T14:56:01Z",
      completedAt: "2026-03-10T14:56:10Z",
    },
  ];

  const logDetail: LogDetail = {
    id: "a0000000-0000-4000-a000-000000000001",
    sessionId: "session_1",
    agentId: "test-agent",
    displayName: "Test Agent",
    framework: "claude-code",
    modelProvider: null,
    selectedModel: null,
    triggerSource: "web",
    triggerAgentName: null,
    scheduleId: null,
    status: "completed",
    prompt: "Hello, what can you do?",
    appendSystemPrompt: null,
    error: null,
    createdAt: "2026-03-10T14:56:00Z",
    startedAt: "2026-03-10T14:56:01Z",
    completedAt: "2026-03-10T14:56:10Z",
    artifact: { name: null, version: null },
  };

  const eventsResponse: AgentEventsResponse = {
    events: [
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: { message: { content: [{ type: "text", text: "Hi!" }] } },
        createdAt: "2026-03-10T14:56:02Z",
      },
    ],
    hasMore: false,
    framework: "claude-code",
  };

  setMockComposesList([]);
  server.use(
    mockApi(logsListContract.list, ({ respond }) => {
      return respond(200, {
        data: listData,
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

describe("activity navigation", () => {
  it("should load detail page when clicking an activity row from the list", async () => {
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

    // Click the activity row to navigate to detail
    await user.click(screen.getByText("Test Agent"));

    // The detail page should render with the agent name as heading
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Test Agent" }),
      ).toBeInTheDocument();
    });

    // Verify the detail content is visible (duration)
    expect(screen.getByText("9.0s")).toBeInTheDocument();
  });
});
