import { describe, it, expect } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/helper.ts";
import { pathname$ } from "../../../signals/route.ts";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { userEvent } from "@testing-library/user-event";

const context = testContext();
const user = userEvent.setup();

// Factory function for default agent events response
function createDefaultAgentEventsResponse() {
  return {
    events: [
      {
        sequenceNumber: 1,
        eventType: "text",
        eventData: { content: "Hello" },
        createdAt: "2024-01-01T00:00:02Z",
      },
    ],
    hasMore: false,
    framework: "claude-code",
  };
}

describe("log detail page", () => {
  it("should render the log detail page with breadcrumb", async () => {
    server.use(
      http.get("*/api/platform/logs/:id", () => {
        return HttpResponse.json({
          id: "test-run-123",
          sessionId: "session-456",
          agentName: "Test Agent",
          provider: "claude-code",
          status: "completed",
          prompt: "Test prompt",
          error: null,
          createdAt: "2024-01-01T00:00:00Z",
          startedAt: "2024-01-01T00:00:01Z",
          completedAt: "2024-01-01T00:00:10Z",
          artifact: { name: "test-artifact", version: "1.0.0" },
        });
      }),
      http.get("*/api/agent/runs/:id/telemetry/agent", () => {
        return HttpResponse.json(createDefaultAgentEventsResponse());
      }),
    );

    await setupPage({
      context,
      path: "/logs/test-run-123",
    });

    // Verify breadcrumb shows Run ID with full ID
    await waitFor(() => {
      expect(screen.getByText("Run ID - test-run-123")).toBeInTheDocument();
    });
    expect(context.store.get(pathname$)).toBe("/logs/test-run-123");
  });

  it("should display run details in info card", async () => {
    server.use(
      http.get("*/api/platform/logs/:id", () => {
        return HttpResponse.json({
          id: "run-abc-123",
          sessionId: "session-xyz-789",
          agentName: "My Test Agent",
          provider: "openai",
          status: "completed",
          prompt: "Do something",
          error: null,
          createdAt: "2024-01-15T10:30:00Z",
          startedAt: "2024-01-15T10:30:01Z",
          completedAt: "2024-01-15T10:30:15Z",
          artifact: { name: "my-artifact", version: "2.0.0" },
        });
      }),
      http.get("*/api/agent/runs/:id/telemetry/agent", () => {
        return HttpResponse.json(createDefaultAgentEventsResponse());
      }),
    );

    await setupPage({
      context,
      path: "/logs/run-abc-123",
    });

    // Wait for detail to load - check for run ID in content
    await waitFor(() => {
      expect(screen.getByText("run-abc-123")).toBeInTheDocument();
    });

    // Verify all info items are displayed
    expect(screen.getByText("session-xyz-789")).toBeInTheDocument();
    expect(screen.getByText("My Test Agent")).toBeInTheDocument();
    expect(screen.getByText("openai")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument(); // Status shows "Done" for completed
    expect(screen.getByText("my-artifact")).toBeInTheDocument();
  });

  it("should display duration correctly", async () => {
    server.use(
      http.get("*/api/platform/logs/:id", () => {
        return HttpResponse.json({
          id: "run-duration-test",
          sessionId: null,
          agentName: "Duration Agent",
          provider: "claude-code",
          status: "completed",
          prompt: "Test",
          error: null,
          createdAt: "2024-01-01T00:00:00Z",
          startedAt: "2024-01-01T00:00:00Z",
          completedAt: "2024-01-01T00:01:30Z", // 1 minute 30 seconds
          artifact: { name: null, version: null },
        });
      }),
      http.get("*/api/agent/runs/:id/telemetry/agent", () => {
        return HttpResponse.json(createDefaultAgentEventsResponse());
      }),
    );

    await setupPage({
      context,
      path: "/logs/run-duration-test",
    });

    await waitFor(() => {
      expect(screen.getByText("1m 30s")).toBeInTheDocument();
    });
  });

  it("should display dash when sessionId is null", async () => {
    server.use(
      http.get("*/api/platform/logs/:id", () => {
        return HttpResponse.json({
          id: "run-no-session",
          sessionId: null,
          agentName: "No Session Agent",
          provider: "claude-code",
          status: "pending",
          prompt: "Test",
          error: null,
          createdAt: "2024-01-01T00:00:00Z",
          startedAt: null,
          completedAt: null,
          artifact: { name: null, version: null },
        });
      }),
      http.get("*/api/agent/runs/:id/telemetry/agent", () => {
        return HttpResponse.json(createDefaultAgentEventsResponse());
      }),
    );

    await setupPage({
      context,
      path: "/logs/run-no-session",
    });

    await waitFor(() => {
      expect(screen.getByText("No Session Agent")).toBeInTheDocument();
    });

    // Session ID should show dash
    const sessionLabel = screen.getByText("Session ID");
    const sessionItem = sessionLabel.closest("div");
    expect(sessionItem).toContainHTML("-");
  });

  it("should display error message for failed runs", async () => {
    server.use(
      http.get("*/api/platform/logs/:id", () => {
        return HttpResponse.json({
          id: "run-failed",
          sessionId: null,
          agentName: "Failed Agent",
          provider: "claude-code",
          status: "failed",
          prompt: "Test",
          error: "Connection timeout after 30 seconds",
          createdAt: "2024-01-01T00:00:00Z",
          startedAt: "2024-01-01T00:00:01Z",
          completedAt: null,
          artifact: { name: null, version: null },
        });
      }),
      http.get("*/api/agent/runs/:id/telemetry/agent", () => {
        return HttpResponse.json(createDefaultAgentEventsResponse());
      }),
    );

    await setupPage({
      context,
      path: "/logs/run-failed",
    });

    await waitFor(() => {
      expect(screen.getByText("Failed")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Connection timeout after 30 seconds"),
    ).toBeInTheDocument();
  });

  it("should display raw data card with agent events", async () => {
    server.use(
      http.get("*/api/platform/logs/:id", () => {
        return HttpResponse.json({
          id: "run-raw-data",
          sessionId: "session-raw",
          agentName: "Raw Data Agent",
          provider: "claude-code",
          status: "completed",
          prompt: "Generate something",
          error: null,
          createdAt: "2024-01-01T00:00:00Z",
          startedAt: "2024-01-01T00:00:01Z",
          completedAt: "2024-01-01T00:00:10Z",
          artifact: { name: null, version: null },
        });
      }),
      http.get("*/api/agent/runs/:id/telemetry/agent", () => {
        return HttpResponse.json({
          events: [
            {
              sequenceNumber: 1,
              eventType: "text",
              eventData: { content: "Starting task" },
              createdAt: "2024-01-01T00:00:02Z",
            },
            {
              sequenceNumber: 2,
              eventType: "tool_use",
              eventData: { tool: "read_file", path: "/test.txt" },
              createdAt: "2024-01-01T00:00:03Z",
            },
          ],
          hasMore: false,
          framework: "claude-code",
        });
      }),
    );

    await setupPage({
      context,
      path: "/logs/run-raw-data",
    });

    await waitFor(() => {
      expect(screen.getByText("Log raw data")).toBeInTheDocument();
    });

    // Verify log content is displayed (formatted as log text)
    await waitFor(() => {
      expect(screen.getByText(/Starting task/)).toBeInTheDocument();
    });

    // Verify tool_use event is displayed in log format
    expect(screen.getByText(/\[tool_use\]/)).toBeInTheDocument();
  });

  it("should navigate to logs list via breadcrumb", async () => {
    server.use(
      http.get("*/api/platform/logs", () => {
        return HttpResponse.json({
          data: [],
          pagination: { has_more: false, next_cursor: null },
        });
      }),
      http.get("*/api/platform/logs/:id", () => {
        return HttpResponse.json({
          id: "run-back-test",
          sessionId: null,
          agentName: "Back Test Agent",
          provider: "claude-code",
          status: "completed",
          prompt: "Test",
          error: null,
          createdAt: "2024-01-01T00:00:00Z",
          startedAt: null,
          completedAt: null,
          artifact: { name: null, version: null },
        });
      }),
      http.get("*/api/agent/runs/:id/telemetry/agent", () => {
        return HttpResponse.json(createDefaultAgentEventsResponse());
      }),
    );

    await setupPage({
      context,
      path: "/logs/run-back-test",
    });

    // Wait for page to load - check for agent name
    await waitFor(() => {
      expect(screen.getByText("Back Test Agent")).toBeInTheDocument();
    });

    // Click Logs link in breadcrumb
    await user.click(screen.getByText("Logs"));

    // Should navigate to logs list
    await waitFor(() => {
      expect(context.store.get(pathname$)).toBe("/logs");
    });
  });

  it("should handle API error gracefully", async () => {
    server.use(
      http.get("*/api/platform/logs/:id", () => {
        return HttpResponse.json(
          { error: { message: "Run not found", code: "NOT_FOUND" } },
          { status: 404 },
        );
      }),
      http.get("*/api/agent/runs/:id/telemetry/agent", () => {
        return HttpResponse.json(createDefaultAgentEventsResponse());
      }),
    );

    await setupPage({
      context,
      path: "/logs/non-existent-run",
    });

    await waitFor(() => {
      expect(screen.getByText(/Error:/)).toBeInTheDocument();
    });
  });

  it("should display no events message when events array is empty", async () => {
    server.use(
      http.get("*/api/platform/logs/:id", () => {
        return HttpResponse.json({
          id: "run-no-events",
          sessionId: null,
          agentName: "No Events Agent",
          provider: "claude-code",
          status: "pending",
          prompt: "Test",
          error: null,
          createdAt: "2024-01-01T00:00:00Z",
          startedAt: null,
          completedAt: null,
          artifact: { name: null, version: null },
        });
      }),
      http.get("*/api/agent/runs/:id/telemetry/agent", () => {
        return HttpResponse.json({
          events: [],
          hasMore: false,
          framework: "claude-code",
        });
      }),
    );

    await setupPage({
      context,
      path: "/logs/run-no-events",
    });

    await waitFor(() => {
      expect(screen.getByText("No events available")).toBeInTheDocument();
    });
  });
});
