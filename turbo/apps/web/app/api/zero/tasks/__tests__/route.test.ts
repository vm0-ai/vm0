import { describe, it, expect, beforeEach } from "vitest";
import { GET, POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRunInDb,
  addTestRunToThread,
  insertTestChatThread,
  getTestAgentComposeName,
  createTestSchedule,
  updateTestScheduleState,
  insertTestVoiceChatSession,
} from "../../../../../src/__tests__/api-test-helpers";
import { createTestZeroAgent } from "../../../../../src/__tests__/db-test-seeders/agents";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("GET /api/zero/tasks", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest("http://localhost:3000/api/zero/tasks");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("should return empty tasks array when no data exists", async () => {
    const request = createTestRequest("http://localhost:3000/api/zero/tasks");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.tasks).toEqual([]);
  });

  it("should return chat thread tasks with agent info and latest run", async () => {
    const { composeId } = await createTestCompose(uniqueId("chat-task"));
    const agentName = await getTestAgentComposeName(composeId);
    await createTestZeroAgent(user.orgId, agentName, {
      displayName: "My Agent",
    });

    // Create a chat thread
    const threadId = await insertTestChatThread(
      user.userId,
      composeId,
      "Test Chat",
    );

    // Create a run and link it to the thread
    const { runId } = await createTestRunInDb(user.userId, composeId, {
      status: "completed",
    });
    await addTestRunToThread(threadId, runId, user.userId);

    const request = createTestRequest("http://localhost:3000/api/zero/tasks");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.tasks).toHaveLength(1);

    const task = data.tasks[0];
    expect(task.type).toBe("chat");
    expect(task.title).toBe("Test Chat");
    expect(task.chatThreadId).toBe(threadId);
    expect(task.agent.id).toBe(composeId);
    expect(task.agent.displayName).toBe("My Agent");
    expect(task.latestRunId).toBe(runId);
    expect(task.status).toBe("completed");
  });

  it("should return schedule tasks with latest run", async () => {
    const { composeId } = await createTestCompose(uniqueId("sched-task"));

    const schedule = await createTestSchedule(composeId, "daily-check", {
      cronExpression: "0 0 * * *",
      prompt: "Run daily check",
    });

    // Link a run to the schedule so it becomes actionable
    const { runId } = await createTestRunInDb(user.userId, composeId, {
      status: "completed",
    });
    await updateTestScheduleState(schedule.id, { lastRunId: runId });

    const request = createTestRequest("http://localhost:3000/api/zero/tasks");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    const schedTask = data.tasks.find((t: Record<string, unknown>) => {
      return t.type === "schedule";
    });
    expect(schedTask).toBeDefined();
    expect(schedTask.title).toBe("daily-check");
    expect(schedTask.scheduleId).toBe(schedule.id);
    expect(schedTask.latestRunId).toBe(runId);
    expect(schedTask.status).toBe("completed");
  });

  it("should not return schedule tasks without a lastRunId", async () => {
    const { composeId } = await createTestCompose(
      uniqueId("sched-no-run-test"),
    );

    // Create a schedule without linking any run (lastRunId remains null)
    await createTestSchedule(composeId, "never-run-schedule", {
      cronExpression: "0 0 * * *",
      prompt: "This schedule has never run",
    });

    const request = createTestRequest("http://localhost:3000/api/zero/tasks");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    const scheduleTasks = data.tasks.filter((t: Record<string, unknown>) => {
      return t.type === "schedule";
    });
    expect(scheduleTasks).toHaveLength(0);
  });

  it("should return voice chat tasks that have a runId", async () => {
    const { composeId } = await createTestCompose(uniqueId("voice-chat-task"));

    // Create a run so the voice chat session is actionable
    const { runId } = await createTestRunInDb(user.userId, composeId, {
      status: "completed",
    });

    await insertTestVoiceChatSession({
      orgId: user.orgId,
      userId: user.userId,
      agentId: composeId,
      runId,
    });

    const request = createTestRequest("http://localhost:3000/api/zero/tasks");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    const voiceTasks = data.tasks.filter((t: Record<string, unknown>) => {
      return t.type === "voice_chat";
    });
    expect(voiceTasks).toHaveLength(1);
    expect(voiceTasks[0].latestRunId).toBe(runId);
  });

  it("should not return voice chat tasks without a runId", async () => {
    const { composeId } = await createTestCompose(
      uniqueId("voice-chat-no-run"),
    );

    // Create a voice chat session without linking any run (runId remains null)
    await insertTestVoiceChatSession({
      orgId: user.orgId,
      userId: user.userId,
      agentId: composeId,
    });

    const request = createTestRequest("http://localhost:3000/api/zero/tasks");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    const voiceTasks = data.tasks.filter((t: Record<string, unknown>) => {
      return t.type === "voice_chat";
    });
    expect(voiceTasks).toHaveLength(0);
  });

  it("should filter by agentId", async () => {
    const { composeId: agent1 } = await createTestCompose(uniqueId("agent-1"));
    const { composeId: agent2 } = await createTestCompose(uniqueId("agent-2"));

    const thread1 = await insertTestChatThread(
      user.userId,
      agent1,
      "Agent 1 Thread",
    );
    const { runId: run1 } = await createTestRunInDb(user.userId, agent1, {
      status: "completed",
    });
    await addTestRunToThread(thread1, run1, user.userId);

    const thread2 = await insertTestChatThread(
      user.userId,
      agent2,
      "Agent 2 Thread",
    );
    const { runId: run2 } = await createTestRunInDb(user.userId, agent2, {
      status: "completed",
    });
    await addTestRunToThread(thread2, run2, user.userId);

    // Filter by agent1
    const request = createTestRequest(
      `http://localhost:3000/api/zero/tasks?agentId=${agent1}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].title).toBe("Agent 1 Thread");
    expect(data.tasks[0].agent.id).toBe(agent1);
  });

  it("should return 401 when no org is selected", async () => {
    mockClerk({ userId: user.userId, orgId: null });

    const request = createTestRequest("http://localhost:3000/api/zero/tasks");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("should not return tasks belonging to another user", async () => {
    const { composeId } = await createTestCompose(uniqueId("user1-agent"));
    const thread1 = await insertTestChatThread(
      user.userId,
      composeId,
      "User1 Thread",
    );
    const { runId: run1 } = await createTestRunInDb(user.userId, composeId, {
      status: "completed",
    });
    await addTestRunToThread(thread1, run1, user.userId);

    const otherUser = await context.setupUser({ prefix: "other-user" });
    const { composeId: otherComposeId } = await createTestCompose(
      uniqueId("user2-agent"),
    );
    const thread2 = await insertTestChatThread(
      otherUser.userId,
      otherComposeId,
      "User2 Thread",
    );
    const { runId: run2 } = await createTestRunInDb(
      otherUser.userId,
      otherComposeId,
      { status: "completed" },
    );
    await addTestRunToThread(thread2, run2, otherUser.userId);

    mockClerk({ userId: user.userId });

    const request = createTestRequest("http://localhost:3000/api/zero/tasks");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(
      data.tasks.some((t: Record<string, unknown>) => {
        return t.title === "User1 Thread";
      }),
    ).toBe(true);
    expect(
      data.tasks.some((t: Record<string, unknown>) => {
        return t.title === "User2 Thread";
      }),
    ).toBe(false);
  });

  it("should filter schedule tasks by agentId", async () => {
    const { composeId: agent1 } = await createTestCompose(
      uniqueId("sched-filter-1"),
    );
    const { composeId: agent2 } = await createTestCompose(
      uniqueId("sched-filter-2"),
    );

    const sched1 = await createTestSchedule(agent1, "agent1-schedule");
    const sched2 = await createTestSchedule(agent2, "agent2-schedule");

    // Link runs so schedules are actionable
    const { runId: run1 } = await createTestRunInDb(user.userId, agent1, {
      status: "completed",
    });
    await updateTestScheduleState(sched1.id, { lastRunId: run1 });
    const { runId: run2 } = await createTestRunInDb(user.userId, agent2, {
      status: "completed",
    });
    await updateTestScheduleState(sched2.id, { lastRunId: run2 });

    const request = createTestRequest(
      `http://localhost:3000/api/zero/tasks?agentId=${agent1}`,
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    const scheduleTasks = data.tasks.filter((t: Record<string, unknown>) => {
      return t.type === "schedule";
    });
    expect(scheduleTasks).toHaveLength(1);
    expect(scheduleTasks[0].title).toBe("agent1-schedule");
  });

  it("should sort by latest run time DESC and limit to 25", async () => {
    const { composeId } = await createTestCompose(uniqueId("sort-test"));

    // Create 30 chat threads with runs at different times
    const baseTime = new Date("2025-01-01T00:00:00Z").getTime();
    for (let i = 0; i < 30; i++) {
      const threadId = await insertTestChatThread(
        user.userId,
        composeId,
        `Thread ${i}`,
      );

      const { runId } = await createTestRunInDb(user.userId, composeId, {
        status: "completed",
        createdAt: new Date(baseTime + i * 60_000),
      });
      await addTestRunToThread(threadId, runId, user.userId);
    }

    const request = createTestRequest("http://localhost:3000/api/zero/tasks");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.tasks).toHaveLength(25);
    // Most recent should be first (Thread 29)
    expect(data.tasks[0].title).toBe("Thread 29");
    // Least recent in the 25 should be Thread 5
    expect(data.tasks[24].title).toBe("Thread 5");
  });

  it("should sort active tasks before terminal tasks even when terminal task is newer", async () => {
    const { composeId } = await createTestCompose(uniqueId("tier-sort-test"));
    const now = new Date("2025-06-01T00:00:00Z").getTime();

    // Terminal task with a more recent timestamp (createdAt = now)
    const terminalThreadId = await insertTestChatThread(
      user.userId,
      composeId,
      "Terminal Task",
    );
    const { runId: terminalRunId } = await createTestRunInDb(
      user.userId,
      composeId,
      { status: "completed", createdAt: new Date(now) },
    );
    await addTestRunToThread(terminalThreadId, terminalRunId, user.userId);

    // Active task with an older timestamp (createdAt = 1 minute ago)
    const activeThreadId = await insertTestChatThread(
      user.userId,
      composeId,
      "Active Task",
    );
    const { runId: activeRunId } = await createTestRunInDb(
      user.userId,
      composeId,
      { status: "running", createdAt: new Date(now - 60_000) },
    );
    await addTestRunToThread(activeThreadId, activeRunId, user.userId);

    const request = createTestRequest("http://localhost:3000/api/zero/tasks");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    const titles = data.tasks.map((t: Record<string, unknown>) => {
      return t.title;
    });
    expect(titles.indexOf("Active Task")).toBeLessThan(
      titles.indexOf("Terminal Task"),
    );
  });

  it("should treat null-status tasks (no run) as active tier, appearing before terminal tasks", async () => {
    const { composeId } = await createTestCompose(uniqueId("null-status-test"));
    const now = new Date("2025-06-01T00:00:00Z").getTime();

    // Terminal task with a very recent timestamp
    const terminalThreadId = await insertTestChatThread(
      user.userId,
      composeId,
      "Terminal Task",
    );
    const { runId: terminalRunId } = await createTestRunInDb(
      user.userId,
      composeId,
      { status: "completed", createdAt: new Date(now) },
    );
    await addTestRunToThread(terminalThreadId, terminalRunId, user.userId);

    // Chat thread with no run (status = null) — chat tasks are allowed without runs
    await insertTestChatThread(user.userId, composeId, "No Run Chat");

    const request = createTestRequest("http://localhost:3000/api/zero/tasks");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    const noRunTasks = data.tasks.filter((t: Record<string, unknown>) => {
      return t.title === "No Run Chat";
    });
    const terminalTasks = data.tasks.filter((t: Record<string, unknown>) => {
      return t.title === "Terminal Task";
    });
    expect(noRunTasks).toHaveLength(1);
    expect(terminalTasks).toHaveLength(1);
    expect(data.tasks.indexOf(noRunTasks[0])).toBeLessThan(
      data.tasks.indexOf(terminalTasks[0]),
    );
  });

  it("should preserve temporal order within each tier", async () => {
    const { composeId } = await createTestCompose(
      uniqueId("within-tier-sort-test"),
    );
    const now = new Date("2025-06-01T00:00:00Z").getTime();

    // Two running tasks at different times
    const runnerNewThreadId = await insertTestChatThread(
      user.userId,
      composeId,
      "Runner New",
    );
    const { runId: runnerNewRunId } = await createTestRunInDb(
      user.userId,
      composeId,
      { status: "running", createdAt: new Date(now) },
    );
    await addTestRunToThread(runnerNewThreadId, runnerNewRunId, user.userId);

    const runnerOldThreadId = await insertTestChatThread(
      user.userId,
      composeId,
      "Runner Old",
    );
    const { runId: runnerOldRunId } = await createTestRunInDb(
      user.userId,
      composeId,
      { status: "running", createdAt: new Date(now - 10 * 60_000) },
    );
    await addTestRunToThread(runnerOldThreadId, runnerOldRunId, user.userId);

    // Two completed tasks at different times
    const doneNewThreadId = await insertTestChatThread(
      user.userId,
      composeId,
      "Done New",
    );
    const { runId: doneNewRunId } = await createTestRunInDb(
      user.userId,
      composeId,
      { status: "completed", createdAt: new Date(now - 5 * 60_000) },
    );
    await addTestRunToThread(doneNewThreadId, doneNewRunId, user.userId);

    const doneOldThreadId = await insertTestChatThread(
      user.userId,
      composeId,
      "Done Old",
    );
    const { runId: doneOldRunId } = await createTestRunInDb(
      user.userId,
      composeId,
      { status: "completed", createdAt: new Date(now - 20 * 60_000) },
    );
    await addTestRunToThread(doneOldThreadId, doneOldRunId, user.userId);

    const request = createTestRequest("http://localhost:3000/api/zero/tasks");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    const titles = data.tasks.map((t: Record<string, unknown>) => {
      return t.title;
    });
    const idxRunnerNew = titles.indexOf("Runner New");
    const idxRunnerOld = titles.indexOf("Runner Old");
    const idxDoneNew = titles.indexOf("Done New");
    const idxDoneOld = titles.indexOf("Done Old");

    // Active tier comes before terminal tier
    expect(idxRunnerNew).toBeLessThan(idxDoneNew);
    expect(idxRunnerOld).toBeLessThan(idxDoneNew);

    // Within active tier: newer first
    expect(idxRunnerNew).toBeLessThan(idxRunnerOld);

    // Within terminal tier: newer first
    expect(idxDoneNew).toBeLessThan(idxDoneOld);
  });
});

