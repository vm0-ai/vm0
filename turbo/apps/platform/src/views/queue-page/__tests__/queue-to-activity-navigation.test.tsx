import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import type {
  LogDetail,
  AgentEventsResponse,
} from "../../../signals/zero-page/log-types.ts";

const context = testContext();

function mockQueueWithActivityLinks() {
  server.use(
    http.get("*/api/zero/runs/queue", () => {
      return HttpResponse.json({
        concurrency: { tier: "free", limit: 2, active: 1, available: 1 },
        runningTasks: [
          {
            runId: "a0000000-0000-4000-a000-000000000001",
            agentName: "running-agent",
            agentDisplayName: "Running Agent",
            userEmail: "me@test.com",
            startedAt: new Date().toISOString(),
            isOwner: true,
          },
        ],
        queue: [
          {
            position: 1,
            runId: "a0000000-0000-4000-a000-000000000002",
            agentName: "queued-agent",
            agentDisplayName: "Queued Agent",
            userEmail: "me@test.com",
            createdAt: new Date().toISOString(),
            isOwner: true,
            prompt: null,
            triggerSource: null,
            sessionLink: null,
          },
        ],
        estimatedTimePerRun: 30_000,
      });
    }),
  );
}

function mockActivityDetailAPIs(runId: string) {
  const logDetail: LogDetail = {
    id: runId,
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
    prompt: "Run the task",
    appendSystemPrompt: null,
    error: null,
    createdAt: "2026-03-10T00:00:00Z",
    startedAt: "2026-03-10T00:00:01Z",
    completedAt: "2026-03-10T00:00:05Z",
    artifact: { name: null, version: null },
  };

  const eventsResponse: AgentEventsResponse = {
    events: [
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: { content: [{ type: "text", text: "Task completed." }] },
        },
        createdAt: "2026-03-10T00:00:03Z",
      },
    ],
    hasMore: false,
    framework: "claude-code",
  };

  server.use(
    http.get("*/api/zero/composes/list", () => {
      return HttpResponse.json({
        composes: [
          {
            id: "c0000000-0000-4000-a000-000000000001",
            name: "test-agent",
            displayName: "Test Agent",
            headVersionId: "version_1",
            updatedAt: "2024-01-01T00:00:00Z",
          },
        ],
      });
    }),
    http.get("*/api/zero/logs/:id", ({ params }) => {
      if (params["id"] === runId) {
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
  );
}

describe("queue to activity navigation", () => {
  it("should initialize activity page when clicking View logs in running table", async () => {
    const user = userEvent.setup();
    mockQueueWithActivityLinks();
    mockActivityDetailAPIs("a0000000-0000-4000-a000-000000000001");

    await setupPage({ context, path: "/queue" });

    // Wait for running task to render
    await waitFor(() => {
      expect(screen.getByText("Running Agent")).toBeInTheDocument();
    });

    // Find "View logs" links — click the first one (running table)
    const viewLogsLinks = screen.getAllByText("View logs");
    await user.click(viewLogsLinks[0]!);

    // The activity detail page should fully initialize
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Test Agent" }),
      ).toBeInTheDocument();
    });

    expect(screen.getByText("4.0s")).toBeInTheDocument();
  }, 15_000);

  it("should initialize activity page when clicking View logs in waiting table", async () => {
    const user = userEvent.setup();
    mockQueueWithActivityLinks();
    mockActivityDetailAPIs("a0000000-0000-4000-a000-000000000002");

    await setupPage({ context, path: "/queue" });

    // Wait for queued task to render
    await waitFor(() => {
      expect(screen.getByText("Queued Agent")).toBeInTheDocument();
    });

    // Find "View logs" links — click the second one (waiting table)
    const viewLogsLinks = screen.getAllByText("View logs");
    await user.click(viewLogsLinks[1]!);

    // The activity detail page should fully initialize
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Test Agent" }),
      ).toBeInTheDocument();
    });

    expect(screen.getByText("4.0s")).toBeInTheDocument();
  }, 15_000);
});
