import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import type {
  LogDetail,
  AgentEventsResponse,
} from "../../../signals/zero-page/log-types.ts";

const context = testContext();

function queueResponse(overrides?: {
  runningTasks?: unknown[];
  queue?: unknown[];
  estimatedTimePerRun?: number | null;
}) {
  return {
    concurrency: { tier: "free", limit: 2, active: 1, available: 1 },
    queue: overrides?.queue ?? [],
    runningTasks: overrides?.runningTasks ?? [],
    estimatedTimePerRun: overrides?.estimatedTimePerRun ?? null,
  };
}

describe("queue-d-010: running tasks count and row details displayed", () => {
  it("shows task count and row details including agent name, user email, and relative start time", async () => {
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(
          queueResponse({
            runningTasks: [
              {
                runId: "run-001",
                agentName: "my-agent",
                agentDisplayName: "My Agent",
                userEmail: "alice@example.com",
                startedAt: new Date().toISOString(),
                isOwner: false,
              },
            ],
          }),
        );
      }),
    );
    await setupPage({ context, path: "/queues" });
    await waitFor(() => {
      expect(screen.getByText("Running (1)")).toBeInTheDocument();
      expect(screen.getByText("My Agent")).toBeInTheDocument();
      expect(screen.getByText("alice@example.com")).toBeInTheDocument();
      expect(screen.getByText("just now")).toBeInTheDocument();
    });
  });
});

describe("queue-d-011: starting status with animated icon", () => {
  it("shows Starting text with animated icon when startedAt is null", async () => {
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(
          queueResponse({
            runningTasks: [
              {
                runId: null,
                agentName: "starting-agent",
                agentDisplayName: "Starting Agent",
                userEmail: "bob@example.com",
                startedAt: null,
                isOwner: false,
              },
            ],
          }),
        );
      }),
    );
    await setupPage({ context, path: "/queues" });
    await waitFor(() => {
      expect(screen.getByText("Starting")).toBeInTheDocument();
    });
  });
});

describe("queue-c-012: empty state when no tasks are running", () => {
  it("shows no tasks currently running message", async () => {
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(queueResponse({ runningTasks: [] }));
      }),
    );
    await setupPage({ context, path: "/queues" });
    await waitFor(() => {
      expect(
        screen.getByText("No tasks currently running."),
      ).toBeInTheDocument();
    });
  });
});

function mockActivityDetailAPIs(runId: string) {
  const logDetail: LogDetail = {
    id: runId,
    sessionId: "session_1",
    agentId: "nav-agent",
    displayName: "Nav Agent",
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
            name: "nav-agent",
            displayName: "Nav Agent",
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

describe("queue-n-013: view logs link navigates to activity detail", () => {
  it("navigates to /activities/:id when View logs is clicked in running table", async () => {
    const user = userEvent.setup();
    const runId = "a0000000-0000-4000-a000-000000000011";
    mockActivityDetailAPIs(runId);
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(
          queueResponse({
            runningTasks: [
              {
                runId,
                agentName: "nav-agent",
                agentDisplayName: "Nav Agent",
                userEmail: "nav@example.com",
                startedAt: new Date().toISOString(),
                isOwner: false,
              },
            ],
          }),
        );
      }),
    );
    await setupPage({ context, path: "/queues" });
    await waitFor(() => {
      expect(screen.getByText("Nav Agent")).toBeInTheDocument();
    });
    await user.click(screen.getByText("View logs"));
    await waitFor(() => {
      expect(pathname()).toBe(`/activities/${runId}`);
      expect(
        screen.getByRole("heading", { name: "Nav Agent" }),
      ).toBeInTheDocument();
    });
  });
});

describe("queue-i-014: cancel button cancels a running task", () => {
  it("calls cancel endpoint with the correct runId when Cancel is clicked", async () => {
    const user = userEvent.setup();
    let cancelledRunId: string | null = null;
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(
          queueResponse({
            runningTasks: [
              {
                runId: "run-cancel-001",
                agentName: "cancel-agent",
                agentDisplayName: "Cancel Agent",
                userEmail: "cancel@example.com",
                startedAt: new Date().toISOString(),
                isOwner: true,
              },
            ],
          }),
        );
      }),
      http.post("*/api/zero/runs/:runId/cancel", ({ params }) => {
        cancelledRunId = params.runId as string;
        return HttpResponse.json({
          id: params.runId,
          status: "cancelled",
          message: "Run cancelled",
        });
      }),
    );
    await setupPage({ context, path: "/queues" });
    await waitFor(() => {
      expect(screen.getByText("Cancel Agent")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(cancelledRunId).toBe("run-cancel-001");
    });
  });
});