describe("POST /api/zero/tasks/archive", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("returns 401 for unauthenticated requests", async () => {
    mockClerk({ userId: null });

    const req = createTestRequest(
      "http://localhost:3000/api/zero/tasks/archive",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: "x", taskType: "chat", runId: null }),
      },
    );
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("archives a chat task and excludes it from the task list", async () => {
    const { composeId } = await createTestCompose(uniqueId("arc-chat"));
    const threadId = await insertTestChatThread(
      user.userId,
      composeId,
      "To Archive",
    );
    const { runId } = await createTestRunInDb(user.userId, composeId, {
      status: "completed",
    });
    await addTestRunToThread(threadId, runId, user.userId);

    // Confirm it appears before archiving
    const listRes = await GET(
      createTestRequest("http://localhost:3000/api/zero/tasks"),
    );
    const listData = (await listRes.json()) as { tasks: Array<{ id: string }> };
    expect(
      listData.tasks.some((t) => {
        return t.id === threadId;
      }),
    ).toBe(true);

    // Archive it
    const archiveReq = createTestRequest(
      "http://localhost:3000/api/zero/tasks/archive",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: threadId, taskType: "chat", runId }),
      },
    );
    const archiveRes = await POST(archiveReq);
    expect(archiveRes.status).toBe(200);

    // Now it should be excluded
    const listRes2 = await GET(
      createTestRequest("http://localhost:3000/api/zero/tasks"),
    );
    const listData2 = (await listRes2.json()) as {
      tasks: Array<{ id: string }>;
    };
    expect(
      listData2.tasks.some((t) => {
        return t.id === threadId;
      }),
    ).toBe(false);
  });

  it("archive is idempotent (double-archive returns 200 and keeps task hidden)", async () => {
    const { composeId } = await createTestCompose(uniqueId("arc-idem"));
    const threadId = await insertTestChatThread(
      user.userId,
      composeId,
      "Idempotent",
    );
    const { runId } = await createTestRunInDb(user.userId, composeId, {
      status: "completed",
    });
    await addTestRunToThread(threadId, runId, user.userId);

    const archiveReq = () => {
      return createTestRequest("http://localhost:3000/api/zero/tasks/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: threadId, taskType: "chat", runId }),
      });
    };

    const res1 = await POST(archiveReq());
    expect(res1.status).toBe(200);

    const res2 = await POST(archiveReq());
    expect(res2.status).toBe(200);

    const listRes = await GET(
      createTestRequest("http://localhost:3000/api/zero/tasks"),
    );
    const listData = (await listRes.json()) as { tasks: Array<{ id: string }> };
    expect(
      listData.tasks.some((t) => {
        return t.id === threadId;
      }),
    ).toBe(false);
  });

  it("archived task reappears when a new run arrives", async () => {
    const { composeId } = await createTestCompose(uniqueId("arc-restore"));
    const threadId = await insertTestChatThread(
      user.userId,
      composeId,
      "Restore Me",
    );
    const { runId } = await createTestRunInDb(user.userId, composeId, {
      status: "completed",
    });
    await addTestRunToThread(threadId, runId, user.userId);

    // Archive with current runId
    await POST(
      createTestRequest("http://localhost:3000/api/zero/tasks/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: threadId, taskType: "chat", runId }),
      }),
    );

    // Add a new run (simulates new activity)
    const { runId: newRunId } = await createTestRunInDb(
      user.userId,
      composeId,
      {
        status: "running",
      },
    );
    await addTestRunToThread(threadId, newRunId, user.userId);

    // Task should reappear because latestRunId changed
    const listRes = await GET(
      createTestRequest("http://localhost:3000/api/zero/tasks"),
    );
    const listData = (await listRes.json()) as { tasks: Array<{ id: string }> };
    expect(
      listData.tasks.some((t) => {
        return t.id === threadId;
      }),
    ).toBe(true);
  });

  it("archives a schedule task and excludes it from the task list", async () => {
    const { composeId } = await createTestCompose(uniqueId("arc-sched"));
    const schedule = await createTestSchedule(composeId, "Scheduled Task");

    // Link a run so the schedule is actionable
    const { runId } = await createTestRunInDb(user.userId, composeId, {
      status: "completed",
    });
    await updateTestScheduleState(schedule.id, { lastRunId: runId });

    // Confirm it appears before archiving
    const listRes = await GET(
      createTestRequest("http://localhost:3000/api/zero/tasks"),
    );
    const listData = (await listRes.json()) as { tasks: Array<{ id: string }> };
    expect(
      listData.tasks.some((t) => {
        return t.id === schedule.id;
      }),
    ).toBe(true);

    // Archive with the runId
    const archiveRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/tasks/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: schedule.id,
          taskType: "schedule",
          runId,
        }),
      }),
    );
    expect(archiveRes.status).toBe(200);

    // Now it should be excluded
    const listRes2 = await GET(
      createTestRequest("http://localhost:3000/api/zero/tasks"),
    );
    const listData2 = (await listRes2.json()) as {
      tasks: Array<{ id: string }>;
    };
    expect(
      listData2.tasks.some((t) => {
        return t.id === schedule.id;
      }),
    ).toBe(false);
  });
});

