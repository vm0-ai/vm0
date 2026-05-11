import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";
import { testContext } from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { findTestZeroRun } from "../../../../../../../src/__tests__/db-test-assertions/runs";
import {
  insertTestVoiceChatSession,
  insertTestVoiceChatTask,
} from "../../../../../../../src/__tests__/db-test-seeders/voice-chat";
import {
  postRequest,
  getRequest,
  paramsFor,
  seedVoiceChatAgent,
  seedVoiceChatSession,
  setupVoiceChatOrg,
} from "../../../__tests__/_helpers";

vi.mock("@vm0/core/feature-switch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@vm0/core/feature-switch")>();
  return {
    ...actual,
    isFeatureEnabled: vi.fn().mockReturnValue(true),
  };
});

const { isFeatureEnabled } = await import("@vm0/core/feature-switch");
const mockIsFeatureEnabled = isFeatureEnabled as ReturnType<typeof vi.fn>;

const { POST, GET } = await import("../route");

const context = testContext();

function taskBody(overrides: Partial<{ prompt: string; callId: string }> = {}) {
  return {
    prompt: "Check Grafana for the latest deploy",
    callId: randomUUID(),
    ...overrides,
  };
}

describe("POST /api/zero/voice-chat/:id/tasks (createTask)", () => {
  let orgId: string;
  let userId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    userId = user.userId;
    const org = await setupVoiceChatOrg(userId);
    orgId = org.orgId;
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });
    const response = await POST(
      postRequest(`/${randomUUID()}/tasks`, taskBody()),
      paramsFor(randomUUID()),
    );
    expect(response.status).toBe(401);
  });

  it("returns 404 when the feature flag is disabled", async () => {
    const { agentId } = await seedVoiceChatAgent(userId, orgId);
    const session = await seedVoiceChatSession({ orgId, userId, agentId });
    mockIsFeatureEnabled.mockReturnValue(false);
    const response = await POST(
      postRequest(`/${session.id}/tasks`, taskBody()),
      paramsFor(session.id),
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 when the session does not exist", async () => {
    const response = await POST(
      postRequest(`/${randomUUID()}/tasks`, taskBody()),
      paramsFor(randomUUID()),
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 when the session belongs to a different user", async () => {
    const other = await context.setupUser({ prefix: "other-user" });
    const otherOrg = await setupVoiceChatOrg(other.userId);
    const { agentId } = await seedVoiceChatAgent(other.userId, otherOrg.orgId);
    const otherSession = await seedVoiceChatSession({
      orgId: otherOrg.orgId,
      userId: other.userId,
      agentId,
    });
    mockClerk({ userId, orgId, orgRole: "org:admin" });
    const response = await POST(
      postRequest(`/${otherSession.id}/tasks`, taskBody()),
      paramsFor(otherSession.id),
    );
    expect(response.status).toBe(404);
  });

  it("returns 400 when prompt is missing", async () => {
    const { agentId } = await seedVoiceChatAgent(userId, orgId);
    const session = await seedVoiceChatSession({ orgId, userId, agentId });
    const response = await POST(
      postRequest(`/${session.id}/tasks`, { callId: randomUUID() }),
      paramsFor(session.id),
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when callId is missing", async () => {
    const { agentId } = await seedVoiceChatAgent(userId, orgId);
    const session = await seedVoiceChatSession({ orgId, userId, agentId });
    const response = await POST(
      postRequest(`/${session.id}/tasks`, { prompt: "do a thing" }),
      paramsFor(session.id),
    );
    expect(response.status).toBe(400);
  });

  it("creates a task and dispatches a zero run with triggerSource=voice-chat", async () => {
    const { agentId } = await seedVoiceChatAgent(userId, orgId);
    const session = await seedVoiceChatSession({ orgId, userId, agentId });
    const callId = randomUUID();
    const response = await POST(
      postRequest(
        `/${session.id}/tasks`,
        taskBody({ prompt: "summarize latest", callId }),
      ),
      paramsFor(session.id),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.task.sessionId).toBe(session.id);
    expect(body.task.callId).toBe(callId);
    expect(body.task.prompt).toBe("summarize latest");
    expect(["pending", "queued"]).toContain(body.task.status);
    expect(body.task.runId).toBeTruthy();

    const zeroRun = await findTestZeroRun(body.task.runId);
    expect(zeroRun?.triggerSource).toBe("voice-chat");
  });
});

describe("GET /api/zero/voice-chat/:id/tasks (listTasksForCard)", () => {
  let orgId: string;
  let userId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    userId = user.userId;
    const org = await setupVoiceChatOrg(userId);
    orgId = org.orgId;
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });
    const response = await GET(
      getRequest(`/${randomUUID()}/tasks`),
      paramsFor(randomUUID()),
    );
    expect(response.status).toBe(401);
  });

  it("returns 401 when authenticated without an active org", async () => {
    mockClerk({ userId, orgId: null });

    const response = await GET(
      getRequest(`/${randomUUID()}/tasks`),
      paramsFor(randomUUID()),
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 404 when the feature flag is disabled", async () => {
    const { agentId } = await seedVoiceChatAgent(userId, orgId);
    const session = await seedVoiceChatSession({ orgId, userId, agentId });
    mockIsFeatureEnabled.mockReturnValue(false);
    const response = await GET(
      getRequest(`/${session.id}/tasks`),
      paramsFor(session.id),
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 when the session belongs to a different user", async () => {
    const other = await context.setupUser({ prefix: "other-user" });
    const otherOrg = await setupVoiceChatOrg(other.userId);
    const { agentId } = await seedVoiceChatAgent(other.userId, otherOrg.orgId);
    const otherSession = await seedVoiceChatSession({
      orgId: otherOrg.orgId,
      userId: other.userId,
      agentId,
    });
    mockClerk({ userId, orgId, orgRole: "org:admin" });
    const response = await GET(
      getRequest(`/${otherSession.id}/tasks`),
      paramsFor(otherSession.id),
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 when the session does not exist", async () => {
    const response = await GET(
      getRequest(`/${randomUUID()}/tasks`),
      paramsFor(randomUUID()),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 when the session belongs to a different org", async () => {
    const { agentId } = await seedVoiceChatAgent(userId, orgId);
    const sessionId = await insertTestVoiceChatSession({
      orgId: `org_other_${randomUUID()}`,
      userId,
      agentId,
    });

    const response = await GET(
      getRequest(`/${sessionId}/tasks`),
      paramsFor(sessionId),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns an empty list when the session has no tasks", async () => {
    const { agentId } = await seedVoiceChatAgent(userId, orgId);
    const session = await seedVoiceChatSession({ orgId, userId, agentId });
    const response = await GET(
      getRequest(`/${session.id}/tasks`),
      paramsFor(session.id),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.tasks).toEqual([]);
  });

  it("returns active tasks before finished tasks", async () => {
    const { agentId } = await seedVoiceChatAgent(userId, orgId);
    const session = await seedVoiceChatSession({ orgId, userId, agentId });
    const doneId = await insertTestVoiceChatTask(session.id, {
      status: "done",
    });
    const pendingId = await insertTestVoiceChatTask(session.id, {
      status: "pending",
    });
    const response = await GET(
      getRequest(`/${session.id}/tasks`),
      paramsFor(session.id),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.tasks).toHaveLength(2);
    // Active task comes first, finished task comes second
    expect(body.tasks[0].id).toBe(pendingId);
    expect(body.tasks[1].id).toBe(doneId);
  });

  it("caps finished tasks at 3 and excludes the oldest one", async () => {
    const { agentId } = await seedVoiceChatAgent(userId, orgId);
    const session = await seedVoiceChatSession({ orgId, userId, agentId });
    const now = Date.now();
    // Insert 4 finished tasks with distinct finishedAt timestamps; the oldest
    // should be excluded from the card feed (limit=3)
    const oldestDoneId = await insertTestVoiceChatTask(session.id, {
      status: "done",
      finishedAt: new Date(now - 400_000),
    });
    await insertTestVoiceChatTask(session.id, {
      status: "done",
      finishedAt: new Date(now - 300_000),
    });
    await insertTestVoiceChatTask(session.id, {
      status: "done",
      finishedAt: new Date(now - 200_000),
    });
    await insertTestVoiceChatTask(session.id, {
      status: "done",
      finishedAt: new Date(now - 100_000),
    });
    const response = await GET(
      getRequest(`/${session.id}/tasks`),
      paramsFor(session.id),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.tasks).toHaveLength(3);
    const returnedIds = body.tasks.map((t: { id: string }) => {
      return t.id;
    });
    expect(returnedIds).not.toContain(oldestDoneId);
  });
});
