import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { FeatureSwitchKey } from "@vm0/core";
import type {
  LogDetail,
  AgentEventsResponse,
} from "../../../signals/zero-page/log-types.ts";

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
      orgSlug: "test",
      framework: "claude-code",
      status: "completed",
      triggerSource: "web",
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
      orgSlug: "test",
      framework: "claude-code",
      status: "completed",
      triggerSource: "cli",
      triggerAgentName: null,
      scheduleId: null,
      prompt: "Test prompt",
      createdAt: "2026-03-10T15:00:00Z",
      startedAt: "2026-03-10T15:00:01Z",
      completedAt: "2026-03-10T15:00:05Z",
    },
  ];

  server.use(
    http.get("*/api/zero/logs", () => {
      return HttpResponse.json({
        data: listData,
        pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
        filters: { statuses: [], sources: [], agents: [] },
      });
    }),
    http.get("*/api/zero/composes/list", () => {
      return HttpResponse.json({ composes: [] });
    }),
    http.get("*/api/zero/logs/:id", ({ params }) => {
      if (params["id"] === "a0000000-0000-4000-a000-000000000001") {
        return HttpResponse.json(detail1);
      }
      if (params["id"] === "a0000000-0000-4000-a000-000000000002") {
        return HttpResponse.json(detail2);
      }
      return HttpResponse.json(
        { error: { message: "Not found", code: "NOT_FOUND" } },
        { status: 404 },
      );
    }),
    http.get("*/api/zero/runs/:runId/telemetry/agent", ({ params }) => {
      const runId = params["runId"] as string;
      if (runId === "a0000000-0000-4000-a000-000000000001") {
        return HttpResponse.json(makeEventsResponse("Response from agent one"));
      }
      if (runId === "a0000000-0000-4000-a000-000000000002") {
        return HttpResponse.json(makeEventsResponse("Response from agent two"));
      }
      return HttpResponse.json({
        events: [],
        hasMore: false,
        framework: "claude-code",
      });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

describe("activity detail stale data", () => {
  it("should show skeleton instead of previous activity when navigating between details", async () => {
    const user = userEvent.setup();
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
    await user.click(breadcrumb!);

    // Wait for the list to render
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Activity" }),
      ).toBeInTheDocument();
    });

    // Navigate to the second activity
    const row = screen.getByText("Agent Two").closest("a");
    expect(row).not.toBeNull();
    await user.click(row!);

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
