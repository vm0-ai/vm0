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
  createTestRequest,
  createTestAgentSession,
  createTestPushSubscription,
  getPushSubscriptionsByEndpoint,
  createSignedCallbackRequest,
  addTestRunToThread,
  getTestChatMessagesByThread,
} from "../../../../../../src/__tests__/api-test-helpers";
import { getTestZeroAgentId } from "../../../../../../src/__tests__/db-test-assertions/agents";
import { reloadEnv } from "../../../../../../src/env";
import { POST as createThreadHandler } from "../../../../zero/chat-threads/route";
import { POST } from "../route";
import { http } from "../../../../../../src/__tests__/msw";
import { server } from "../../../../../../src/mocks/server";
import webpush, { WebPushError } from "web-push";
import { seedTestRun } from "../../../../../../src/__tests__/db-test-seeders/runs";
import { mockAblyPublish } from "../../../../../../src/__tests__/ably-mock";

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

describe("POST /api/internal/callbacks/chat", () => {
  let user: UserContext;
  let agentId: string;

  beforeEach(async () => {
    mockAblyPublish.mockClear();
    context.setupMocks();
    user = await context.setupUser();
    const compose = await createTestCompose(uniqueId("chat-cb"));
    agentId = await getTestZeroAgentId(user.orgId, compose.name);
    vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
    reloadEnv();
  });

  /** Create a thread via route handler, then a run, session, and callback in DB. */
  async function setupRunAndThread(
    options: {
      status?: "completed" | "failed";
      result?: Record<string, unknown>;
    } = {},
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
    const { runId } = await seedTestRun(user.userId, agentId, {
      status,
      result: options.result,
    });

    // Create an agent session (used for session continuity via run result)
    const session = await createTestAgentSession(user.userId, agentId);

    // Link run to thread by inserting user message and setting zeroRuns.chatThreadId
    await addTestRunToThread(threadId, runId, user.userId);

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
      createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/chat",
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

  it("should derive sessionId from run result when session exists", async () => {
    // Create setup with the run's result containing agentSessionId
    const session = await createTestAgentSession(user.userId, agentId);
    const { threadId, runId, secret } = await setupRunAndThread({
      result: { agentSessionId: session.id },
    });

    // Mock Axiom to return empty (no result events)
    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([]);

    const response = await POST(
      createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/chat",
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

    // latestSessionId is now derived from the run's result.agentSessionId
    const threadSessionId = await getThreadSessionId(threadId);
    expect(threadSessionId).toBe(session.id);
  });

  it("should be idempotent - calling twice does not break", async () => {
    const { threadId, runId, secret } = await setupRunAndThread();

    // Mock Axiom for both calls
    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([]);
    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([]);

    const makeRequest = () => {
      return createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/chat",
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

    const response = await POST(
      createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/chat",
        {
          runId,
          status: "completed",
          payload: { invalid: true },
        },
        secret,
      ),
    );

    expect(response.status).toBe(400);
  });

  describe("Chat Persistence", () => {
    it("should persist user + assistant messages on completion", async () => {
      const { threadId, runId, secret } = await setupRunAndThread();

      // Mock Axiom to return an assistant event with a text block
      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
        {
          sequenceNumber: 0,
          eventData: {
            message: {
              content: [{ type: "text", text: "Done. Created 3 files." }],
            },
          },
        },
      ]);

      const response = await POST(
        createSignedCallbackRequest(
          "http://localhost/api/internal/callbacks/chat",
          {
            runId,
            status: "completed",
            payload: { threadId, agentId },
          },
          secret,
        ),
      );

      expect(response.status).toBe(200);

      // 1 user message + 1 event-backed assistant message.
      const chatMessages = await getTestChatMessagesByThread(threadId);
      expect(chatMessages).toHaveLength(2);

      const userMsg = chatMessages.find((m) => {
        return m.role === "user";
      });
      expect(userMsg).toBeDefined();
      expect(userMsg!.content).toBe("test prompt");

      const eventMsg = chatMessages.find((m) => {
        return m.role === "assistant" && m.sequenceNumber !== null;
      });
      expect(eventMsg).toBeDefined();
      expect(eventMsg!.content).toBe("Done. Created 3 files.");
      expect(eventMsg!.runId).toBe(runId);
    });

    it("should not duplicate assistant messages when callback runs concurrently", async () => {
      // Regression: idempotent inserts via the (run_id, sequence_number)
      // unique index must collapse concurrent callback invocations to a
      // single row per event.
      const { threadId, runId, secret } = await setupRunAndThread();

      // Both concurrent callbacks see the same two assistant events from Axiom.
      const axiomEvents = [
        {
          sequenceNumber: 0,
          eventData: {
            message: {
              content: [
                { type: "text", text: "Let me start by fetching the teams." },
              ],
            },
          },
        },
        {
          sequenceNumber: 1,
          eventData: {
            message: {
              content: [
                {
                  type: "text",
                  text: "Linear is not connected. Please connect it.",
                },
              ],
            },
          },
        },
      ];
      context.mocks.axiom.queryAxiom.mockResolvedValue(axiomEvents);

      const makeRequest = () => {
        return POST(
          createSignedCallbackRequest(
            "http://localhost/api/internal/callbacks/chat",
            {
              runId,
              status: "completed",
              payload: { threadId, agentId },
            },
            secret,
          ),
        );
      };

      // Fire both handlers concurrently — ON CONFLICT DO NOTHING on the
      // unique index must keep exactly one row per sequence_number.
      const [r1, r2] = await Promise.all([makeRequest(), makeRequest()]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);

      const chatMessages = await getTestChatMessagesByThread(threadId);
      // 1 user + 2 event-backed = 3 rows, no dups.
      expect(chatMessages).toHaveLength(3);
      const eventContents = chatMessages
        .filter((m) => {
          return m.role === "assistant" && m.sequenceNumber !== null;
        })
        .map((m) => {
          return m.content;
        });
      expect(eventContents).toEqual([
        "Let me start by fetching the teams.",
        "Linear is not connected. Please connect it.",
      ]);
    });

    it("should have no assistant messages when no events from Axiom", async () => {
      const { threadId, runId, secret } = await setupRunAndThread();

      // Axiom returns no events
      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([]);

      const response = await POST(
        createSignedCallbackRequest(
          "http://localhost/api/internal/callbacks/chat",
          {
            runId,
            status: "completed",
            payload: { threadId, agentId },
          },
          secret,
        ),
      );

      expect(response.status).toBe(200);

      // No event rows arrived → only the user message exists.
      const chatMessages = await getTestChatMessagesByThread(threadId);
      expect(chatMessages).toHaveLength(1);

      const userMsg = chatMessages.find((m) => {
        return m.role === "user";
      });
      expect(userMsg).toBeDefined();
      expect(userMsg!.content).toBe("test prompt");
    });

    it("should persist user + error messages on failed run", async () => {
      vi.stubEnv("ABLY_API_KEY", "test-key:test-secret");
      reloadEnv();

      const { threadId, runId, secret } = await setupRunAndThread({
        status: "failed",
      });

      const response = await POST(
        createSignedCallbackRequest(
          "http://localhost/api/internal/callbacks/chat",
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

      // 1 user + 1 error row = 2 rows.
      const chatMessages = await getTestChatMessagesByThread(threadId);
      expect(chatMessages).toHaveLength(2);

      const userMsg = chatMessages.find((m) => {
        return m.role === "user";
      });
      expect(userMsg).toBeDefined();
      expect(userMsg!.content).toBe("test prompt");

      const errorMsg = chatMessages.find((m) => {
        return m.role === "assistant" && m.error !== null;
      });
      expect(errorMsg).toBeDefined();
      expect(errorMsg!.content).toBe("Agent crashed");
      expect(errorMsg!.runId).toBe(runId);
      expect(errorMsg!.error).toBe("Agent crashed");

      // The insert fans out chatThreadMessageCreated so the frontend's paged
      // message view refetches and the cancelled/error row appears without
      // a page refresh.
      expect(mockAblyPublish).toHaveBeenCalledWith(
        `chatThreadMessageCreated:${threadId}`,
        null,
      );
    });

    it("should not derive sessionId on failed run without agentSessionId", async () => {
      const { threadId, runId, secret } = await setupRunAndThread({
        status: "failed",
      });

      const response = await POST(
        createSignedCallbackRequest(
          "http://localhost/api/internal/callbacks/chat",
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

      // Failed runs don't have agentSessionId in result, so latestSessionId is null
      const threadSessionId = await getThreadSessionId(threadId);
      expect(threadSessionId).toBeNull();
    });
  });

  describe("Run-Updated Signal", () => {
    beforeEach(() => {
      vi.stubEnv("ABLY_API_KEY", "test-key:test-secret");
      reloadEnv();
    });

    it("should publish chatThreadRunUpdated on completed", async () => {
      const { threadId, runId, secret } = await setupRunAndThread();
      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([]);

      const response = await POST(
        createSignedCallbackRequest(
          "http://localhost/api/internal/callbacks/chat",
          {
            runId,
            status: "completed",
            payload: { threadId, agentId },
          },
          secret,
        ),
      );

      expect(response.status).toBe(200);
      expect(mockAblyPublish).toHaveBeenCalledWith(
        `chatThreadRunUpdated:${threadId}`,
        null,
      );
    });

    it("should publish chatThreadRunUpdated on failed", async () => {
      const { threadId, runId, secret } = await setupRunAndThread({
        status: "failed",
      });

      const response = await POST(
        createSignedCallbackRequest(
          "http://localhost/api/internal/callbacks/chat",
          {
            runId,
            status: "failed",
            error: "boom",
            payload: { threadId, agentId },
          },
          secret,
        ),
      );

      expect(response.status).toBe(200);
      expect(mockAblyPublish).toHaveBeenCalledWith(
        `chatThreadRunUpdated:${threadId}`,
        null,
      );
    });

    it("should NOT publish chatThreadRunUpdated on progress", async () => {
      const { threadId, runId, secret } = await setupRunAndThread();

      const response = await POST(
        createSignedCallbackRequest(
          "http://localhost/api/internal/callbacks/chat",
          {
            runId,
            status: "progress",
            payload: { threadId, agentId },
          },
          secret,
        ),
      );

      expect(response.status).toBe(200);
      expect(mockAblyPublish).not.toHaveBeenCalledWith(
        `chatThreadRunUpdated:${threadId}`,
        null,
      );
    });

    it("should NOT publish when run has no zero_runs mapping", async () => {
      // Seed a run without linking it to a chat thread (so zero_runs.chatThreadId is null)
      const { runId } = await seedTestRun(user.userId, agentId, {
        status: "completed",
      });
      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/chat",
        payload: { threadId: "orphan-thread-id", agentId },
      });
      context.mocks.axiom.queryAxiom.mockResolvedValueOnce([]);

      const response = await POST(
        createSignedCallbackRequest(
          "http://localhost/api/internal/callbacks/chat",
          {
            runId,
            status: "completed",
            payload: { threadId: "orphan-thread-id", agentId },
          },
          secret,
        ),
      );

      expect(response.status).toBe(200);
      expect(mockAblyPublish).not.toHaveBeenCalledWith(
        expect.stringMatching(/^chatThreadRunUpdated:/),
        null,
      );
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
        createSignedCallbackRequest(
          "http://localhost/api/internal/callbacks/chat",
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
        createSignedCallbackRequest(
          "http://localhost/api/internal/callbacks/chat",
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
        createSignedCallbackRequest(
          "http://localhost/api/internal/callbacks/chat",
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
        createSignedCallbackRequest(
          "http://localhost/api/internal/callbacks/chat",
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
        createSignedCallbackRequest(
          "http://localhost/api/internal/callbacks/chat",
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
        createSignedCallbackRequest(
          "http://localhost/api/internal/callbacks/chat",
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
        createSignedCallbackRequest(
          "http://localhost/api/internal/callbacks/chat",
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
        createSignedCallbackRequest(
          "http://localhost/api/internal/callbacks/chat",
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
        createSignedCallbackRequest(
          "http://localhost/api/internal/callbacks/chat",
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
        createSignedCallbackRequest(
          "http://localhost/api/internal/callbacks/chat",
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
