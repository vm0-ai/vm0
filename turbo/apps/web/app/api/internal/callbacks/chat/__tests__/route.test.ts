import { describe, it, expect, beforeEach, vi } from "vitest";
import { HttpResponse } from "msw";
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
  createTestPushSubscription,
  getPushSubscriptionsByEndpoint,
} from "../../../../../../src/__tests__/api-test-helpers";
import { computeHmacSignature } from "../../../../../../src/lib/infra/callback/hmac";
import { reloadEnv } from "../../../../../../src/env";
import { getSessionChatMessages } from "../../../../../../src/lib/zero/zero-session-service";
import { POST as createThreadHandler } from "../../../../zero/chat-threads/route";
import { POST } from "../route";
import { http } from "../../../../../../src/__tests__/msw";
import { server } from "../../../../../../src/mocks/server";
import webpush, { WebPushError } from "web-push";

vi.mock("web-push", async (importActual) => {
  const actual = await importActual<{ WebPushError: typeof WebPushError }>();
  return {
    ...actual,
    default: {
      sendNotification: vi.fn(),
      setVapidDetails: vi.fn(),
    },
    sendNotification: vi.fn(),
    setVapidDetails: vi.fn(),
  };
});

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

  /** Create a thread via route handler, then a run, session, and callback in DB. */
  async function setupRunAndThread(
    options: { status?: "completed" | "failed" } = {},
  ) {
    const { status = "completed" } = options;

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
      status,
    });

    // Create an agent session so findNewSessionId() returns a session
    const session = await createTestAgentSession(user.userId, agentId);

    // Create a callback record
    const { secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/chat",
      payload: { threadId, agentId },
    });

    return { threadId, runId, secret, sessionId: session.id };
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

  /** Get thread title via the API. */
  async function getThreadTitle(threadId: string): Promise<string | null> {
    const { GET } = await import("../../../../zero/chat-threads/[id]/route");
    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}`,
        { method: "GET" },
      ),
    );
    const data = await response.json();
    return data.title ?? null;
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

  it("should update sessionId on completion when a matching session exists", async () => {
    const { threadId, runId, secret, sessionId } = await setupRunAndThread();

    // Mock Axiom to return empty (no result events)
    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([]);

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
    const threadSessionId = await getThreadSessionId(threadId);
    expect(threadSessionId).toBe(sessionId);
  });

  it("should be idempotent - calling twice does not break", async () => {
    const { threadId, runId, secret } = await setupRunAndThread();

    // Mock Axiom for both calls
    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([]);
    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([]);

    const makeRequest = () => {
      return createCallbackRequest(
        {
          runId,
          status: "completed",
          payload: { threadId, agentId },
        },
        secret,
      );
    };

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

  describe("Chat Persistence", () => {
    it("should persist user + assistant messages with summaries on completion", async () => {
      const { threadId, runId, secret, sessionId } = await setupRunAndThread();

      // Mock Axiom to return assistant events + result event
      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
        {
          eventType: "assistant",
          eventData: {
            message: {
              content: [{ type: "tool_use", name: "Bash" }],
            },
          },
        },
        {
          eventType: "assistant",
          eventData: {
            message: {
              content: [{ type: "tool_use", name: "Read" }],
            },
          },
        },
        {
          eventType: "assistant",
          eventData: {
            message: {
              content: [{ type: "text", text: "Done. Created 3 files." }],
            },
          },
        },
        {
          eventType: "result",
          eventData: { result: "Done. Created 3 files." },
        },
      ]);

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

      // Verify session now has chat messages
      type StoredMessage = {
        role: string;
        content: string;
        runId?: string;
        summaries?: Array<
          { kind: "tool"; name: string } | { kind: "text"; text: string }
        >;
      };
      const chatMessages = (await getSessionChatMessages(
        sessionId,
      )) as StoredMessage[];
      expect(chatMessages).toHaveLength(2);

      // Verify user message from prompt
      const userMsg = chatMessages.find((m) => {
        return m.role === "user";
      });
      expect(userMsg).toBeDefined();
      expect(userMsg!.content).toBe("test prompt");

      // Verify assistant message from Axiom result
      const assistantMsg = chatMessages.find((m) => {
        return m.role === "assistant";
      });
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.content).toBe("Done. Created 3 files.");
      expect(assistantMsg!.runId).toBe(runId);
      // Last text event is skipped — only tool_use entries are extracted
      expect(assistantMsg!.summaries).toEqual([
        { kind: "tool", name: "Bash" },
        { kind: "tool", name: "Read" },
      ]);
    });

    it("should persist only user message when no result found in Axiom", async () => {
      const { threadId, runId, secret, sessionId } = await setupRunAndThread();

      // Axiom returns no events
      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([]);

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

      // Verify session has only user message
      type StoredMessage = { role: string; content: string };
      const chatMessages = (await getSessionChatMessages(
        sessionId,
      )) as StoredMessage[];
      expect(chatMessages).toHaveLength(1);
      expect(chatMessages[0]!.role).toBe("user");
      expect(chatMessages[0]!.content).toBe("test prompt");
    });

    it("should not include summaries when Axiom returns no assistant events", async () => {
      const { threadId, runId, secret, sessionId } = await setupRunAndThread();

      // Combined Axiom query returns result event only (no assistant events)
      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
        {
          eventType: "result",
          eventData: { result: "All good." },
        },
      ]);

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

      type StoredMessage = {
        role: string;
        content: string;
        summaries?: string[];
      };
      const chatMessages = (await getSessionChatMessages(
        sessionId,
      )) as StoredMessage[];

      const assistantMsg = chatMessages.find((m) => {
        return m.role === "assistant";
      });
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.content).toBe("All good.");
      // summaries should be undefined (not included when empty)
      expect(assistantMsg!.summaries).toBeUndefined();
    });

    it("should truncate text summaries exceeding 80 characters", async () => {
      const { threadId, runId, secret, sessionId } = await setupRunAndThread();

      const longText = "x".repeat(100);

      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
        {
          eventType: "assistant",
          eventData: {
            message: {
              content: [{ type: "text", text: longText }],
            },
          },
        },
        {
          eventType: "assistant",
          eventData: {
            message: {
              content: [{ type: "text", text: "Done." }],
            },
          },
        },
        {
          eventType: "result",
          eventData: { result: "Done." },
        },
      ]);

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

      type StoredMessage = {
        role: string;
        summaries?: Array<
          { kind: "tool"; name: string } | { kind: "text"; text: string }
        >;
      };
      const chatMessages = (await getSessionChatMessages(
        sessionId,
      )) as StoredMessage[];

      const assistantMsg = chatMessages.find((m) => {
        return m.role === "assistant";
      });
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.summaries).toHaveLength(1);
      const entry = assistantMsg!.summaries![0] as {
        kind: "text";
        text: string;
      };
      expect(entry.kind).toBe("text");
      expect(entry.text.length).toBe(81); // 80 chars + "…"
      expect(entry.text.endsWith("\u2026")).toBe(true);
    });

    it("should persist user + error messages on failed run", async () => {
      const { threadId, runId, secret, sessionId } = await setupRunAndThread({
        status: "failed",
      });

      const response = await POST(
        createCallbackRequest(
          {
            runId,
            status: "failed",
            error: "Agent crashed",
            payload: { threadId, agentId },
          },
          secret,
        ),
      );

      expect(response.status).toBe(200);

      type StoredMessage = {
        role: string;
        content: string;
        runId?: string;
      };
      const chatMessages = (await getSessionChatMessages(
        sessionId,
      )) as StoredMessage[];
      expect(chatMessages).toHaveLength(2);

      const userMsg = chatMessages.find((m) => {
        return m.role === "user";
      });
      expect(userMsg).toBeDefined();
      expect(userMsg!.content).toBe("test prompt");

      const assistantMsg = chatMessages.find((m) => {
        return m.role === "assistant";
      });
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.content).toBe("Agent crashed");
      expect(assistantMsg!.runId).toBe(runId);
    });

    it("should update sessionId on failed run", async () => {
      const { threadId, runId, secret, sessionId } = await setupRunAndThread({
        status: "failed",
      });

      const response = await POST(
        createCallbackRequest(
          {
            runId,
            status: "failed",
            error: "Agent crashed",
            payload: { threadId, agentId },
          },
          secret,
        ),
      );

      expect(response.status).toBe(200);

      const threadSessionId = await getThreadSessionId(threadId);
      expect(threadSessionId).toBe(sessionId);
    });
  });

  describe("Title Generation", () => {
    function mockOpenRouter(title: string) {
      const { handler, mocked } = http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        () => {
          return HttpResponse.json({
            choices: [{ message: { content: title } }],
          });
        },
      );
      server.use(handler);
      return mocked;
    }

    function mockOpenRouterError(status: number) {
      const { handler, mocked } = http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        () => {
          return new HttpResponse("Internal Server Error", { status });
        },
      );
      server.use(handler);
      return mocked;
    }

    it("should generate and set chat thread title on completion", async () => {
      const { threadId, runId, secret } = await setupRunAndThread();

      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
        {
          eventType: "result",
          eventData: { result: "Use --inspect flag for debugging." },
        },
      ]);

      vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
      reloadEnv();
      const openRouterMock = mockOpenRouter("Debugging Node.js Apps");

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
      expect(openRouterMock).toHaveBeenCalled();

      const title = await getThreadTitle(threadId);
      expect(title).toBe("Debugging Node.js Apps");
    });

    it("should not generate title on failed run", async () => {
      const { threadId, runId, secret } = await setupRunAndThread({
        status: "failed",
      });

      vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
      reloadEnv();
      const openRouterMock = mockOpenRouter("Should not be called");

      const response = await POST(
        createCallbackRequest(
          {
            runId,
            status: "failed",
            error: "Agent crashed",
            payload: { threadId, agentId },
          },
          secret,
        ),
      );

      expect(response.status).toBe(200);
      expect(openRouterMock).not.toHaveBeenCalled();
    });

    it("should not fail callback when OpenRouter returns an error", async () => {
      const { threadId, runId, secret } = await setupRunAndThread();

      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
        { eventType: "result", eventData: { result: "Some result" } },
      ]);

      vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
      reloadEnv();
      mockOpenRouterError(500);

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

      // Thread title should remain unchanged (error was caught)
      const title = await getThreadTitle(threadId);
      expect(title).toBe("Test thread");
    });

    it("should skip title generation when OPENROUTER_API_KEY is not set", async () => {
      const { threadId, runId, secret } = await setupRunAndThread();

      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
        { eventType: "result", eventData: { result: "Some result" } },
      ]);

      // Do NOT set OPENROUTER_API_KEY — feature should be a no-op
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

      // Thread title should remain as initial value
      const title = await getThreadTitle(threadId);
      expect(title).toBe("Test thread");
    });
  });

  describe("Push Notifications", () => {
    const mockSendNotification = vi.mocked(webpush.sendNotification);

    function enableVapid() {
      vi.stubEnv("VAPID_PUBLIC_KEY", "test-vapid-public-key");
      vi.stubEnv("VAPID_PRIVATE_KEY", "test-vapid-private-key");
      reloadEnv();
    }

    it("should send push notification on completed run", async () => {
      const { threadId, runId, secret } = await setupRunAndThread();
      await createTestPushSubscription();

      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
        {
          eventType: "result",
          eventData: { result: "Files created successfully." },
        },
      ]);

      enableVapid();

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
      expect(mockSendNotification).toHaveBeenCalledTimes(1);

      // Verify the notification payload
      const payload = JSON.parse(
        mockSendNotification.mock.calls[0]![1] as string,
      );
      expect(payload.title).toBe("test prompt");
      expect(payload.url).toBe(`/chats/${threadId}`);
    });

    it("should send push notification on failed run", async () => {
      const { threadId, runId, secret } = await setupRunAndThread({
        status: "failed",
      });
      await createTestPushSubscription();

      enableVapid();

      const response = await POST(
        createCallbackRequest(
          {
            runId,
            status: "failed",
            error: "Agent crashed",
            payload: { threadId, agentId },
          },
          secret,
        ),
      );

      expect(response.status).toBe(200);
      expect(mockSendNotification).toHaveBeenCalledTimes(1);

      const payload = JSON.parse(
        mockSendNotification.mock.calls[0]![1] as string,
      );
      expect(payload.title).toBe("test prompt");
      expect(payload.body).toContain("Agent crashed");
      expect(payload.url).toBe(`/chats/${threadId}`);
    });

    it("should not send push notification when VAPID keys are not set", async () => {
      const { threadId, runId, secret } = await setupRunAndThread();
      await createTestPushSubscription();

      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([]);

      // VAPID keys not set — push notifications should be a no-op
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
      expect(mockSendNotification).not.toHaveBeenCalled();
    });

    it("should not send push notification when user has no subscriptions", async () => {
      const { threadId, runId, secret } = await setupRunAndThread();
      // No push subscriptions registered

      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([]);

      enableVapid();

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
      expect(mockSendNotification).not.toHaveBeenCalled();
    });

    it("should send to multiple subscriptions", async () => {
      const { threadId, runId, secret } = await setupRunAndThread();
      await createTestPushSubscription();
      await createTestPushSubscription();

      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([]);

      enableVapid();

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
      expect(mockSendNotification).toHaveBeenCalledTimes(2);
    });

    it("should delete stale subscription on 410 Gone response", async () => {
      const { threadId, runId, secret } = await setupRunAndThread();
      const { endpoint } = await createTestPushSubscription();

      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([]);

      enableVapid();

      // Mock sendNotification to throw a 410 Gone WebPushError
      mockSendNotification.mockRejectedValueOnce(
        new WebPushError("Gone", 410, {}, "", endpoint),
      );

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

      // Stale subscription should be removed from the DB
      const remaining = await getPushSubscriptionsByEndpoint(endpoint);
      expect(remaining).toHaveLength(0);
    });
  });
});
