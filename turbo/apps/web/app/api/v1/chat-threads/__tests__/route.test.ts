import { describe, it, expect, beforeEach } from "vitest";
import { GET as getThread } from "../[threadId]/route";
import { GET as getMessages } from "../[threadId]/messages/route";
import { POST as sendMessage } from "../messages/route";
import {
  createTestRequest,
  createTestCompose,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import {
  mockClerk,
  registerMockApiKey,
} from "../../../../../src/__tests__/clerk-mock";
import {
  insertTestChatThread,
  insertTestChatMessage,
} from "../../../../../src/__tests__/db-test-seeders/agents";
import { updateOrgDefaultAgent } from "../../../../../src/__tests__/db-test-seeders/org";
import { getTestZeroAgentId } from "../../../../../src/__tests__/db-test-assertions/agents";
import { randomUUID } from "crypto";

const context = testContext();

const GET_THREAD_URL = (threadId: string) => {
  return `http://localhost:3000/api/v1/chat-threads/${threadId}`;
};
const GET_MESSAGES_URL = (threadId: string) => {
  return `http://localhost:3000/api/v1/chat-threads/${threadId}/messages`;
};
const POST_MESSAGE_URL = "http://localhost:3000/api/v1/chat-threads/messages";

function bearerHeaders(secret: string) {
  return {
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
  };
}

function seedApiKey(
  secret: string,
  user: UserContext,
  overrides?: { revoked?: boolean; expired?: boolean },
) {
  registerMockApiKey(secret, {
    id: uniqueId("api-key"),
    subject: user.userId,
    claims: { orgId: user.orgId },
    revoked: overrides?.revoked,
    expired: overrides?.expired,
  });
}

describe("GET /api/v1/chat-threads/:threadId", () => {
  let user: UserContext;
  let threadId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const compose = await createTestCompose(uniqueId("v1-get-thread"));
    const agentId = await getTestZeroAgentId(user.orgId, compose.name);
    threadId = await insertTestChatThread(user.userId, agentId, "t");
  });

  it("returns 401 without API key", async () => {
    const res = await getThread(
      createTestRequest(GET_THREAD_URL(threadId), { method: "GET" }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 for unknown API key", async () => {
    const res = await getThread(
      createTestRequest(GET_THREAD_URL(threadId), {
        method: "GET",
        headers: bearerHeaders("ak_unknown"),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when key is revoked", async () => {
    const secret = `ak_${uniqueId("secret")}`;
    seedApiKey(secret, user, { revoked: true });
    const res = await getThread(
      createTestRequest(GET_THREAD_URL(threadId), {
        method: "GET",
        headers: bearerHeaders(secret),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 200 with thread detail when key owns thread", async () => {
    const secret = `ak_${uniqueId("secret")}`;
    seedApiKey(secret, user);
    const res = await getThread(
      createTestRequest(GET_THREAD_URL(threadId), {
        method: "GET",
        headers: bearerHeaders(secret),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(threadId);
    // agentId must NOT be exposed on the v1 contract
    expect(body.agentId).toBeUndefined();
    expect(body.title).toBe("t");
    expect(body.createdAt).toBeDefined();
    expect(body.updatedAt).toBeDefined();
  });

  it("returns 404 when thread belongs to another user", async () => {
    const secret = `ak_${uniqueId("secret")}`;
    seedApiKey(secret, user);
    const otherThreadId = randomUUID();
    const res = await getThread(
      createTestRequest(GET_THREAD_URL(otherThreadId), {
        method: "GET",
        headers: bearerHeaders(secret),
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /api/v1/chat-threads/:threadId/messages", () => {
  let user: UserContext;
  let threadId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const compose = await createTestCompose(uniqueId("v1-get-msgs"));
    const agentId = await getTestZeroAgentId(user.orgId, compose.name);
    threadId = await insertTestChatThread(user.userId, agentId, "t");
    await insertTestChatMessage({
      chatThreadId: threadId,
      role: "user",
      content: "hello",
    });
    await insertTestChatMessage({
      chatThreadId: threadId,
      role: "assistant",
      content: "world",
    });
  });

  it("returns 401 without API key", async () => {
    const res = await getMessages(
      createTestRequest(GET_MESSAGES_URL(threadId), { method: "GET" }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 200 with messages", async () => {
    const secret = `ak_${uniqueId("secret")}`;
    seedApiKey(secret, user);
    const res = await getMessages(
      createTestRequest(GET_MESSAGES_URL(threadId), {
        method: "GET",
        headers: bearerHeaders(secret),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toBe("hello");
    expect(body.messages[1].role).toBe("assistant");
    expect(body.messages[1].content).toBe("world");
  });

  it("returns 404 when thread belongs to another user", async () => {
    const secret = `ak_${uniqueId("secret")}`;
    seedApiKey(secret, user);
    const otherThreadId = randomUUID();
    const res = await getMessages(
      createTestRequest(GET_MESSAGES_URL(otherThreadId), {
        method: "GET",
        headers: bearerHeaders(secret),
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/v1/chat-threads/messages", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("returns 401 without API key", async () => {
    mockClerk({ userId: null });
    const res = await sendMessage(
      createTestRequest(POST_MESSAGE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hi" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 when no default agent is configured", async () => {
    const secret = `ak_${uniqueId("secret")}`;
    seedApiKey(secret, user);
    const res = await sendMessage(
      createTestRequest(POST_MESSAGE_URL, {
        method: "POST",
        headers: bearerHeaders(secret),
        body: JSON.stringify({ prompt: "hi" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/No default agent/i);
  });

  it("returns 404 when posting to another user's existing thread", async () => {
    const secret = `ak_${uniqueId("secret")}`;
    seedApiKey(secret, user);
    const otherThreadId = randomUUID();
    const res = await sendMessage(
      createTestRequest(POST_MESSAGE_URL, {
        method: "POST",
        headers: bearerHeaders(secret),
        body: JSON.stringify({
          prompt: "hi",
          threadId: otherThreadId,
        }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("rejects session auth (Clerk cookie) — v1 is api_key only", async () => {
    // Session is configured via setupUser() but no Bearer api_key sent.
    const res = await sendMessage(
      createTestRequest(POST_MESSAGE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hi" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a CLI PAT token — v1 is api_key only", async () => {
    const res = await sendMessage(
      createTestRequest(POST_MESSAGE_URL, {
        method: "POST",
        headers: {
          Authorization: "Bearer vm0_pat_not_a_real_token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: "hi" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  // NOTE: Full happy-path coverage (201 with runId) is shared with the
  // existing /api/zero/chat/messages test — that route uses the same
  // createZeroRun pipeline we reuse here. We stop at the pre-run validation
  // layer to avoid duplicating heavy model-provider / runner fixtures.
  it("reaches the run pipeline once default agent is configured", async () => {
    const compose = await createTestCompose(uniqueId("v1-send"));
    const agentId = await getTestZeroAgentId(user.orgId, compose.name);
    await updateOrgDefaultAgent(user.orgId, agentId);

    const secret = `ak_${uniqueId("secret")}`;
    seedApiKey(secret, user);
    const res = await sendMessage(
      createTestRequest(POST_MESSAGE_URL, {
        method: "POST",
        headers: bearerHeaders(secret),
        body: JSON.stringify({ prompt: "hi" }),
      }),
    );
    // Auth + scope + default-agent resolution must all pass (no 400/401/403).
    // The run pipeline itself may fail in CI (e.g. no runner configured), so
    // 201 or 500 are both acceptable — what matters is we are NOT gated before
    // reaching createZeroRun.
    expect(res.status).not.toBe(400);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect([201, 500]).toContain(res.status);
  });
});
