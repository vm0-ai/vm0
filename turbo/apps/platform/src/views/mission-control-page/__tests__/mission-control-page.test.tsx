import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import {
  addOptimisticTask$,
  setupTasksLoop$,
  taskSignals$,
} from "../../../signals/mission-control-page/mission-control-tasks.ts";
import { createAndShowChatTask$ } from "../../../signals/mission-control-page/mission-control.ts";
import { detach, Reason } from "../../../signals/utils.ts";

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

  it("should show task card immediately after creating a new chat via the c shortcut", async () => {
    // Start with empty task list
    server.use(
      http.get("*/api/zero/tasks", () => {
        return HttpResponse.json({ tasks: [] });
      }),
    );

    const user = userEvent.setup();
    detachedSetupPage({ context, path: "/_/mission-control" });

    // Wait for empty state to render
    await waitFor(() => {
      expect(screen.getByText("No active tasks")).toBeInTheDocument();
    });

    // Press 'c' to open new chat dialog
    await user.keyboard("c");

    // The dialog should show — click the lead agent button (displayed as "Zero")
    const agentName = await waitFor(() => {
      return screen.getByText("Zero");
    });
    await user.click(agentName);

    // Optimistic task card should appear immediately (no polling needed)
    await waitFor(() => {
      expect(screen.queryByText("No active tasks")).not.toBeInTheDocument();
    });

    // Chat panel should be open
    await waitFor(() => {
      expect(screen.getByLabelText("Close task")).toBeInTheDocument();
    });
  });

  it("should prune stale optimistic entry after TTL expires", async () => {
    // Tasks API always returns empty — no server confirmation arrives
    server.use(
      http.get("*/api/zero/tasks", () => {
        return HttpResponse.json({ tasks: [] });
      }),
    );

    detachedSetupPage({
      context,
      path: "/_/mission-control",
      withoutRender: true,
    });

    // Insert optimistic entry with optimisticInsertedAt set 31 seconds in the past
    const staleInsertedAt = Date.now() - 31_000;
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(staleInsertedAt);
    context.store.set(
      addOptimisticTask$,
      "agent-1",
      "stale-thread-ttl",
      "Test Agent",
      null,
    );
    dateSpy.mockRestore();

    // Entry must exist before the loop runs
    const signalsBefore = await context.store.get(taskSignals$);
    expect(
      signalsBefore.some((ts) => {
        return ts.task.id === "stale-thread-ttl";
      }),
    ).toBeTruthy();

    // Run the loop with the test-scoped signal — Date.now() returns real time
    // (31s after staleInsertedAt), so the TTL check fires and prunes the entry.
    // The loop is aborted by afterEach when the test context signal is aborted.
    detach(context.store.set(setupTasksLoop$, context.signal), Reason.Daemon);

    await waitFor(async () => {
      const signals = await context.store.get(taskSignals$);
      expect(
        signals.some((ts) => {
          return ts.task.id === "stale-thread-ttl";
        }),
      ).toBeFalsy();
    });
  });

  it("should return early from createAndShowChatTask$ when no agent is available", async () => {
    // Return empty agent list and no defaultAgentId so resolvedAgentId is undefined
    server.use(
      http.get("*/api/zero/team", () => {
        return HttpResponse.json([]);
      }),
      http.get("*/api/zero/onboarding/status", () => {
        return HttpResponse.json({
          needsOnboarding: false,
          isAdmin: true,
          hasOrg: true,
          hasDefaultAgent: false,
          defaultAgentId: null,
          defaultAgentMetadata: null,
        });
      }),
      http.get("*/api/zero/tasks", () => {
        return HttpResponse.json({ tasks: [] });
      }),
    );

    detachedSetupPage({
      context,
      path: "/_/mission-control",
      withoutRender: true,
    });

    // createAndShowChatTask$ should return early without inserting any optimistic entry
    await context.store.set(createAndShowChatTask$, null, context.signal);

    const signals = await context.store.get(taskSignals$);
    expect(signals).toHaveLength(0);
  });

  it("should show user bubble with prompt for completed schedule task", async () => {
    const runId = "run-chat-completed";
    mockTasksAPI([
      {
        id: "task-sched-completed",
        type: "schedule",
        title: "Completed Schedule Task",
        summary: null,
        agent: createAgent(),
        latestRunId: runId,
        status: "completed",
        scheduleId: "sched-done",
        createdAt: "2026-04-10T10:00:00Z",
        updatedAt: "2026-04-10T10:00:00Z",
      },
    ]);

    server.use(
      http.get(`*/api/zero/logs/${runId}`, () => {
        return HttpResponse.json({
          id: "00000000-0000-4000-a000-000000000001",
          displayName: "Test Agent",
          status: "completed",
          agentId: "agent-1",
          sessionId: null,
          triggerSource: "schedule",
          triggerAgentName: null,
          modelProvider: null,
          selectedModel: null,
          framework: null,
          scheduleId: null,
          prompt: "Send the daily report",
          appendSystemPrompt: null,
          error: null,
          createdAt: "2026-04-10T10:00:00Z",
          startedAt: "2026-04-10T10:00:01Z",
          completedAt: "2026-04-10T10:00:05Z",
          artifact: { name: null, version: null },
        });
      }),
      http.get(`*/api/zero/runs/${runId}/telemetry/agent`, () => {
        return HttpResponse.json({
          events: [],
          hasMore: false,
          framework: "anthropic",
        });
      }),
    );

    const user = userEvent.setup();
    detachedSetupPage({ context, path: "/_/mission-control" });

    const title = await waitFor(() => {
      return screen.getByText("Completed Schedule Task");
    });
    await user.click(title);

    await waitFor(() => {
      expect(screen.getByText("Send the daily report")).toBeInTheDocument();
    });
  });

  it("should show assistant result bubble for completed task with result event", async () => {
    const runId = "run-with-result";
    mockTasksAPI([
      {
        id: "task-sched-result",
        type: "schedule",
        title: "Schedule Task With Result",
        summary: null,
        agent: createAgent(),
        latestRunId: runId,
        status: "completed",
        scheduleId: "sched-result",
        createdAt: "2026-04-10T10:00:00Z",
        updatedAt: "2026-04-10T10:00:00Z",
      },
    ]);

    server.use(
      http.get(`*/api/zero/logs/${runId}`, () => {
        return HttpResponse.json({
          id: "00000000-0000-4000-a000-000000000002",
          displayName: "Test Agent",
          status: "completed",
          agentId: "agent-1",
          sessionId: null,
          triggerSource: "schedule",
          triggerAgentName: null,
          modelProvider: null,
          selectedModel: null,
          framework: null,
          scheduleId: null,
          prompt: "Generate a daily report",
          appendSystemPrompt: null,
          error: null,
          createdAt: "2026-04-10T10:00:00Z",
          startedAt: "2026-04-10T10:00:01Z",
          completedAt: "2026-04-10T10:00:05Z",
          artifact: { name: null, version: null },
        });
      }),
      http.get(`*/api/zero/runs/${runId}/telemetry/agent`, () => {
        return HttpResponse.json({
          events: [
            {
              sequenceNumber: 1,
              eventType: "result",
              eventData: { result: "Here is your daily report" },
              createdAt: "2026-04-10T10:00:05Z",
            },
          ],
          hasMore: false,
          framework: "anthropic",
        });
      }),
    );

    const user = userEvent.setup();
    detachedSetupPage({ context, path: "/_/mission-control" });

    const title = await waitFor(() => {
      return screen.getByText("Schedule Task With Result");
    });
    await user.click(title);

    await waitFor(() => {
      expect(screen.getByText("Here is your daily report")).toBeInTheDocument();
    });

    expect(
      screen.queryByPlaceholderText("Search steps"),
    ).not.toBeInTheDocument();
  });

  it("should show steps list for running email task, not assistant bubbles", async () => {
    const runId = "run-running-email";
    mockTasksAPI([
      {
        id: "task-running-email",
        type: "email",
        title: "Running Email Task",
        summary: null,
        agent: createAgent(),
        latestRunId: runId,
        status: "running",
        emailThreadSessionId: "email-session-running",
        createdAt: "2026-04-10T10:00:00Z",
        updatedAt: "2026-04-10T10:00:00Z",
      },
    ]);

    server.use(
      http.get(`*/api/zero/logs/${runId}`, () => {
        return HttpResponse.json({
          id: "00000000-0000-4000-a000-000000000003",
          displayName: "Test Agent",
          status: "running",
          agentId: "agent-1",
          sessionId: null,
          triggerSource: "email",
          triggerAgentName: null,
          modelProvider: null,
          selectedModel: null,
          framework: null,
          scheduleId: null,
          prompt: "Reply to customer inquiry",
          appendSystemPrompt: null,
          error: null,
          createdAt: "2026-04-10T10:00:00Z",
          startedAt: "2026-04-10T10:00:01Z",
          completedAt: null,
          artifact: { name: null, version: null },
        });
      }),
      http.get(`*/api/zero/runs/${runId}/telemetry/agent`, () => {
        return HttpResponse.json({
          events: [],
          hasMore: false,
          framework: "anthropic",
        });
      }),
    );

    const user = userEvent.setup();
    detachedSetupPage({ context, path: "/_/mission-control" });

    const title = await waitFor(() => {
      return screen.getByText("Running Email Task");
    });
    await user.click(title);

    await waitFor(() => {
      expect(
        screen.getAllByText("Reply to customer inquiry").length,
      ).toBeGreaterThan(0);
    });

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Search steps")).toBeInTheDocument();
    });
  });

  it("should show prompt bubble but no assistant bubble when completed task has no result events", async () => {
    const runId = "run-no-result";
    mockTasksAPI([
      {
        id: "task-no-result",
        type: "schedule",
        title: "Task With No Result",
        summary: null,
        agent: createAgent(),
        latestRunId: runId,
        status: "completed",
        scheduleId: "sched-no-result",
        createdAt: "2026-04-10T10:00:00Z",
        updatedAt: "2026-04-10T10:00:00Z",
      },
    ]);

    server.use(
      http.get(`*/api/zero/logs/${runId}`, () => {
        return HttpResponse.json({
          id: "00000000-0000-4000-a000-000000000004",
          displayName: "Test Agent",
          status: "completed",
          agentId: "agent-1",
          sessionId: null,
          triggerSource: "schedule",
          triggerAgentName: null,
          modelProvider: null,
          selectedModel: null,
          framework: null,
          scheduleId: null,
          prompt: "Fetch news summary",
          appendSystemPrompt: null,
          error: null,
          createdAt: "2026-04-10T10:00:00Z",
          startedAt: "2026-04-10T10:00:01Z",
          completedAt: "2026-04-10T10:00:05Z",
          artifact: { name: null, version: null },
        });
      }),
      http.get(`*/api/zero/runs/${runId}/telemetry/agent`, () => {
        return HttpResponse.json({
          events: [],
          hasMore: false,
          framework: "anthropic",
        });
      }),
    );

    const user = userEvent.setup();
    detachedSetupPage({ context, path: "/_/mission-control" });

    const title = await waitFor(() => {
      return screen.getByText("Task With No Result");
    });
    await user.click(title);

    await waitFor(() => {
      expect(screen.getByText("Fetch news summary")).toBeInTheDocument();
    });

    expect(
      screen.queryByPlaceholderText("Search steps"),
    ).not.toBeInTheDocument();
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

  it("should render voice_chat task type with Voice Chat label", async () => {
    server.use(
      http.get("*/api/zero/tasks", () => {
        return HttpResponse.json({
          tasks: [
            {
              id: "task-vc",
              type: "voice_chat",
              title: "Voice session with Zero",
              summary: null,
              agent: createAgent(),
              latestRunId: "run-vc-1",
              status: "running",
              // voice_chat tasks have no chatThreadId — omit optional fields
              createdAt: "2026-04-13T10:00:00Z",
              updatedAt: "2026-04-13T10:00:00Z",
            },
          ],
        });
      }),
    );

    detachedSetupPage({ context, path: "/_/mission-control" });

    // Title renders
    await waitFor(() => {
      expect(screen.getByText("Voice session with Zero")).toBeInTheDocument();
    });
    // Microphone icon rendered (voice_chat maps to IconMicrophone)
    const card = screen
      .getByText("Voice session with Zero")
      .closest("[role=button]") as HTMLElement;
    expect(card.querySelector(".tabler-icon-microphone")).not.toBeNull();
  });

  it("should open new chat dialog when c key is pressed", async () => {
    mockTasksAPI([]);

    const user = userEvent.setup();
    detachedSetupPage({ context, path: "/_/mission-control" });

    await waitFor(() => {
      expect(screen.getByText("No active tasks")).toBeInTheDocument();
    });

    // c shortcut is registered by setupMissionControlKeyboard$
    await user.keyboard("c");

    await waitFor(() => {
      // AgentListDialog title
      expect(screen.getByText("Talk to")).toBeInTheDocument();
    });
  });
});
