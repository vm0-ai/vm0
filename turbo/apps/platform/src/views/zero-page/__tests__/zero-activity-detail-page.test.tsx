import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { FeatureSwitchKey } from "@vm0/core";
import type {
  LogDetail,
  AgentEventsResponse,
} from "../../../signals/zero-page/log-types.ts";

const context = testContext();

function mockActivityDetailAPI() {
  const logDetail: LogDetail = {
    id: "run_1",
    sessionId: "session_1",
    agentId: "test-agent",
    displayName: "Test Agent",
    framework: "claude-code",
    modelProvider: null,
    triggerSource: "web",
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

  server.use(
    http.get("*/api/zero/logs/:id", ({ params }) => {
      if (params["id"] === "run_1") {
        return HttpResponse.json(logDetail);
      }
      return new HttpResponse(null, { status: 404 });
    }),
    http.get("*/api/zero/runs/:runId/telemetry/agent", () => {
      return HttpResponse.json(eventsResponse);
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

describe("zeroActivityDetailPage", () => {
  it("should load detail when navigating directly to /activity/:runId", async () => {
    mockActivityDetailAPI();

    await setupPage({
      context,
      path: "/activity/run_1",
    });

    // The page should show the detail header card (not skeleton)
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Test Agent" }),
      ).toBeInTheDocument();
    });

    // Verify the header card rendered with run details
    expect(screen.getByText("9.0s")).toBeInTheDocument();
  }, 10_000);

  it("should render schedule source as a clickable link when scheduleId is present", async () => {
    const logDetail: LogDetail = {
      id: "run_sched",
      sessionId: "session_sched",
      agentId: "test-agent",
      displayName: "Scheduled Agent",
      framework: "claude-code",
      modelProvider: null,
      triggerSource: "schedule",
      scheduleId: "sched-abc-123",
      status: "completed",
      prompt: "Scheduled run",
      appendSystemPrompt: null,
      error: null,
      createdAt: "2026-03-10T14:56:00Z",
      startedAt: "2026-03-10T14:56:01Z",
      completedAt: "2026-03-10T14:56:10Z",
      artifact: { name: null, version: null },
    };

    server.use(
      http.get("*/api/zero/logs/:id", () => {
        return HttpResponse.json(logDetail);
      }),
      http.get("*/api/zero/runs/:runId/telemetry/agent", () => {
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

    await setupPage({
      context,
      path: "/activity/run_sched",
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Scheduled Agent" }),
      ).toBeInTheDocument();
    });

    // "Schedule" label should be rendered as a link pointing to the schedule page
    const scheduleLink = screen.getByRole("link", { name: "Schedule" });
    expect(scheduleLink).toBeInTheDocument();
    expect(scheduleLink.getAttribute("href")).toBe("/schedule/sched-abc-123");
  }, 10_000);

  it("should render schedule source as plain text when scheduleId is null", async () => {
    const logDetail: LogDetail = {
      id: "run_sched_no_id",
      sessionId: "session_sched_no_id",
      agentId: "test-agent",
      displayName: "Scheduled Agent No ID",
      framework: "claude-code",
      modelProvider: null,
      triggerSource: "schedule",
      scheduleId: null,
      status: "completed",
      prompt: "Scheduled run without ID",
      appendSystemPrompt: null,
      error: null,
      createdAt: "2026-03-10T14:56:00Z",
      startedAt: "2026-03-10T14:56:01Z",
      completedAt: "2026-03-10T14:56:10Z",
      artifact: { name: null, version: null },
    };

    server.use(
      http.get("*/api/zero/logs/:id", () => {
        return HttpResponse.json(logDetail);
      }),
      http.get("*/api/zero/runs/:runId/telemetry/agent", () => {
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

    await setupPage({
      context,
      path: "/activity/run_sched_no_id",
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Scheduled Agent No ID" }),
      ).toBeInTheDocument();
    });

    // "Schedule" should be plain text, not a link
    expect(screen.getByText("Schedule")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Schedule" })).toBeNull();
  }, 10_000);

  it("should render non-schedule source as plain text", async () => {
    mockActivityDetailAPI();

    await setupPage({
      context,
      path: "/activity/run_1",
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Test Agent" }),
      ).toBeInTheDocument();
    });

    // "Web" source should be plain text, not a link
    expect(screen.getByText("Web")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Web" })).toBeNull();
  }, 10_000);

  it("should not truncate system prompt containing unknown HTML-like tags", async () => {
    const logDetail: LogDetail = {
      id: "run_html_tag",
      sessionId: "session_2",
      agentId: "test-agent",
      displayName: "Test Agent",
      framework: "claude-code",
      modelProvider: null,
      triggerSource: "web",
      scheduleId: null,
      status: "completed",
      prompt: "Hello",
      appendSystemPrompt:
        "Run commands with: npx zero <command>\nThis line must not be lost",
      error: null,
      createdAt: "2026-03-10T14:56:00Z",
      startedAt: "2026-03-10T14:56:01Z",
      completedAt: "2026-03-10T14:56:10Z",
      artifact: { name: null, version: null },
    };

    const eventsResponse: AgentEventsResponse = {
      events: [],
      hasMore: false,
      framework: "claude-code",
    };

    server.use(
      http.get("*/api/zero/logs/:id", () => {
        return HttpResponse.json(logDetail);
      }),
      http.get("*/api/zero/runs/:runId/telemetry/agent", () => {
        return HttpResponse.json(eventsResponse);
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    await setupPage({
      context,
      path: "/activity/run_html_tag",
      featureSwitches: { [FeatureSwitchKey.ShowSystemPrompt]: true },
    });

    // Wait for System Prompt card to appear
    await waitFor(() => {
      expect(screen.getByText("System Prompt")).toBeInTheDocument();
    });

    // Expand the System Prompt details
    fireEvent.click(screen.getByText("System Prompt"));

    // Text after <command> must NOT be truncated (bug #6770)
    await waitFor(() => {
      expect(
        screen.getAllByText(/This line must not be lost/).length,
      ).toBeGreaterThan(0);
    });
  }, 10_000);
});
