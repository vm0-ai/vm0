import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestZeroAgent,
  createTestAgentSession,
  createTestRunInDb,
  addTestRunToThread,
  insertTestChatThread,
  getTestAgentComposeName,
  createTestSchedule,
  insertTestSlackOrgInstallation,
  insertTestSlackOrgConnection,
  insertTestSlackOrgThreadSession,
  createTestEmailThreadSession,
  generateTestReplyToken,
} from "../../../../../src/__tests__/api-test-helpers";
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
    expect(schedTask.latestRunId).toBeNull();
    expect(schedTask.status).toBeNull();
  });

  it("should return slack thread tasks", async () => {
    const { composeId } = await createTestCompose(uniqueId("slack-task"));

    // Create slack installation + connection
    const slackWorkspaceId = uniqueId("ws");
    await insertTestSlackOrgInstallation({
      slackWorkspaceId,
      slackWorkspaceName: "Test Workspace",
      orgId: user.orgId,
      installedByUserId: user.userId,
    });
    const { id: connectionId } = await insertTestSlackOrgConnection({
      slackUserId: uniqueId("slack-user"),
      slackWorkspaceId,
      vm0UserId: user.userId,
    });

    // Create agent session + slack thread session
    const session = await createTestAgentSession(user.userId, composeId);
    const { id: slackThreadId } = await insertTestSlackOrgThreadSession({
      connectionId,
      agentSessionId: session.id,
    });

    // Create a run linked to the session
    const { runId } = await createTestRunInDb(user.userId, composeId, {
      status: "running",
      continuedFromSessionId: session.id,
      triggerSource: "slack",
    });

    const request = createTestRequest("http://localhost:3000/api/zero/tasks");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    const slackTask = data.tasks.find((t: Record<string, unknown>) => {
      return t.type === "slack";
    });
    expect(slackTask).toBeDefined();
    expect(slackTask.slackThreadSessionId).toBe(slackThreadId);
    expect(slackTask.latestRunId).toBe(runId);
    expect(slackTask.status).toBe("running");
  });

  it("should return email thread tasks", async () => {
    const { composeId } = await createTestCompose(uniqueId("email-task"));

    // Create agent session for email
    const session = await createTestAgentSession(user.userId, composeId);

    // Create email thread session
    const replyToken = generateTestReplyToken(session.id);
    const emailThread = await createTestEmailThreadSession({
      userId: user.userId,
      agentId: composeId,
      agentSessionId: session.id,
      replyToToken: replyToken,
    });

    // Create a run linked to the session
    const { runId } = await createTestRunInDb(user.userId, composeId, {
      status: "completed",
      continuedFromSessionId: session.id,
      triggerSource: "email",
    });

    const request = createTestRequest("http://localhost:3000/api/zero/tasks");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    const emailTask = data.tasks.find((t: Record<string, unknown>) => {
      return t.type === "email";
    });
    expect(emailTask).toBeDefined();
    expect(emailTask.emailThreadSessionId).toBe(emailThread.id);
    expect(emailTask.latestRunId).toBe(runId);
    expect(emailTask.status).toBe("completed");
  });

  it("should filter by agentId", async () => {
    const { composeId: agent1 } = await createTestCompose(uniqueId("agent-1"));
    const { composeId: agent2 } = await createTestCompose(uniqueId("agent-2"));

    await insertTestChatThread(user.userId, agent1, "Agent 1 Thread");
    await insertTestChatThread(user.userId, agent2, "Agent 2 Thread");

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
    await insertTestChatThread(user.userId, composeId, "User1 Thread");

    const otherUser = await context.setupUser({ prefix: "other-user" });
    const { composeId: otherComposeId } = await createTestCompose(
      uniqueId("user2-agent"),
    );
    await insertTestChatThread(
      otherUser.userId,
      otherComposeId,
      "User2 Thread",
    );

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

    await createTestSchedule(agent1, "agent1-schedule");
    await createTestSchedule(agent2, "agent2-schedule");

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
});
