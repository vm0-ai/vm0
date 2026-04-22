import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
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

function makeLogDetail(overrides: Partial<LogDetail>): LogDetail {
  return {
    id: "a0000000-0000-4000-a000-000000000001",
    sessionId: "session_1",
    agentId: "e0000000-0000-4000-a000-000000000010",
    displayName: "Agent One",
    framework: "claude-code",
    modelProvider: null,
    selectedModel: null,
    triggerSource: "web",
    triggerAgentName: null,
    scheduleId: null,
    status: "completed",
    prompt: "Hello",
    appendSystemPrompt: null,
    error: null,
    createdAt: "2026-03-10T14:56:00Z",
    startedAt: "2026-03-10T14:56:01Z",
    completedAt: "2026-03-10T14:56:10Z",
    artifact: { name: null, version: null },
    ...overrides,
  };
}

function makeEventsResponse(text: string): AgentEventsResponse {
  return {
    events: [
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: { message: { content: [{ type: "text", text }] } },
        createdAt: "2026-03-10T14:56:02Z",
      },
    ],
    hasMore: false,
    framework: "claude-code",
  };
}

function mockAPIs() {
  const detail1 = makeLogDetail({
    id: "a0000000-0000-4000-a000-000000000001",
    agentId: "e0000000-0000-4000-a000-000000000010",
    displayName: "Agent One",
  });

  const detail2 = makeLogDetail({
    id: "a0000000-0000-4000-a000-000000000002",
    agentId: "e0000000-0000-4000-a000-000000000010",
    displayName: "Agent Two",
  });

  const listData = [
    {
      id: "a0000000-0000-4000-a000-000000000001",
      sessionId: "session_1",
      agentId: "e0000000-0000-4000-a000-000000000010",
      displayName: "Agent One",
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
    {
      id: "a0000000-0000-4000-a000-000000000002",
      sessionId: "session_2",
      agentId: "e0000000-0000-4000-a000-000000000010",
      displayName: "Agent Two",
      framework: "claude-code",
      status: "completed" as const,
      triggerSource: "cli" as const,
      triggerAgentName: null,
      scheduleId: null,
      prompt: "Test prompt",
      createdAt: "2026-03-10T15:00:00Z",
      startedAt: "2026-03-10T15:00:01Z",
      completedAt: "2026-03-10T15:00:05Z",
    },
  ];

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
        return respond(200, detail1);
      }
      if (params.id === "a0000000-0000-4000-a000-000000000002") {
        return respond(200, detail2);
      }
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }),
    mockApi(
      zeroRunAgentEventsContract.getAgentEvents,
      ({ params, respond }) => {
        if (params.id === "a0000000-0000-4000-a000-000000000001") {
          return respond(200, makeEventsResponse("Response from agent one"));
        }
        if (params.id === "a0000000-0000-4000-a000-000000000002") {
          return respond(200, makeEventsResponse("Response from agent two"));
        }
        return respond(200, {
          events: [],
          hasMore: false,
          framework: "claude-code",
        });
      },
    ),
  );
}

describe("activity detail stale data", () => {
  it("should show skeleton instead of previous activity when navigating between details", async () => {
    mockAPIs();

    // Start on the first activity detail page
    detachedSetupPage({
      context,
      path: "/activities/a0000000-0000-4000-a000-000000000001",
      featureSwitches: { [FeatureSwitchKey.ActivityLogList]: true },
    });

    // Wait for first detail to load
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Agent One" }),
      ).toBeInTheDocument();
    });

    // Navigate back to the list via breadcrumb
    const breadcrumb = screen.getByText("Activity").closest("a");
    expect(breadcrumb).not.toBeNull();
    click(breadcrumb!);

    // Wait for the list to render
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Activity" }),
      ).toBeInTheDocument();
    });

    // Navigate to the second activity
    const row = screen.getByText("Agent Two").closest("a");
    expect(row).not.toBeNull();
    click(row!);

    // The old "Agent One" heading must NOT be visible — we should see skeleton or new data
    await waitFor(() => {
      // Either skeleton (no heading) or the new agent heading should be shown
      const oldHeading = screen.queryByRole("heading", { name: "Agent One" });
      expect(oldHeading).not.toBeInTheDocument();
    });

    // Eventually the new detail should load
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Agent Two" }),
      ).toBeInTheDocument();
    });
  });
});
