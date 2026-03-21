import { describe, expect, it } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import type {
  LogDetail,
  AgentEventsResponse,
} from "../../../signals/zero-page/log-types.ts";

const context = testContext();

function mockActivityAPIs() {
  const logs = [
    {
      id: "log-1",
      sessionId: "session-1",
      agentName: "test-agent",
      displayName: "Test Agent",
      orgSlug: "test",
      framework: "claude-code",
      status: "completed",
      triggerSource: "web",
      createdAt: "2026-03-10T14:56:00Z",
      startedAt: "2026-03-10T14:56:01Z",
      completedAt: "2026-03-10T14:56:04Z",
    },
  ];

  const logDetail: LogDetail = {
    id: "log-1",
    sessionId: "session-1",
    agentName: "test-agent",
    displayName: "Test Agent",
    framework: "claude-code",
    modelProvider: null,
    triggerSource: "web",
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

  server.use(
    http.get("*/api/zero/composes/list", () => {
      return HttpResponse.json({
        composes: [{ name: "test-agent", displayName: "Test Agent" }],
      });
    }),
    http.get("*/api/zero/logs", () => {
      return HttpResponse.json({
        data: logs,
        pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
      });
    }),
    http.get("*/api/zero/logs/:id", ({ params }) => {
      if (params["id"] === "log-1") {
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

describe("activity page routing", () => {
  it("should load detail view when clicking an activity row from the list", async () => {
    mockActivityAPIs();

    await setupPage({
      context,
      path: "/activity",
    });

    // Wait for the list to render with the activity row
    await waitFor(
      () => {
        expect(screen.getByText("Test Agent")).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // Click the activity row — this navigates to /activity/log-1
    const row = screen.getByText("Test Agent").closest("a");
    expect(row).not.toBeNull();
    fireEvent.click(row!);

    // The detail page should render with the agent name heading
    await waitFor(
      () => {
        expect(
          screen.getByRole("heading", { name: "Test Agent" }),
        ).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // Verify detail content loaded (duration)
    expect(screen.getByText("3.0s")).toBeInTheDocument();
  }, 10_000);

  it("should navigate back to list from detail breadcrumb", async () => {
    mockActivityAPIs();

    await setupPage({
      context,
      path: "/activity",
    });

    // Wait for list
    await waitFor(
      () => {
        expect(screen.getByText("Test Agent")).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // Navigate to detail
    const row = screen.getByText("Test Agent").closest("a");
    fireEvent.click(row!);

    // Wait for detail
    await waitFor(
      () => {
        expect(
          screen.getByRole("heading", { name: "Test Agent" }),
        ).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // Click the "Activity" breadcrumb to go back
    const breadcrumb = screen.getByText("Activity").closest("a");
    expect(breadcrumb).not.toBeNull();
    fireEvent.click(breadcrumb!);

    // Should be back on the list page with the "Activity" heading
    await waitFor(
      () => {
        expect(
          screen.getByRole("heading", { name: "Activity" }),
        ).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  }, 10_000);
});
