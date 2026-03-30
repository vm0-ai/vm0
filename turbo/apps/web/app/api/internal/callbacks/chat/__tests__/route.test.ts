import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import {
  createTestCompose,
  createTestCallback,
  createTestRunInDb,
  createTestRequest,
  getTestZeroAgentId,
  createTestAgentSession,
} from "../../../../../../src/__tests__/api-test-helpers";
import { computeHmacSignature } from "../../../../../../src/lib/callback/hmac";
import { reloadEnv } from "../../../../../../src/env";
import { POST as createThreadHandler } from "../../../../zero/chat-threads/route";
import { POST } from "../route";

const context = testContext();

interface ChatCallbackBody {
  runId: string;
  status: "completed" | "failed" | "progress";
  error?: string;
  payload: {
    threadId: string;
    agentId: string;
  };
}

function createCallbackRequest(body: ChatCallbackBody, secret: string) {
  const bodyString = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = computeHmacSignature(bodyString, secret, timestamp);

  return createTestRequest("http://localhost/api/internal/callbacks/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-VM0-Signature": signature,
      "X-VM0-Timestamp": timestamp.toString(),
    },
    body: bodyString,
  });
}

describe("POST /api/internal/callbacks/chat", () => {
  let user: UserContext;
  let agentId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const compose = await createTestCompose(uniqueId("chat-cb"));
    agentId = await getTestZeroAgentId(user.orgId, compose.name);
    vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
    reloadEnv();
  });

  /** Create a thread via route handler, then a run and callback in DB. */
  async function setupRunAndThread() {
    // Create a chat thread via the route handler
    const threadResponse = await createThreadHandler(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId,
          title: "Test thread",
        }),
      }),
    );
    const threadData = await threadResponse.json();
    const threadId: string = threadData.id;

    // Create a run in DB
    const { runId } = await createTestRunInDb(user.userId, agentId, {
      status: "completed",
    });

    // Create a callback record
    const { secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/chat",
      payload: { threadId, agentId },
    });

    return { threadId, runId, secret };
  }

  /** Get thread detail and extract latestSessionId. */
  async function getThreadSessionId(threadId: string): Promise<string | null> {
    const { GET } = await import("../../../../zero/chat-threads/[id]/route");
    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}`,
        { method: "GET" },
      ),
    );
    const data = await response.json();
    return data.latestSessionId ?? null;
  }

  it("should return 200 for progress status without updating sessionId", async () => {
    const { threadId, runId, secret } = await setupRunAndThread();

    const response = await POST(
      createCallbackRequest(
        {
          runId,
          status: "progress",
          payload: { threadId, agentId },
        },
        secret,
      ),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);

    // Verify sessionId is still null via thread detail API
    const sessionId = await getThreadSessionId(threadId);
    expect(sessionId).toBeNull();
  });

  it("should return 200 for failed status without updating sessionId", async () => {
    const { threadId, runId, secret } = await setupRunAndThread();

    const response = await POST(
      createCallbackRequest(
        {
          runId,
          status: "failed",
          error: "Something went wrong",
          payload: { threadId, agentId },
        },
        secret,
      ),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);

    // Verify sessionId is still null
    const sessionId = await getThreadSessionId(threadId);
    expect(sessionId).toBeNull();
  });

  it("should update sessionId on completion when a matching session exists", async () => {
    const { threadId, runId, secret } = await setupRunAndThread();

    // Create an agent session that would match findNewSessionId()
    const session = await createTestAgentSession(user.userId, agentId);

    const response = await POST(
      createCallbackRequest(
        {
          runId,
          status: "completed",
          payload: { threadId, agentId },
        },
        secret,
      ),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);

    // Verify sessionId was updated via thread detail API
    const sessionId = await getThreadSessionId(threadId);
    expect(sessionId).toBe(session.id);
  });

  it("should be idempotent - calling twice does not break", async () => {
    const { threadId, runId, secret } = await setupRunAndThread();

    // Create a matching session
    await createTestAgentSession(user.userId, agentId);

    const makeRequest = () =>
      createCallbackRequest(
        {
          runId,
          status: "completed",
          payload: { threadId, agentId },
        },
        secret,
      );

    const response1 = await POST(makeRequest());
    expect(response1.status).toBe(200);

    // Second call should also succeed (thread already has sessionId, so it's a no-op)
    const response2 = await POST(makeRequest());
    expect(response2.status).toBe(200);
  });

  it("should return 400 for invalid payload", async () => {
    const { runId, secret } = await setupRunAndThread();

    const bodyString = JSON.stringify({
      runId,
      status: "completed",
      payload: { invalid: true },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = computeHmacSignature(bodyString, secret, timestamp);

    const response = await POST(
      createTestRequest("http://localhost/api/internal/callbacks/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-VM0-Signature": signature,
          "X-VM0-Timestamp": timestamp.toString(),
        },
        body: bodyString,
      }),
    );

    expect(response.status).toBe(400);
  });
});
