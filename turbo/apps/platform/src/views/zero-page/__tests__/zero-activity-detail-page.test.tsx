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

function mockActivityDetailAPI() {
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

  server.use(
    http.get("*/api/zero/logs/:id", ({ params }) => {
      if (params["id"] === "a0000000-0000-4000-a000-000000000001") {
        return HttpResponse.json(logDetail);
      }
      return HttpResponse.json(
        { error: { message: "Not found", code: "NOT_FOUND" } },
        { status: 404 },
      );
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
  it("should load detail when navigating directly to /activities/:id", async () => {
    mockActivityDetailAPI();

    detachedSetupPage({
      context,
      path: "/activities/a0000000-0000-4000-a000-000000000001",
    });

    // The page should show the detail header card (not skeleton)
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Test Agent" }),
      ).toBeInTheDocument();
    });

    // Verify the header card rendered with run details
    expect(screen.getByText("9.0s")).toBeInTheDocument();
  });

  it("should hide Activity breadcrumb when ActivityLogList switch is off", async () => {
    mockActivityDetailAPI();

    detachedSetupPage({
      context,
      path: "/activities/a0000000-0000-4000-a000-000000000001",
      featureSwitches: { [FeatureSwitchKey.ActivityLogList]: false },
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Test Agent" }),
      ).toBeInTheDocument();
    });

    // The breadcrumb link to /activity should not be present
    const activityLinks = screen.queryAllByRole("link").filter((el) => {
      return /Activity/i.test(el.textContent ?? "");
    });
    expect(activityLinks).toHaveLength(0);
  });

  it("should show Activity breadcrumb when ActivityLogList switch is on", async () => {
    mockActivityDetailAPI();

    detachedSetupPage({
      context,
      path: "/activities/a0000000-0000-4000-a000-000000000001",
      featureSwitches: { [FeatureSwitchKey.ActivityLogList]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Test Agent" }),
      ).toBeInTheDocument();
    });

    // The breadcrumb link to /activity should be present
    const activityLinks = screen.queryAllByRole("link").filter((el) => {
      return /Activity/i.test(el.textContent ?? "");
    });
    expect(activityLinks.length).toBeGreaterThan(0);
  });

  it("should render schedule source as a clickable link when scheduleId is present", async () => {
    const logDetail: LogDetail = {
      id: "a0000000-0000-4000-a000-000000000002",
      sessionId: "session_sched",
      agentId: "test-agent",
      displayName: "Scheduled Agent",
      framework: "claude-code",
      modelProvider: null,
      selectedModel: null,
      triggerSource: "schedule",
      triggerAgentName: null,
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

    detachedSetupPage({
      context,
      path: "/activities/a0000000-0000-4000-a000-000000000002",
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Scheduled Agent" }),
      ).toBeInTheDocument();
    });

    // "Schedule" label should be rendered as a link pointing to the schedule page
    const scheduleLink = screen.getByText("Schedule");
    expect(scheduleLink).toBeInTheDocument();
    expect(scheduleLink.getAttribute("href")).toBe("/schedules/sched-abc-123");
  });

  it("should render schedule source as plain text when scheduleId is null", async () => {
    const logDetail: LogDetail = {
      id: "a0000000-0000-4000-a000-000000000003",
      sessionId: "session_sched_no_id",
      agentId: "test-agent",
      displayName: "Scheduled Agent No ID",
      framework: "claude-code",
      modelProvider: null,
      selectedModel: null,
      triggerSource: "schedule",
      triggerAgentName: null,
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

    detachedSetupPage({
      context,
      path: "/activities/a0000000-0000-4000-a000-000000000003",
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Scheduled Agent No ID" }),
      ).toBeInTheDocument();
    });

    // "Schedule" should be plain text, not a link
    expect(screen.getByText("Schedule")).toBeInTheDocument();
    expect(
      screen.queryAllByRole("link").find((el) => {
        return el.textContent?.trim() === "Schedule";
      }),
    ).toBeUndefined();
  });

  it("should render non-schedule source as plain text", async () => {
    mockActivityDetailAPI();

    detachedSetupPage({
      context,
      path: "/activities/a0000000-0000-4000-a000-000000000001",
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Test Agent" }),
      ).toBeInTheDocument();
    });

    // "Web" source should be plain text, not a link
    expect(screen.getByText("Web")).toBeInTheDocument();
    expect(
      screen.queryAllByRole("link").find((el) => {
        return el.textContent?.trim() === "Web";
      }),
    ).toBeUndefined();
  });

  it("should not truncate system prompt containing unknown HTML-like tags", async () => {
    const logDetail: LogDetail = {
      id: "a0000000-0000-4000-a000-000000000004",
      sessionId: "session_2",
      agentId: "test-agent",
      displayName: "Test Agent",
      framework: "claude-code",
      modelProvider: null,
      selectedModel: null,
      triggerSource: "web",
      triggerAgentName: null,
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

    detachedSetupPage({
      context,
      path: "/activities/a0000000-0000-4000-a000-000000000004",
      featureSwitches: { [FeatureSwitchKey.ShowSystemPrompt]: true },
    });

    // Wait for System Prompt card to appear
    await waitFor(() => {
      expect(screen.getByText("System Prompt")).toBeInTheDocument();
    });

    // Expand the System Prompt details
    const user = userEvent.setup();
    await user.click(screen.getByText("System Prompt"));

    // Text after <command> must NOT be truncated (bug #6770)
    await waitFor(() => {
      expect(
        screen.getAllByText(/This line must not be lost/).length,
      ).toBeGreaterThan(0);
    });
  });

  it("should display selectedModel when ModelDetail feature is enabled", async () => {
    const logDetail: LogDetail = {
      id: "a0000000-0000-4000-a000-000000000005",
      sessionId: "session_model",
      agentId: "test-agent",
      displayName: "Model Detail Agent",
      framework: "claude-code",
      modelProvider: "anthropic-api-key",
      selectedModel: "claude-sonnet-4.5",
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

    detachedSetupPage({
      context,
      path: "/activities/a0000000-0000-4000-a000-000000000005",
      featureSwitches: { [FeatureSwitchKey.ModelDetail]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Model Detail Agent" }),
      ).toBeInTheDocument();
    });

    // selectedModel should be displayed as the model label
    expect(screen.getByText("claude-sonnet-4.5")).toBeInTheDocument();
  });

  it("should display provider label when ModelDetail feature is disabled", async () => {
    const logDetail: LogDetail = {
      id: "a0000000-0000-4000-a000-000000000006",
      sessionId: "session_no_model",
      agentId: "test-agent",
      displayName: "No Model Detail Agent",
      framework: "claude-code",
      modelProvider: "anthropic-api-key",
      selectedModel: "claude-sonnet-4.5",
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

    detachedSetupPage({
      context,
      path: "/activities/a0000000-0000-4000-a000-000000000006",
      featureSwitches: { [FeatureSwitchKey.ModelDetail]: false },
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "No Model Detail Agent" }),
      ).toBeInTheDocument();
    });

    // Provider label should be displayed, not selectedModel
    expect(screen.getByText("Anthropic API Key")).toBeInTheDocument();
    expect(screen.queryByText("claude-sonnet-4.5")).toBeNull();
  });

  it("should fallback to provider label when ModelDetail is enabled but selectedModel is null", async () => {
    const logDetail: LogDetail = {
      id: "a0000000-0000-4000-a000-000000000007",
      sessionId: "session_null_model",
      agentId: "test-agent",
      displayName: "Null Model Agent",
      framework: "claude-code",
      modelProvider: "anthropic-api-key",
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

    detachedSetupPage({
      context,
      path: "/activities/a0000000-0000-4000-a000-000000000007",
      featureSwitches: { [FeatureSwitchKey.ModelDetail]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Null Model Agent" }),
      ).toBeInTheDocument();
    });

    // Should fallback to provider label when selectedModel is null
    expect(screen.getByText("Anthropic API Key")).toBeInTheDocument();
  });
});
