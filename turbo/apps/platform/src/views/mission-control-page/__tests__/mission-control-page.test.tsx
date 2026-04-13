import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();

function createAgent() {
  return {
    id: "agent-1",
    name: "test-agent",
    displayName: "Test Agent",
    avatarUrl: null,
  };
}

function mockTasksAPI(
  tasks: {
    id: string;
    type: "chat" | "schedule" | "slack" | "email";
    title: string | null;
    summary: string | null;
    agent: {
      id: string;
      name: string;
      displayName: string | null;
      avatarUrl: string | null;
    };
    latestRunId: string | null;
    status: string | null;
    chatThreadId?: string;
    scheduleId?: string;
    slackThreadSessionId?: string;
    emailThreadSessionId?: string;
    createdAt: string;
    updatedAt: string;
  }[],
) {
  server.use(
    http.get("*/api/zero/tasks", () => {
      return HttpResponse.json({ tasks });
    }),
  );
}

function mockActivityAPIs(runId: string) {
  server.use(
    http.get(`*/api/zero/logs/${runId}`, () => {
      return HttpResponse.json({
        id: runId,
        displayName: "Test Agent",
        status: "completed",
        agentId: "agent-1",
        sessionId: null,
        triggerSource: null,
        triggerAgentName: null,
        modelProvider: null,
        selectedModel: null,
        framework: null,
        prompt: null,
        appendSystemPrompt: null,
        error: null,
        createdAt: "2026-04-10T10:00:00Z",
        startedAt: "2026-04-10T10:00:01Z",
        completedAt: "2026-04-10T10:00:05Z",
        artifact: null,
      });
    }),
    http.get(`*/api/zero/runs/${runId}/telemetry/agent`, () => {
      return HttpResponse.json({ events: [], hasMore: false });
    }),
  );
}

