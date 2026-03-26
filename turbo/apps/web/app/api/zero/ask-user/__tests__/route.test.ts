import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../question/route";
import { GET } from "../answer/route";
import {
  createTestRequest,
  createTestCompose,
  createTestRunInDb,
  createTestSlackOrgInstallation,
  createTestSlackOrgConnection,
  createTestCallback,
  insertOrgMembersCacheEntry,
  findTestPendingQuestion,
  updateTestPendingQuestionAnswer,
  updateTestPendingQuestionExpiry,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { generateZeroToken } from "../../../../../src/lib/auth/sandbox-token";

const QUESTION_URL = "http://localhost:3000/api/zero/ask-user/question";
const ANSWER_URL = "http://localhost:3000/api/zero/ask-user/answer";

const context = testContext();

const sampleQuestions = [
  {
    question: "What color do you prefer?",
    options: [{ label: "Red" }, { label: "Blue" }],
  },
];

/**
 * Set up a complete Slack context: installation, connection, compose, run,
 * callback with Slack payload, and a zero token for authentication.
 */
async function setupSlackContext(user: UserContext) {
  const { slackWorkspaceId } = await createTestSlackOrgInstallation({
    orgId: user.orgId,
  });
  const { connectionId } = await createTestSlackOrgConnection({
    slackWorkspaceId,
    vm0UserId: user.userId,
  });
  const { composeId } = await createTestCompose(uniqueId("agent"));
  const { runId } = await createTestRunInDb(user.userId, composeId);
  await createTestCallback({
    runId,
    url: "http://localhost/api/internal/callbacks/slack/org",
    payload: {
      workspaceId: slackWorkspaceId,
      channelId: "C-test-channel",
      threadTs: "1234567890.000001",
      messageTs: "1234567890.000002",
      connectionId,
      agentId: composeId,
    },
  });

  await insertOrgMembersCacheEntry({
    orgId: user.orgId,
    userId: user.userId,
    role: "admin",
  });
  mockClerk({ userId: null });
  const token = await generateZeroToken(user.userId, runId, user.orgId);

  return { token, runId, composeId, slackWorkspaceId, connectionId };
}

describe("POST /api/zero/ask-user/question", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("returns 401 when no auth token provided", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(QUESTION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questions: sampleQuestions }),
    });

    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it("returns 200 with pendingId and creates DB record", async () => {
    const { token } = await setupSlackContext(user);

    const request = createTestRequest(QUESTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ questions: sampleQuestions }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.pendingId).toBeDefined();
    expect(typeof data.pendingId).toBe("string");

    // Verify DB record was created
    const pending = await findTestPendingQuestion(data.pendingId);
    expect(pending).toBeDefined();
    expect(pending!.answer).toBeNull();
    expect(pending!.answeredAt).toBeNull();
  });

  it("returns 400 when no Slack callback exists for the run", async () => {
    // Create a run without a Slack callback
    const { composeId } = await createTestCompose(uniqueId("agent"));
    const { runId } = await createTestRunInDb(user.userId, composeId);

    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
      role: "admin",
    });
    mockClerk({ userId: null });
    const token = await generateZeroToken(user.userId, runId, user.orgId);

    const request = createTestRequest(QUESTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ questions: sampleQuestions }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error.message).toContain("No Slack thread found");
  });
});

describe("GET /api/zero/ask-user/answer", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("returns 401 when no auth token provided", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      `${ANSWER_URL}?pendingId=00000000-0000-0000-0000-000000000000`,
      { method: "GET" },
    );

    const response = await GET(request);
    expect(response.status).toBe(401);
  });

  it("returns 404 for non-existent pendingId", async () => {
    const { token } = await setupSlackContext(user);

    const request = createTestRequest(
      `${ANSWER_URL}?pendingId=00000000-0000-0000-0000-000000000000`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    const response = await GET(request);
    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data.error.message).toContain("Pending question not found");
  });

  it("returns pending status when question not yet answered", async () => {
    const { token } = await setupSlackContext(user);

    // First create a pending question via POST
    const postRequest = createTestRequest(QUESTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ questions: sampleQuestions }),
    });
    const postResponse = await POST(postRequest);
    const { pendingId } = await postResponse.json();

    // Now poll for answer
    const getRequest = createTestRequest(
      `${ANSWER_URL}?pendingId=${pendingId}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    const response = await GET(getRequest);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.status).toBe("pending");
    expect(data.answer).toBeUndefined();
  });

  it("returns answered status when question has been answered", async () => {
    const { token } = await setupSlackContext(user);

    // Create a pending question
    const postRequest = createTestRequest(QUESTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ questions: sampleQuestions }),
    });
    const postResponse = await POST(postRequest);
    const { pendingId } = await postResponse.json();

    // Simulate user answering the question
    await updateTestPendingQuestionAnswer(pendingId, "Red");

    // Poll for answer
    const getRequest = createTestRequest(
      `${ANSWER_URL}?pendingId=${pendingId}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    const response = await GET(getRequest);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.status).toBe("answered");
    expect(data.answer).toBe("Red");
  });

  it("returns expired status when question has expired", async () => {
    const { token } = await setupSlackContext(user);

    // Create a pending question
    const postRequest = createTestRequest(QUESTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ questions: sampleQuestions }),
    });
    const postResponse = await POST(postRequest);
    const { pendingId } = await postResponse.json();

    // Set expiresAt to the past
    await updateTestPendingQuestionExpiry(
      pendingId,
      new Date(Date.now() - 1000),
    );

    // Poll for answer
    const getRequest = createTestRequest(
      `${ANSWER_URL}?pendingId=${pendingId}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    const response = await GET(getRequest);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.status).toBe("expired");
  });

  it("returns 404 when pendingId belongs to a different run", async () => {
    const ctx = await setupSlackContext(user);

    // Create a pending question with the first token
    const postRequest = createTestRequest(QUESTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.token}`,
      },
      body: JSON.stringify({ questions: sampleQuestions }),
    });
    const postResponse = await POST(postRequest);
    const { pendingId } = await postResponse.json();

    // Create a second run under the same compose (reuse existing installation)
    const { runId: runId2 } = await createTestRunInDb(
      user.userId,
      ctx.composeId,
    );
    await createTestCallback({
      runId: runId2,
      url: "http://localhost/api/internal/callbacks/slack/org",
      payload: {
        workspaceId: ctx.slackWorkspaceId,
        channelId: "C-test-channel",
        threadTs: "1234567890.000003",
        messageTs: "1234567890.000004",
        connectionId: ctx.connectionId,
        agentId: ctx.composeId,
      },
    });
    const token2 = await generateZeroToken(user.userId, runId2, user.orgId);

    // Try to access the pending question with the second token (different runId)
    const getRequest = createTestRequest(
      `${ANSWER_URL}?pendingId=${pendingId}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token2}` },
      },
    );

    const response = await GET(getRequest);
    expect(response.status).toBe(404);
  });
});