describe("queue-d-015: waiting tasks count and row details displayed", () => {
  it("shows queue count and row details including position, agent, user, time, and est wait", async () => {
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(
          queueResponse({
            queue: [
              {
                position: 1,
                agentName: "wait-agent",
                agentDisplayName: "Wait Agent",
                userEmail: "wait@example.com",
                createdAt: new Date().toISOString(),
                isOwner: false,
                runId: "run-wait-001",
                prompt: null,
                triggerSource: null,
                sessionLink: null,
              },
            ],
            estimatedTimePerRun: 30_000,
          }),
        );
      }),
    );
    await setupPage({ context, path: "/queues" });
    await waitFor(() => {
      expect(screen.getByText("Waiting (1)")).toBeInTheDocument();
      expect(screen.getByText("Wait Agent")).toBeInTheDocument();
      expect(screen.getByText("wait@example.com")).toBeInTheDocument();
      expect(screen.getByText("~30s")).toBeInTheDocument();
    });
  });
});

describe("queue-c-016: empty state when no tasks are waiting", () => {
  it("shows no tasks in queue message", async () => {
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(queueResponse({ queue: [] }));
      }),
    );
    await setupPage({ context, path: "/queues" });
    await waitFor(() => {
      expect(screen.getByText("No tasks in queue.")).toBeInTheDocument();
    });
  });
});

describe("queue-n-017: view logs link navigates to activity detail for waiting task", () => {
  it("navigates to /activities/:id when View logs is clicked in waiting table", async () => {
    const user = userEvent.setup();
    const runId = "a0000000-0000-4000-a000-000000000012";
    mockActivityDetailAPIs(runId);
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(
          queueResponse({
            queue: [
              {
                position: 1,
                agentName: "wait-nav-agent",
                agentDisplayName: "Wait Nav Agent",
                userEmail: "waitnav@example.com",
                createdAt: new Date().toISOString(),
                isOwner: false,
                runId,
                prompt: null,
                triggerSource: null,
                sessionLink: null,
              },
            ],
          }),
        );
      }),
    );
    await setupPage({ context, path: "/queues" });
    await waitFor(() => {
      expect(screen.getByText("Wait Nav Agent")).toBeInTheDocument();
    });
    await user.click(screen.getByText("View logs"));
    await waitFor(() => {
      expect(pathname()).toBe(`/activities/${runId}`);
      expect(
        screen.getByRole("heading", { name: "Nav Agent" }),
      ).toBeInTheDocument();
    });
  });
});

describe("queue-c-018: cancel button shown only for owner tasks with runId", () => {
  it("shows Cancel only for entry where isOwner is true and runId is non-null", async () => {
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(
          queueResponse({
            queue: [
              {
                position: 1,
                agentName: "owner-agent",
                agentDisplayName: "Owner Agent",
                userEmail: "owner@example.com",
                createdAt: new Date().toISOString(),
                isOwner: true,
                runId: "run-owner-001",
                prompt: null,
                triggerSource: null,
                sessionLink: null,
              },
              {
                position: 2,
                agentName: "non-owner-agent",
                agentDisplayName: "Non Owner Agent",
                userEmail: "other@example.com",
                createdAt: new Date().toISOString(),
                isOwner: false,
                runId: "run-other-001",
                prompt: null,
                triggerSource: null,
                sessionLink: null,
              },
              {
                position: 3,
                agentName: "no-runid-agent",
                agentDisplayName: "No RunId Agent",
                userEmail: "norunid@example.com",
                createdAt: new Date().toISOString(),
                isOwner: true,
                runId: null,
                prompt: null,
                triggerSource: null,
                sessionLink: null,
              },
            ],
          }),
        );
      }),
    );
    await setupPage({ context, path: "/queues" });
    await waitFor(() => {
      expect(screen.getByText("Owner Agent")).toBeInTheDocument();
    });
    const cancelButtons = screen.getAllByRole("button", { name: "Cancel" });
    expect(cancelButtons).toHaveLength(1);
  });
});

describe("queue-i-019: cancel button cancels a waiting task", () => {
  it("calls cancel endpoint when Cancel is clicked on a waiting task", async () => {
    const user = userEvent.setup();
    let cancelledRunId: string | null = null;
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(
          queueResponse({
            queue: [
              {
                position: 1,
                agentName: "wait-cancel-agent",
                agentDisplayName: "Wait Cancel Agent",
                userEmail: "waitcancel@example.com",
                createdAt: new Date().toISOString(),
                isOwner: true,
                runId: "run-wait-cancel-001",
                prompt: null,
                triggerSource: null,
                sessionLink: null,
              },
            ],
          }),
        );
      }),
      http.post("*/api/zero/runs/:runId/cancel", ({ params }) => {
        cancelledRunId = params.runId as string;
        return HttpResponse.json({
          id: params.runId,
          status: "cancelled",
          message: "Run cancelled",
        });
      }),
    );
    await setupPage({ context, path: "/queues" });
    await waitFor(() => {
      expect(screen.getByText("Wait Cancel Agent")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(cancelledRunId).toBe("run-wait-cancel-001");
    });
  });
});