describe("mission control page", () => {
  it("should render tasks list with task cards", async () => {
    mockTasksAPI([
      {
        id: "task-1",
        type: "chat",
        title: "Help with code review",
        summary: null,
        agent: createAgent(),
        latestRunId: null,
        status: null,
        chatThreadId: "thread-1",
        createdAt: "2026-04-10T10:00:00Z",
        updatedAt: "2026-04-10T10:00:00Z",
      },
      {
        id: "task-2",
        type: "schedule",
        title: "Daily report",
        summary: null,
        agent: createAgent(),
        latestRunId: "run-1",
        status: "completed",
        scheduleId: "sched-1",
        createdAt: "2026-04-10T09:00:00Z",
        updatedAt: "2026-04-10T09:30:00Z",
      },
    ]);

    detachedSetupPage({ context, path: "/_/mission-control" });

    await waitFor(() => {
      expect(screen.getByText("Help with code review")).toBeInTheDocument();
    });

    expect(screen.getByText("Daily report")).toBeInTheDocument();
  });

  it("should show empty state when no tasks exist", async () => {
    mockTasksAPI([]);

    detachedSetupPage({ context, path: "/_/mission-control" });

    await waitFor(() => {
      expect(screen.getByText("No active tasks")).toBeInTheDocument();
    });
  });

  it("should open task panel when clicking a chat task", async () => {
    mockTasksAPI([
      {
        id: "task-chat",
        type: "chat",
        title: "Chat task",
        summary: null,
        agent: createAgent(),
        latestRunId: null,
        status: null,
        chatThreadId: "thread-abc",
        createdAt: "2026-04-10T10:00:00Z",
        updatedAt: "2026-04-10T10:00:00Z",
      },
    ]);

    server.use(
      http.get("*/api/zero/chat-threads/:id", () => {
        return HttpResponse.json({
          id: "thread-abc",
          title: null,
          agentId: "00000000-0000-4000-a000-000000000000",
          chatMessages: [],
          latestSessionId: null,
          unsavedRuns: [],
          createdAt: "2026-04-10T10:00:00Z",
          updatedAt: "2026-04-10T10:00:00Z",
        });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    const user = userEvent.setup();

    detachedSetupPage({ context, path: "/_/mission-control" });

    const title = await waitFor(() => {
      return screen.getByText("Chat task");
    });

    await user.click(title);

    await waitFor(() => {
      expect(screen.getByLabelText("Close task")).toBeInTheDocument();
    });

    expect(pathname()).toBe("/_/mission-control");
  });

  it("should open task panel when clicking a schedule task", async () => {
    mockTasksAPI([
      {
        id: "task-sched",
        type: "schedule",
        title: "Scheduled task",
        summary: null,
        agent: createAgent(),
        latestRunId: "run-xyz",
        status: "completed",
        scheduleId: "sched-1",
        createdAt: "2026-04-10T10:00:00Z",
        updatedAt: "2026-04-10T10:00:00Z",
      },
    ]);

    mockActivityAPIs("run-xyz");

    const user = userEvent.setup();

    detachedSetupPage({ context, path: "/_/mission-control" });

    const title = await waitFor(() => {
      return screen.getByText("Scheduled task");
    });

    await user.click(title);

    await waitFor(() => {
      expect(screen.getByLabelText("Close task")).toBeInTheDocument();
    });

    expect(pathname()).toBe("/_/mission-control");
  });

  it("should open task panel when clicking an email task", async () => {
    mockTasksAPI([
      {
        id: "task-email",
        type: "email",
        title: "Email task",
        summary: null,
        agent: createAgent(),
        latestRunId: "run-email-1",
        status: "running",
        emailThreadSessionId: "email-session-1",
        createdAt: "2026-04-10T10:00:00Z",
        updatedAt: "2026-04-10T10:00:00Z",
      },
    ]);

    mockActivityAPIs("run-email-1");

    const user = userEvent.setup();

    detachedSetupPage({ context, path: "/_/mission-control" });

    const title = await waitFor(() => {
      return screen.getByText("Email task");
    });

    await user.click(title);

    await waitFor(() => {
      expect(screen.getByLabelText("Close task")).toBeInTheDocument();
    });

    expect(pathname()).toBe("/_/mission-control");
  });

  it("should open task panel when clicking a slack task", async () => {
    mockTasksAPI([
      {
        id: "task-slack",
        type: "slack",
        title: "Slack task",
        summary: null,
        agent: createAgent(),
        latestRunId: "run-slack-1",
        status: "running",
        slackThreadSessionId: "slack-session-1",
        createdAt: "2026-04-10T10:00:00Z",
        updatedAt: "2026-04-10T10:00:00Z",
      },
    ]);

    mockActivityAPIs("run-slack-1");

    const user = userEvent.setup();

    detachedSetupPage({ context, path: "/_/mission-control" });

    const title = await waitFor(() => {
      return screen.getByText("Slack task");
    });

    await user.click(title);

    await waitFor(() => {
      expect(screen.getByLabelText("Close task")).toBeInTheDocument();
    });

    expect(pathname()).toBe("/_/mission-control");
  });

  it("should remove task from list when y key is pressed on focused card", async () => {
    server.use(
      http.get("*/api/zero/tasks", () => {
        return HttpResponse.json({
          tasks: [
            {
              id: "task-key",
              type: "chat",
              title: "Keyboard Archive Task",
              summary: null,
              agent: createAgent(),
              latestRunId: "run-key-1",
              status: "completed",
              chatThreadId: "thread-key",
              createdAt: "2026-04-10T10:00:00Z",
              updatedAt: "2026-04-10T10:00:00Z",
            },
          ],
        });
      }),
      http.post("*/api/zero/tasks/archive", () => {
        server.use(
          http.get("*/api/zero/tasks", () => {
            return HttpResponse.json({ tasks: [] });
          }),
        );
        return HttpResponse.json({ ok: true });
      }),
    );

    const user = userEvent.setup();
    detachedSetupPage({ context, path: "/_/mission-control" });

    const title = await waitFor(() => {
      return screen.getByText("Keyboard Archive Task");
    });
    const card = title.closest("[role=button]") as HTMLElement;

    // Focus the card so its data-task-id is picked up by the y shortcut
    await user.click(card);
    card.focus();

    await user.keyboard("y");

    await waitFor(() => {
      expect(
        screen.queryByText("Keyboard Archive Task"),
      ).not.toBeInTheDocument();
    });
  });

  it("should remove task from list when archive button is clicked", async () => {
    let archiveRequestBody: unknown = null;

    // Initially return the task
    server.use(
      http.get("*/api/zero/tasks", () => {
        return HttpResponse.json({
          tasks: [
            {
              id: "task-arc",
              type: "chat",
              title: "Archivable Task",
              summary: null,
              agent: createAgent(),
              latestRunId: "run-arc-1",
              status: "completed",
              chatThreadId: "thread-arc",
              createdAt: "2026-04-10T10:00:00Z",
              updatedAt: "2026-04-10T10:00:00Z",
            },
          ],
        });
      }),
    );

    server.use(
      http.post("*/api/zero/tasks/archive", async ({ request }) => {
        archiveRequestBody = await request.json();
        // After archive, update the tasks API to return empty list
        server.use(
          http.get("*/api/zero/tasks", () => {
            return HttpResponse.json({ tasks: [] });
          }),
        );
        return HttpResponse.json({ ok: true });
      }),
    );

    const user = userEvent.setup();
    detachedSetupPage({ context, path: "/_/mission-control" });

    const title = await waitFor(() => {
      return screen.getByText("Archivable Task");
    });
    const card = title.closest("[role=button]") as HTMLElement;
    await user.hover(card);

    const archiveBtn = await waitFor(() => {
      return screen.getByLabelText("Archive task");
    });
    await user.click(archiveBtn);

    await waitFor(() => {
      expect(screen.queryByText("Archivable Task")).not.toBeInTheDocument();
    });

    expect(archiveRequestBody).toMatchObject({
      taskId: "task-arc",
      taskType: "chat",
      runId: "run-arc-1",
    });
  });
});
