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

describe("mission control page", () => {
  it("should render tasks list with task cards", async () => {
    mockTasksAPI([
      {
        id: "task-1",
        type: "chat",
        title: "Help with code review",
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
    expect(screen.getByText("Chat")).toBeInTheDocument();
    expect(screen.getByText("Schedule")).toBeInTheDocument();
  });

  it("should show empty state when no tasks exist", async () => {
    mockTasksAPI([]);

    detachedSetupPage({ context, path: "/_/mission-control" });

    await waitFor(() => {
      expect(screen.getByText("No active tasks")).toBeInTheDocument();
    });
  });

  it("should navigate to chat thread when clicking a chat task", async () => {
    mockTasksAPI([
      {
        id: "task-chat",
        type: "chat",
        title: "Chat task",
        agent: createAgent(),
        latestRunId: null,
        status: null,
        chatThreadId: "thread-abc",
        createdAt: "2026-04-10T10:00:00Z",
        updatedAt: "2026-04-10T10:00:00Z",
      },
    ]);

    const user = userEvent.setup();

    detachedSetupPage({ context, path: "/_/mission-control" });

    const title = await waitFor(() => {
      return screen.getByText("Chat task");
    });

    await user.click(title);

    await waitFor(() => {
      expect(pathname()).toBe("/chats/thread-abc");
    });
  });

  it("should navigate to activity when clicking a schedule task", async () => {
    mockTasksAPI([
      {
        id: "task-sched",
        type: "schedule",
        title: "Scheduled task",
        agent: createAgent(),
        latestRunId: "run-xyz",
        status: "completed",
        scheduleId: "sched-1",
        createdAt: "2026-04-10T10:00:00Z",
        updatedAt: "2026-04-10T10:00:00Z",
      },
    ]);

    const user = userEvent.setup();

    detachedSetupPage({ context, path: "/_/mission-control" });

    const title = await waitFor(() => {
      return screen.getByText("Scheduled task");
    });

    await user.click(title);

    await waitFor(() => {
      expect(pathname()).toBe("/activities/run-xyz");
    });
  });

  it("should navigate to activity when clicking an email task", async () => {
    mockTasksAPI([
      {
        id: "task-email",
        type: "email",
        title: "Email task",
        agent: createAgent(),
        latestRunId: "run-email-1",
        status: "running",
        emailThreadSessionId: "email-session-1",
        createdAt: "2026-04-10T10:00:00Z",
        updatedAt: "2026-04-10T10:00:00Z",
      },
    ]);

    const user = userEvent.setup();

    detachedSetupPage({ context, path: "/_/mission-control" });

    const title = await waitFor(() => {
      return screen.getByText("Email task");
    });

    await user.click(title);

    await waitFor(() => {
      expect(pathname()).toBe("/activities/run-email-1");
    });
  });

  it("should navigate to activity when clicking a slack task", async () => {
    mockTasksAPI([
      {
        id: "task-slack",
        type: "slack",
        title: "Slack task",
        agent: createAgent(),
        latestRunId: "run-slack-1",
        status: "running",
        slackThreadSessionId: "slack-session-1",
        createdAt: "2026-04-10T10:00:00Z",
        updatedAt: "2026-04-10T10:00:00Z",
      },
    ]);

    const user = userEvent.setup();

    detachedSetupPage({ context, path: "/_/mission-control" });

    const title = await waitFor(() => {
      return screen.getByText("Slack task");
    });

    await user.click(title);

    await waitFor(() => {
      expect(pathname()).toBe("/activities/run-slack-1");
    });
  });
});
