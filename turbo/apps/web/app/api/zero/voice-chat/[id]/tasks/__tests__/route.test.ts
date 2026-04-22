import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";
import {
  createTestRequest,
  createTestOrg,
  createTestCompose,
  insertTestVoiceChatSession,
  getTestVoiceChatEvents,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { insertOrgDefaultModelProvider } from "../../../../../../../src/__tests__/db-test-seeders/org";
import { findTestZeroRun } from "../../../../../../../src/__tests__/db-test-assertions/runs";

vi.mock("@vm0/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vm0/core")>();
  return {
    ...actual,
    isFeatureEnabled: vi.fn().mockReturnValue(true),
  };
});

const { isFeatureEnabled } = await import("@vm0/core");
const mockIsFeatureEnabled = isFeatureEnabled as ReturnType<typeof vi.fn>;

const { POST, GET } = await import("../route");

const context = testContext();

const BASE_URL = "http://localhost:3000/api/zero/voice-chat";

function tasksUrl(sessionId: string): string {
  return `${BASE_URL}/${sessionId}/tasks`;
}

function postTasks(sessionId: string, body: unknown) {
  return POST(
    createTestRequest(tasksUrl(sessionId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: sessionId }) },
  );
}

function getTasks(sessionId: string) {
  return GET(createTestRequest(tasksUrl(sessionId)), {
    params: Promise.resolve({ id: sessionId }),
  });
}

async function setupOrg(userId: string) {
  const slug = uniqueId("zvc-tasks");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  // POST /tasks dispatches a zero run; createZeroRun requires an org-default
  // model provider.
  await insertOrgDefaultModelProvider(
    orgId,
    "anthropic",
    "claude-3-5-sonnet-20241022",
  );
  return { orgId, slug };
}

describe("POST /api/zero/voice-chat/[id]/tasks (createTask)", () => {
  let orgId: string;
  let userId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    userId = user.userId;
    const org = await setupOrg(userId);
    orgId = org.orgId;
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });
    const response = await postTasks(randomUUID(), { prompt: "hi" });
    const body = await response.json();
    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 when the voice-chat feature flag is disabled", async () => {
    mockIsFeatureEnabled.mockReturnValue(false);
    const response = await postTasks(randomUUID(), { prompt: "hi" });
    const body = await response.json();
    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("returns 404 when the session does not exist", async () => {
    const response = await postTasks(randomUUID(), { prompt: "hi" });
    expect(response.status).toBe(404);
  });

  it("returns 404 when the session belongs to a different org", async () => {
    const other = await context.setupUser({ prefix: "other-user" });
    const otherOrg = await setupOrg(other.userId);
    const agent = await createTestCompose(uniqueId("zvc-tasks-agent"));
    const otherSessionId = await insertTestVoiceChatSession({
      orgId: otherOrg.orgId,
      userId: other.userId,
      agentId: agent.composeId,
    });

    mockClerk({ userId, orgId, orgRole: "org:admin" });

    const response = await postTasks(otherSessionId, { prompt: "hi" });
    expect(response.status).toBe(404);
  });

  it("returns 400 when the session has ended", async () => {
    const agent = await createTestCompose(uniqueId("zvc-tasks-agent"));
    const sessionId = await insertTestVoiceChatSession({
      orgId,
      userId,
      agentId: agent.composeId,
      status: "ended",
    });

    const response = await postTasks(sessionId, { prompt: "hi" });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 when the session has no agent", async () => {
    const sessionId = await insertTestVoiceChatSession({ orgId, userId });
    const response = await postTasks(sessionId, { prompt: "hi" });
    expect(response.status).toBe(400);
  });

  it("returns 400 when prompt is missing", async () => {
    const agent = await createTestCompose(uniqueId("zvc-tasks-agent"));
    const sessionId = await insertTestVoiceChatSession({
      orgId,
      userId,
      agentId: agent.composeId,
    });
    const response = await postTasks(sessionId, {});
    expect(response.status).toBe(400);
  });

  it("creates a task, dispatches a voice-chat run, and writes a task-dispatched event", async () => {
    const agent = await createTestCompose(uniqueId("zvc-tasks-agent"));
    const sessionId = await insertTestVoiceChatSession({
      orgId,
      userId,
      agentId: agent.composeId,
    });

    const response = await postTasks(sessionId, { prompt: "summarize this" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.task.sessionId).toBe(sessionId);
    expect(body.task.prompt).toBe("summarize this");
    expect(body.task.status).toBe("queued");
    expect(body.task.runId).toBeTruthy();

    const zeroRun = await findTestZeroRun(body.task.runId);
    expect(zeroRun?.triggerSource).toBe("voice-chat");

    const events = await getTestVoiceChatEvents(sessionId);
    const dispatched = events.find((e) => {
      return e.type === "task-dispatched";
    });
    expect(dispatched).toBeTruthy();
    expect(dispatched!.source).toBe("system");
    expect(dispatched!.content).toBe(
      JSON.stringify({ taskId: body.task.id, prompt: "summarize this" }),
    );
  });
});

describe("GET /api/zero/voice-chat/[id]/tasks (listTasks)", () => {
  let orgId: string;
  let userId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    userId = user.userId;
    const org = await setupOrg(userId);
    orgId = org.orgId;
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });
    const response = await getTasks(randomUUID());
    expect(response.status).toBe(401);
  });

  it("returns 404 when the session does not exist", async () => {
    const response = await getTasks(randomUUID());
    expect(response.status).toBe(404);
  });

  it("returns an empty list for a session with no tasks", async () => {
    const agent = await createTestCompose(uniqueId("zvc-tasks-agent"));
    const sessionId = await insertTestVoiceChatSession({
      orgId,
      userId,
      agentId: agent.composeId,
    });
    const response = await getTasks(sessionId);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tasks).toEqual([]);
  });

  it("lists only tasks scoped to the path session, ordered createdAt ASC", async () => {
    const agent = await createTestCompose(uniqueId("zvc-tasks-agent"));
    const sessionId = await insertTestVoiceChatSession({
      orgId,
      userId,
      agentId: agent.composeId,
    });
    const otherSessionId = await insertTestVoiceChatSession({
      orgId,
      userId,
      agentId: agent.composeId,
    });

    const first = await postTasks(sessionId, { prompt: "first" });
    await new Promise((r) => {
      setTimeout(r, 5);
    });
    const second = await postTasks(sessionId, { prompt: "second" });
    await postTasks(otherSessionId, { prompt: "other" });

    const firstBody = await first.json();
    const secondBody = await second.json();

    const response = await getTasks(sessionId);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tasks).toHaveLength(2);
    expect(body.tasks[0].id).toBe(firstBody.task.id);
    expect(body.tasks[1].id).toBe(secondBody.task.id);
  });
});