describe("POST /api/zero/tasks/unarchive", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("returns 401 for unauthenticated requests", async () => {
    mockClerk({ userId: null });

    const req = createTestRequest(
      "http://localhost:3000/api/zero/tasks/unarchive",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: "x", taskType: "chat" }),
      },
    );
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("unarchiving a task restores it to the task list", async () => {
    const { composeId } = await createTestCompose(uniqueId("unarc"));
    const threadId = await insertTestChatThread(
      user.userId,
      composeId,
      "Unarchive Me",
    );
    const { runId } = await createTestRunInDb(user.userId, composeId, {
      status: "completed",
    });
    await addTestRunToThread(threadId, runId, user.userId);

    // Archive first
    await POST(
      createTestRequest("http://localhost:3000/api/zero/tasks/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: threadId, taskType: "chat", runId }),
      }),
    );

    // Verify hidden
    const listRes = await GET(
      createTestRequest("http://localhost:3000/api/zero/tasks"),
    );
    const listData = (await listRes.json()) as { tasks: Array<{ id: string }> };
    expect(
      listData.tasks.some((t) => {
        return t.id === threadId;
      }),
    ).toBe(false);

    // Unarchive
    const unarchiveRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/tasks/unarchive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: threadId, taskType: "chat" }),
      }),
    );
    expect(unarchiveRes.status).toBe(200);

    // Should reappear
    const listRes2 = await GET(
      createTestRequest("http://localhost:3000/api/zero/tasks"),
    );
    const listData2 = (await listRes2.json()) as {
      tasks: Array<{ id: string }>;
    };
    expect(
      listData2.tasks.some((t) => {
        return t.id === threadId;
      }),
    ).toBe(true);
  });
});
