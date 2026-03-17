import { describe, it, expect } from "vitest";
import { delay } from "signal-timers";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  zeroChatMessages$,
  zeroChatSending$,
  zeroChatInput$,
  zeroCurrentSessionId$,
  zeroSessionList$,
  zeroSessionListLoading$,
  zeroSessionListError$,
  zeroSessionError$,
  zeroChatThreadId$,
  setZeroChatInput$,
  clearZeroChatInput$,
  fetchZeroSessionList$,
  switchZeroSession$,
  startNewZeroSession$,
  sendZeroChatMessage$,
} from "../zero-chat.ts";

const context = testContext();

async function setup() {
  await setupPage({
    context,
    path: "/",
    withoutRender: true,
  });
}

/** Default chat-threads handlers used by most send tests. */
function useChatThreadHandlers() {
  server.use(
    http.post("*/api/chat-threads", () => {
      return HttpResponse.json(
        { id: "thread-1", createdAt: "2026-03-10T00:00:00Z" },
        { status: 201 },
      );
    }),
    http.post("*/api/chat-threads/:id/runs", () => {
      return new HttpResponse(null, { status: 204 });
    }),
    http.get("*/api/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

describe("zero-chat signals", () => {
  describe("chat input", () => {
    it("should set and clear chat input", async () => {
      await setup();

      context.store.set(setZeroChatInput$, "hello world");
      expect(context.store.get(zeroChatInput$)).toBe("hello world");

      context.store.set(clearZeroChatInput$);
      expect(context.store.get(zeroChatInput$)).toBe("");
    });
  });

  describe("fetchZeroSessionList$", () => {
    it("should fetch and store thread list", async () => {
      server.use(
        http.get("*/api/chat-threads", () => {
          return HttpResponse.json({
            threads: [
              {
                id: "t1",
                title: null,
                preview: "Hello",
                createdAt: "2026-03-10T00:00:00Z",
                updatedAt: "2026-03-10T00:00:00Z",
              },
              {
                id: "t2",
                title: null,
                preview: "World",
                createdAt: "2026-03-10T01:00:00Z",
                updatedAt: "2026-03-10T01:00:00Z",
              },
            ],
          });
        }),
      );

      await setup();
      await context.store.set(fetchZeroSessionList$);

      const threads = context.store.get(zeroSessionList$);
      expect(threads).toHaveLength(2);
      expect(threads[0]?.id).toBe("t1");
      expect(threads[1]?.preview).toBe("World");
      expect(context.store.get(zeroSessionListLoading$)).toBeFalsy();
      expect(context.store.get(zeroSessionListError$)).toBeNull();
    });

    it("should set error on API failure", async () => {
      server.use(
        http.get("*/api/chat-threads", () => {
          return new HttpResponse(null, {
            status: 500,
            statusText: "Internal Server Error",
          });
        }),
      );

      await setup();
      await context.store.set(fetchZeroSessionList$);

      expect(context.store.get(zeroSessionListError$)).toBe(
        "Failed to load chats: Internal Server Error",
      );
      expect(context.store.get(zeroSessionListLoading$)).toBeFalsy();
    });

    it("should pass agentComposeId as query parameter", async () => {
      let capturedUrl = "";
      server.use(
        http.get("*/api/chat-threads", ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ threads: [] });
        }),
      );

      await setup();
      await context.store.set(fetchZeroSessionList$);

      const url = new URL(capturedUrl);
      expect(url.searchParams.get("agentComposeId")).toBe("mock-compose-id");
    });
  });

  describe("switchZeroSession$", () => {
    it("should set thread id and load messages from thread API", async () => {
      server.use(
        http.get("*/api/chat-threads/:id", () => {
          return HttpResponse.json({
            id: "thread-abc",
            title: null,
            agentComposeId: "mock-compose-id",
            chatMessages: [
              {
                role: "user",
                content: "Hi there",
                createdAt: "2026-03-10T00:00:00Z",
              },
              {
                role: "assistant",
                content: "Hello!",
                runId: "run-1",
                createdAt: "2026-03-10T00:00:01Z",
              },
            ],
            latestSessionId: "session-abc",
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:01Z",
          });
        }),
      );

      await setup();
      await context.store.set(switchZeroSession$, "thread-abc");

      expect(context.store.get(zeroChatThreadId$)).toBe("thread-abc");
      expect(context.store.get(zeroCurrentSessionId$)).toBe("session-abc");

      const messages = context.store.get(zeroChatMessages$);
      expect(messages).toHaveLength(2);
      expect(messages[0]?.role).toBe("user");
      expect(messages[0]?.content).toBe("Hi there");
      expect(messages[1]?.role).toBe("assistant");
      expect(messages[1]?.content).toBe("Hello!");
      expect(context.store.get(zeroSessionError$)).toBeNull();
    });

    it("should set error on API failure", async () => {
      server.use(
        http.get("*/api/chat-threads/:id", () => {
          return new HttpResponse(null, {
            status: 404,
            statusText: "Not Found",
          });
        }),
      );

      await setup();
      await context.store.set(switchZeroSession$, "bad-thread");

      expect(context.store.get(zeroSessionError$)).toBe(
        "Failed to load chat: Not Found",
      );
    });

    it("should abort in-flight polling when switching threads", async () => {
      let pollCount = 0;
      server.use(
        http.post("*/api/agent/runs", () => {
          return HttpResponse.json({ runId: "run-old" });
        }),
        http.get("*/api/agent/runs/:runId/telemetry/agent", () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            framework: "claude-code",
          });
        }),
        http.get("*/api/platform/logs/:runId", () => {
          pollCount++;
          return HttpResponse.json({
            id: "run-old",
            status: "running",
            error: null,
            prompt: "test",
            createdAt: "2026-03-10T00:00:00Z",
            startedAt: "2026-03-10T00:00:01Z",
            completedAt: null,
          });
        }),
        http.get("*/api/chat-threads/:id", () => {
          return HttpResponse.json({
            id: "new-thread",
            title: null,
            agentComposeId: "mock-compose-id",
            chatMessages: [
              {
                role: "user",
                content: "New thread msg",
                createdAt: "2026-03-10T00:00:00Z",
              },
            ],
            latestSessionId: null,
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
          });
        }),
      );
      useChatThreadHandlers();

      await setup();

      const sendPromise = context.store
        .set(sendZeroChatMessage$, "Start polling")
        .catch(() => {});

      await delay(50);
      expect(pollCount).toBeGreaterThan(0);

      await context.store.set(switchZeroSession$, "new-thread");
      await sendPromise;

      const pollCountAfterAbort = pollCount;
      await delay(200);
      expect(pollCount).toBe(pollCountAfterAbort);

      expect(context.store.get(zeroChatThreadId$)).toBe("new-thread");
      const messages = context.store.get(zeroChatMessages$);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content).toBe("New thread msg");
    });

    it("should clear previous messages when switching", async () => {
      server.use(
        http.get("*/api/chat-threads/:id", () => {
          return HttpResponse.json({
            id: "thread-1",
            title: null,
            agentComposeId: "mock-compose-id",
            chatMessages: [],
            latestSessionId: null,
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
          });
        }),
      );

      await setup();

      context.store.set(setZeroChatInput$, "draft");
      await context.store.set(switchZeroSession$, "thread-1");

      expect(context.store.get(zeroChatMessages$)).toHaveLength(0);
      expect(context.store.get(zeroChatSending$)).toBeFalsy();
    });
  });

  describe("startNewZeroSession$", () => {
    it("should reset all chat state", async () => {
      await setup();

      context.store.set(setZeroChatInput$, "some input");
      context.store.set(startNewZeroSession$);

      expect(context.store.get(zeroChatMessages$)).toHaveLength(0);
      expect(context.store.get(zeroCurrentSessionId$)).toBeNull();
      expect(context.store.get(zeroChatThreadId$)).toBeNull();
      expect(context.store.get(zeroChatSending$)).toBeFalsy();
      expect(context.store.get(zeroChatInput$)).toBe("");
    });

    it("should abort in-flight polling when starting a new session", async () => {
      let pollCount = 0;
      server.use(
        http.post("*/api/agent/runs", () => {
          return HttpResponse.json({ runId: "run-poll" });
        }),
        http.get("*/api/agent/runs/:runId/telemetry/agent", () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            framework: "claude-code",
          });
        }),
        http.get("*/api/platform/logs/:runId", () => {
          pollCount++;
          return HttpResponse.json({
            id: "run-poll",
            status: "running",
            error: null,
            prompt: "test",
            createdAt: "2026-03-10T00:00:00Z",
            startedAt: "2026-03-10T00:00:01Z",
            completedAt: null,
          });
        }),
      );
      useChatThreadHandlers();

      await setup();

      const sendPromise = context.store
        .set(sendZeroChatMessage$, "Start polling")
        .catch(() => {});

      await delay(50);
      expect(pollCount).toBeGreaterThan(0);

      context.store.set(startNewZeroSession$);
      await sendPromise;

      const pollCountAfterAbort = pollCount;
      await delay(200);
      expect(pollCount).toBe(pollCountAfterAbort);

      expect(context.store.get(zeroCurrentSessionId$)).toBeNull();
      expect(context.store.get(zeroChatThreadId$)).toBeNull();
      expect(context.store.get(zeroChatMessages$)).toHaveLength(0);
    });
  });

  describe("sendZeroChatMessage$", () => {
    it("should create thread, add messages, and start a run", async () => {
      let capturedRunBody: Record<string, string> | null = null;
      let threadCreated = false;
      let runAssociated = false;
      server.use(
        http.post("*/api/chat-threads", () => {
          threadCreated = true;
          return HttpResponse.json(
            { id: "thread-new", createdAt: "2026-03-10T00:00:00Z" },
            { status: 201 },
          );
        }),
        http.post("*/api/chat-threads/:id/runs", () => {
          runAssociated = true;
          return new HttpResponse(null, { status: 204 });
        }),
        http.get("*/api/chat-threads", () => {
          return HttpResponse.json({ threads: [] });
        }),
        http.post("*/api/agent/runs", async ({ request }) => {
          capturedRunBody = (await request.json()) as Record<string, string>;
          return HttpResponse.json({ runId: "run-123" });
        }),
        http.get("*/api/agent/runs/:runId/telemetry/agent", () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            framework: "claude-code",
          });
        }),
        http.get("*/api/platform/logs/:runId", () => {
          return HttpResponse.json({
            id: "run-123",
            status: "completed",
            error: null,
            prompt: "What can you do?",
            createdAt: "2026-03-10T00:00:00Z",
            startedAt: "2026-03-10T00:00:01Z",
            completedAt: "2026-03-10T00:00:02Z",
          });
        }),
        http.get("*/api/agent/runs/:runId", () => {
          return HttpResponse.json({
            result: { agentSessionId: "new-session-id" },
          });
        }),
      );

      await setup();
      await context.store.set(sendZeroChatMessage$, "What can you do?");

      expect(threadCreated).toBeTruthy();
      expect(runAssociated).toBeTruthy();

      expect(capturedRunBody).toBeTruthy();
      expect(capturedRunBody!.agentComposeId).toBe("mock-compose-id");
      expect(capturedRunBody!.prompt).toBe("What can you do?");

      expect(context.store.get(zeroChatSending$)).toBeFalsy();
      expect(context.store.get(zeroChatThreadId$)).toBe("thread-new");

      const messages = context.store.get(zeroChatMessages$);
      expect(messages.length).toBeGreaterThanOrEqual(2);
      expect(messages[0]?.role).toBe("user");
      expect(messages[0]?.content).toBe("What can you do?");
      expect(messages[1]?.role).toBe("assistant");
    });

    it("should set error on run creation failure", async () => {
      useChatThreadHandlers();
      server.use(
        http.post("*/api/agent/runs", () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      await setup();
      await context.store.set(sendZeroChatMessage$, "Hello");

      const messages = context.store.get(zeroChatMessages$);
      const lastMsg = messages[messages.length - 1];
      expect(lastMsg?.error).toBe("Failed to start agent run");
      expect(context.store.get(zeroChatSending$)).toBeFalsy();
    });

    it("should set error on thread creation failure", async () => {
      server.use(
        http.post("*/api/chat-threads", () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      await setup();
      await context.store.set(sendZeroChatMessage$, "Hello");

      const messages = context.store.get(zeroChatMessages$);
      const lastMsg = messages[messages.length - 1];
      expect(lastMsg?.error).toBe("Failed to create chat thread");
      expect(context.store.get(zeroChatSending$)).toBeFalsy();
    });

    it("should not send empty messages", async () => {
      let runCalled = false;
      server.use(
        http.post("*/api/agent/runs", () => {
          runCalled = true;
          return HttpResponse.json({ runId: "run-123" });
        }),
      );

      await setup();
      await context.store.set(sendZeroChatMessage$, "   ");

      expect(runCalled).toBeFalsy();
      expect(context.store.get(zeroChatMessages$)).toHaveLength(0);
    });

    it("should include sessionId when continuing a thread", async () => {
      let capturedRunBody: Record<string, string> | null = null;
      let threadCreateCalled = false;
      server.use(
        http.get("*/api/chat-threads/:id", () => {
          return HttpResponse.json({
            id: "thread-existing",
            title: null,
            agentComposeId: "mock-compose-id",
            chatMessages: [],
            latestSessionId: "existing-session",
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
          });
        }),
        http.post("*/api/chat-threads", () => {
          threadCreateCalled = true;
          return HttpResponse.json(
            { id: "should-not-create", createdAt: "2026-03-10T00:00:00Z" },
            { status: 201 },
          );
        }),
        http.post("*/api/chat-threads/:id/runs", () => {
          return new HttpResponse(null, { status: 204 });
        }),
        http.get("*/api/chat-threads", () => {
          return HttpResponse.json({ threads: [] });
        }),
        http.post("*/api/agent/runs", async ({ request }) => {
          capturedRunBody = (await request.json()) as Record<string, string>;
          return HttpResponse.json({ runId: "run-456" });
        }),
        http.get("*/api/agent/runs/:runId/telemetry/agent", () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            framework: "claude-code",
          });
        }),
        http.get("*/api/platform/logs/:runId", () => {
          return HttpResponse.json({
            id: "run-456",
            status: "completed",
            error: null,
            prompt: "Follow up",
            createdAt: "2026-03-10T00:00:00Z",
            startedAt: "2026-03-10T00:00:01Z",
            completedAt: "2026-03-10T00:00:02Z",
          });
        }),
        http.get("*/api/agent/runs/:runId", () => {
          return HttpResponse.json({
            result: { agentSessionId: "existing-session" },
          });
        }),
      );

      await setup();

      // Switch to an existing thread first
      await context.store.set(switchZeroSession$, "thread-existing");

      // Now send a follow-up — should NOT create a new thread
      await context.store.set(sendZeroChatMessage$, "Follow up");

      expect(threadCreateCalled).toBeFalsy();
      expect(capturedRunBody).toBeTruthy();
      expect(capturedRunBody!.sessionId).toBe("existing-session");
    });
  });
});
