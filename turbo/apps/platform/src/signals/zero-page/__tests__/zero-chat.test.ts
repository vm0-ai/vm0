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
  zeroSessionSwitching$,
  setZeroChatInput$,
  clearZeroChatInput$,
  fetchZeroSessionList$,
  switchZeroSession$,
  startNewZeroSession$,
  sendZeroChatMessage$,
  sendFromZeroDemo$,
  syncUrlSession$,
  prepareSessionSwitch$,
  zeroChatQueuedMessage$,
  queueZeroChatMessage$,
  withdrawQueuedMessage$,
  cancelActiveRun$,
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
    http.post("*/api/zero/chat-threads", () => {
      return HttpResponse.json(
        { id: "thread-1", createdAt: "2026-03-10T00:00:00Z" },
        { status: 201 },
      );
    }),
    http.post("*/api/zero/chat-threads/:id/runs", () => {
      return new HttpResponse(null, { status: 204 });
    }),
    http.get("*/api/zero/chat-threads", () => {
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
        http.get("*/api/zero/chat-threads", () => {
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
        http.get("*/api/zero/chat-threads", () => {
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
        http.get("*/api/zero/chat-threads", ({ request }) => {
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
        http.get("*/api/zero/chat-threads/:id", () => {
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
        http.get("*/api/zero/chat-threads/:id", () => {
          return new HttpResponse(null, {
            status: 404,
            statusText: "Not Found",
          });
        }),
        http.get("*/api/zero/sessions/:id", () => {
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
        http.post("*/api/zero/runs", () => {
          return HttpResponse.json({ runId: "run-old" });
        }),
        http.get("*/api/zero/runs/:runId/telemetry/agent", () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            framework: "claude-code",
          });
        }),
        http.get("*/api/zero/logs/:runId", () => {
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
        http.get("*/api/zero/chat-threads/:id", () => {
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
        http.get("*/api/zero/chat-threads/:id", () => {
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

  describe("prepareSessionSwitch$", () => {
    it("should set sessionSwitching to true so skeleton shows immediately", async () => {
      await setup();

      expect(context.store.get(zeroSessionSwitching$)).toBeFalsy();

      context.store.set(prepareSessionSwitch$);

      expect(context.store.get(zeroSessionSwitching$)).toBeTruthy();
    });

    it("should clear messages and session error", async () => {
      useChatThreadHandlers();
      server.use(
        http.post("*/api/zero/runs", () => {
          return HttpResponse.json({ runId: "run-1" });
        }),
        http.get("*/api/zero/runs/:runId/telemetry/agent", () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            framework: "claude-code",
          });
        }),
        http.get("*/api/zero/logs/:runId", () => {
          return HttpResponse.json({
            id: "run-1",
            status: "completed",
            error: null,
            prompt: "test",
            createdAt: "2026-03-10T00:00:00Z",
            startedAt: "2026-03-10T00:00:01Z",
            completedAt: "2026-03-10T00:00:02Z",
          });
        }),
        http.get("*/api/zero/runs/:runId", () => {
          return HttpResponse.json({
            result: { agentSessionId: "s1" },
          });
        }),
      );

      await setup();

      // Send a message to populate messages
      await context.store.set(sendZeroChatMessage$, "Hello");
      await delay(50);
      expect(context.store.get(zeroChatMessages$).length).toBeGreaterThan(0);

      context.store.set(prepareSessionSwitch$);

      expect(context.store.get(zeroChatMessages$)).toHaveLength(0);
      expect(context.store.get(zeroSessionError$)).toBeNull();
    });

    it("should be cleared after switchZeroSession$ completes", async () => {
      server.use(
        http.get("*/api/zero/chat-threads/:id", () => {
          return HttpResponse.json({
            id: "thread-1",
            agentComposeId: "mock-compose-id",
            chatMessages: [],
            latestSessionId: null,
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
          });
        }),
      );

      await setup();

      context.store.set(prepareSessionSwitch$);
      expect(context.store.get(zeroSessionSwitching$)).toBeTruthy();

      await context.store.set(switchZeroSession$, "thread-1");
      expect(context.store.get(zeroSessionSwitching$)).toBeFalsy();
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
        http.post("*/api/zero/runs", () => {
          return HttpResponse.json({ runId: "run-poll" });
        }),
        http.get("*/api/zero/runs/:runId/telemetry/agent", () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            framework: "claude-code",
          });
        }),
        http.get("*/api/zero/logs/:runId", () => {
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
        http.post("*/api/zero/chat-threads", () => {
          threadCreated = true;
          return HttpResponse.json(
            { id: "thread-new", createdAt: "2026-03-10T00:00:00Z" },
            { status: 201 },
          );
        }),
        http.post("*/api/zero/chat-threads/:id/runs", () => {
          runAssociated = true;
          return new HttpResponse(null, { status: 204 });
        }),
        http.get("*/api/zero/chat-threads", () => {
          return HttpResponse.json({ threads: [] });
        }),
        http.post("*/api/zero/runs", async ({ request }) => {
          capturedRunBody = (await request.json()) as Record<string, string>;
          return HttpResponse.json({ runId: "run-123" });
        }),
        http.get("*/api/zero/runs/:runId/telemetry/agent", () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            framework: "claude-code",
          });
        }),
        http.get("*/api/zero/logs/:runId", () => {
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
        http.get("*/api/zero/runs/:runId", () => {
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

    it("should surface API error message on run creation failure", async () => {
      useChatThreadHandlers();
      server.use(
        http.post("*/api/zero/runs", () => {
          return HttpResponse.json(
            { error: { message: "Some API error", code: "BAD_REQUEST" } },
            { status: 400 },
          );
        }),
      );

      await setup();
      await context.store.set(sendZeroChatMessage$, "Hello");

      const messages = context.store.get(zeroChatMessages$);
      const lastMsg = messages[messages.length - 1];
      expect(lastMsg?.error).toBe("Some API error");
      expect(context.store.get(zeroChatSending$)).toBeFalsy();
    });

    it("should surface provider incompatibility error message", async () => {
      useChatThreadHandlers();
      server.use(
        http.post("*/api/zero/runs", () => {
          return HttpResponse.json(
            {
              error: {
                message:
                  "Cannot continue session: this session was created with Moonshot (Kimi) and cannot be continued with Anthropic API Key",
                code: "PROVIDER_INCOMPATIBLE",
              },
            },
            { status: 400 },
          );
        }),
      );

      await setup();
      await context.store.set(sendZeroChatMessage$, "Hello");

      const messages = context.store.get(zeroChatMessages$);
      const lastMsg = messages[messages.length - 1];
      expect(lastMsg?.error).toBe(
        "Provider not compatible: This session was created with a different provider type.",
      );
      expect(context.store.get(zeroChatSending$)).toBeFalsy();
    });

    it("should fall back to generic message when error body is unparseable", async () => {
      useChatThreadHandlers();
      server.use(
        http.post("*/api/zero/runs", () => {
          return new HttpResponse("Bad Gateway", { status: 502 });
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
        http.post("*/api/zero/chat-threads", () => {
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
        http.post("*/api/zero/runs", () => {
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
        http.get("*/api/zero/chat-threads/:id", () => {
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
        http.post("*/api/zero/chat-threads", () => {
          threadCreateCalled = true;
          return HttpResponse.json(
            { id: "should-not-create", createdAt: "2026-03-10T00:00:00Z" },
            { status: 201 },
          );
        }),
        http.post("*/api/zero/chat-threads/:id/runs", () => {
          return new HttpResponse(null, { status: 204 });
        }),
        http.get("*/api/zero/chat-threads", () => {
          return HttpResponse.json({ threads: [] });
        }),
        http.post("*/api/zero/runs", async ({ request }) => {
          capturedRunBody = (await request.json()) as Record<string, string>;
          return HttpResponse.json({ runId: "run-456" });
        }),
        http.get("*/api/zero/runs/:runId/telemetry/agent", () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            framework: "claude-code",
          });
        }),
        http.get("*/api/zero/logs/:runId", () => {
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
        http.get("*/api/zero/runs/:runId", () => {
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

  describe("sendFromZeroDemo$", () => {
    it("should reset session and start sending the message", async () => {
      let runCreated = false;
      server.use(
        http.post("*/api/zero/chat-threads", () => {
          return HttpResponse.json(
            { id: "thread-demo", createdAt: "2026-03-10T00:00:00Z" },
            { status: 201 },
          );
        }),
        http.post("*/api/zero/chat-threads/:id/runs", () => {
          return new HttpResponse(null, { status: 204 });
        }),
        http.get("*/api/zero/chat-threads", () => {
          return HttpResponse.json({ threads: [] });
        }),
        http.post("*/api/zero/runs", () => {
          runCreated = true;
          return HttpResponse.json({ runId: "run-demo" });
        }),
        http.get("*/api/zero/runs/:runId/telemetry/agent", () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            framework: "claude-code",
          });
        }),
        http.get("*/api/zero/logs/:runId", () => {
          return HttpResponse.json({
            id: "run-demo",
            status: "completed",
            error: null,
            prompt: "Hello from demo",
            createdAt: "2026-03-10T00:00:00Z",
            startedAt: "2026-03-10T00:00:01Z",
            completedAt: "2026-03-10T00:00:02Z",
          });
        }),
        http.get("*/api/zero/runs/:runId", () => {
          return HttpResponse.json({
            result: { agentSessionId: "demo-session" },
          });
        }),
      );

      await setup();

      // Set up some existing state that should get reset
      context.store.set(setZeroChatInput$, "old input");

      context.store.set(sendFromZeroDemo$, "Hello from demo");

      // Wait for the detached send to complete
      await delay(100);

      expect(runCreated).toBeTruthy();
      // Session was reset before sending
      expect(context.store.get(zeroChatInput$)).toBe("");
    });
  });

  describe("syncUrlSession$", () => {
    it("should switch to the URL session when it differs from current", async () => {
      server.use(
        http.get("*/api/zero/chat-threads/:id", () => {
          return HttpResponse.json({
            id: "url-thread",
            title: null,
            agentComposeId: "mock-compose-id",
            chatMessages: [
              {
                role: "user",
                content: "From URL",
                createdAt: "2026-03-10T00:00:00Z",
              },
            ],
            latestSessionId: "url-session",
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
          });
        }),
      );

      // Set up with the chat session path so zeroSessionId$ returns "url-thread"
      await setupPage({
        context,
        path: "/chat/url-thread",
        withoutRender: true,
      });

      await context.store.set(syncUrlSession$);

      expect(context.store.get(zeroChatThreadId$)).toBe("url-thread");
      expect(context.store.get(zeroCurrentSessionId$)).toBe("url-session");
      const messages = context.store.get(zeroChatMessages$);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content).toBe("From URL");
    });

    it("should skip when no session ID in URL", async () => {
      // Set up with /chat path (no session ID)
      await setupPage({
        context,
        path: "/chat",
        withoutRender: true,
      });

      await context.store.set(syncUrlSession$);

      expect(context.store.get(zeroChatThreadId$)).toBeNull();
    });

    it("should skip when URL session already matches current thread", async () => {
      let switchCount = 0;
      server.use(
        http.get("*/api/zero/chat-threads/:id", () => {
          switchCount++;
          return HttpResponse.json({
            id: "already-loaded",
            title: null,
            agentComposeId: "mock-compose-id",
            chatMessages: [],
            latestSessionId: null,
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
          });
        }),
      );

      // Set up with the chat session path
      await setupPage({
        context,
        path: "/chat/already-loaded",
        withoutRender: true,
      });

      // First sync should switch
      await context.store.set(syncUrlSession$);
      expect(switchCount).toBe(1);

      // Second sync with same URL should skip
      await context.store.set(syncUrlSession$);
      expect(switchCount).toBe(1);
    });

    it("should reset sessionSwitching when thread is already loaded", async () => {
      server.use(
        http.get("*/api/zero/chat-threads/:id", () => {
          return HttpResponse.json({
            id: "already-loaded",
            title: null,
            agentComposeId: "mock-compose-id",
            chatMessages: [
              {
                role: "user",
                content: "Existing",
                createdAt: "2026-03-10T00:00:00Z",
              },
            ],
            latestSessionId: null,
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
          });
        }),
      );

      await setupPage({
        context,
        path: "/chat/already-loaded",
        withoutRender: true,
      });

      // First sync loads the thread
      await context.store.set(syncUrlSession$);
      expect(context.store.get(zeroChatThreadId$)).toBe("already-loaded");

      // Simulate prepareSessionSwitch$ being called (e.g. by route setup)
      context.store.set(prepareSessionSwitch$);
      expect(context.store.get(zeroSessionSwitching$)).toBeTruthy();

      // Second sync detects thread matches — must reset switching
      await context.store.set(syncUrlSession$);
      expect(context.store.get(zeroSessionSwitching$)).toBeFalsy();
    });
  });

  describe("message queueing", () => {
    it("should queue a message while sending and clear the input", async () => {
      let pollCount = 0;
      server.use(
        http.post("*/api/zero/runs", () => {
          return HttpResponse.json({ runId: "run-q1" });
        }),
        http.get("*/api/zero/runs/:runId/telemetry/agent", () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            framework: "claude-code",
          });
        }),
        http.get("*/api/zero/logs/:runId", () => {
          pollCount++;
          return HttpResponse.json({
            id: "run-q1",
            status: "running",
            error: null,
            prompt: "first",
            createdAt: "2026-03-10T00:00:00Z",
            startedAt: "2026-03-10T00:00:01Z",
            completedAt: null,
          });
        }),
      );
      useChatThreadHandlers();

      await setup();

      // Start a send — this puts the system into "sending" state
      const sendPromise = context.store
        .set(sendZeroChatMessage$, "first message")
        .catch(() => {});

      await delay(50);
      expect(pollCount).toBeGreaterThan(0);
      expect(context.store.get(zeroChatSending$)).toBeTruthy();

      // Set some input text then queue it
      context.store.set(setZeroChatInput$, "follow-up");
      context.store.set(queueZeroChatMessage$, "follow-up");

      // Queued message should be stored and input cleared
      expect(context.store.get(zeroChatQueuedMessage$)).toStrictEqual({
        text: "follow-up",
        modelProvider: undefined,
      });
      expect(context.store.get(zeroChatInput$)).toBe("");

      // Clean up: abort the send
      context.store.set(startNewZeroSession$);
      await sendPromise;
    });

    it("should not queue when agent is idle", async () => {
      await setup();

      context.store.set(queueZeroChatMessage$, "should not queue");

      expect(context.store.get(zeroChatQueuedMessage$)).toBeNull();
    });

    it("should reject a second queued message", async () => {
      server.use(
        http.post("*/api/zero/runs", () => {
          return HttpResponse.json({ runId: "run-q2" });
        }),
        http.get("*/api/zero/runs/:runId/telemetry/agent", () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            framework: "claude-code",
          });
        }),
        http.get("*/api/zero/logs/:runId", () => {
          return HttpResponse.json({
            id: "run-q2",
            status: "running",
            error: null,
            prompt: "first",
            createdAt: "2026-03-10T00:00:00Z",
            startedAt: "2026-03-10T00:00:01Z",
            completedAt: null,
          });
        }),
      );
      useChatThreadHandlers();

      await setup();

      const sendPromise = context.store
        .set(sendZeroChatMessage$, "first")
        .catch(() => {});

      await delay(50);

      context.store.set(queueZeroChatMessage$, "queued-1");
      context.store.set(queueZeroChatMessage$, "queued-2");

      // Only the first queued message should be stored
      expect(context.store.get(zeroChatQueuedMessage$)?.text).toBe("queued-1");

      context.store.set(startNewZeroSession$);
      await sendPromise;
    });

    it("should withdraw a queued message back into the input", async () => {
      server.use(
        http.post("*/api/zero/runs", () => {
          return HttpResponse.json({ runId: "run-q3" });
        }),
        http.get("*/api/zero/runs/:runId/telemetry/agent", () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            framework: "claude-code",
          });
        }),
        http.get("*/api/zero/logs/:runId", () => {
          return HttpResponse.json({
            id: "run-q3",
            status: "running",
            error: null,
            prompt: "first",
            createdAt: "2026-03-10T00:00:00Z",
            startedAt: "2026-03-10T00:00:01Z",
            completedAt: null,
          });
        }),
      );
      useChatThreadHandlers();

      await setup();

      const sendPromise = context.store
        .set(sendZeroChatMessage$, "first")
        .catch(() => {});

      await delay(50);

      context.store.set(queueZeroChatMessage$, "edit me");
      expect(context.store.get(zeroChatQueuedMessage$)).toBeTruthy();

      // Withdraw the queued message
      context.store.set(withdrawQueuedMessage$);

      expect(context.store.get(zeroChatQueuedMessage$)).toBeNull();
      expect(context.store.get(zeroChatInput$)).toBe("edit me");

      context.store.set(startNewZeroSession$);
      await sendPromise;
    });

    it("should auto-send queued message when the run completes", async () => {
      let runCount = 0;
      let latestPrompt = "";
      let completeRun = false;
      server.use(
        http.post("*/api/zero/runs", async ({ request }) => {
          runCount++;
          const body = (await request.json()) as Record<string, string>;
          latestPrompt = body.prompt;
          return HttpResponse.json({ runId: `run-auto-${runCount}` });
        }),
        http.get("*/api/zero/runs/:runId/telemetry/agent", () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            framework: "claude-code",
          });
        }),
        http.get("*/api/zero/logs/:runId", () => {
          if (completeRun) {
            return HttpResponse.json({
              id: `run-auto-${runCount}`,
              status: "completed",
              error: null,
              prompt: latestPrompt,
              createdAt: "2026-03-10T00:00:00Z",
              startedAt: "2026-03-10T00:00:01Z",
              completedAt: "2026-03-10T00:00:02Z",
            });
          }
          return HttpResponse.json({
            id: `run-auto-${runCount}`,
            status: "running",
            error: null,
            prompt: latestPrompt,
            createdAt: "2026-03-10T00:00:00Z",
            startedAt: "2026-03-10T00:00:01Z",
            completedAt: null,
          });
        }),
        http.get("*/api/zero/runs/:runId", () => {
          return HttpResponse.json({
            result: { agentSessionId: "session-auto" },
          });
        }),
      );
      useChatThreadHandlers();

      await setup();

      const sendPromise = context.store
        .set(sendZeroChatMessage$, "first message")
        .catch(() => {});

      await delay(50);
      expect(context.store.get(zeroChatSending$)).toBeTruthy();

      // Queue a follow-up while the first run is in progress
      context.store.set(queueZeroChatMessage$, "auto follow-up");
      expect(context.store.get(zeroChatQueuedMessage$)).toBeTruthy();

      // Let both the first run and auto-sent second run complete immediately
      completeRun = true;
      await sendPromise;

      // Poll until the detached auto-send completes (runCount reaches 2 and sending is false)
      for (let i = 0; i < 50; i++) {
        if (runCount >= 2 && !context.store.get(zeroChatSending$)) {
          break;
        }
        await delay(50);
      }

      expect(context.store.get(zeroChatQueuedMessage$)).toBeNull();
      // The auto-send should have triggered a second run
      expect(runCount).toBe(2);
      expect(latestPrompt).toBe("auto follow-up");
      expect(context.store.get(zeroChatSending$)).toBeFalsy();
    });

    it("should auto-send queued message after run cancellation", async () => {
      let runCount = 0;
      let latestPrompt = "";
      server.use(
        http.post("*/api/zero/runs", async ({ request }) => {
          runCount++;
          const body = (await request.json()) as Record<string, string>;
          latestPrompt = body.prompt;
          return HttpResponse.json({ runId: `run-cancel-${runCount}` });
        }),
        http.get("*/api/zero/runs/:runId/telemetry/agent", () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            framework: "claude-code",
          });
        }),
        http.get("*/api/zero/logs/:runId", () => {
          // First run stays "running" until cancelled; second run completes immediately
          if (runCount >= 2) {
            return HttpResponse.json({
              id: `run-cancel-${runCount}`,
              status: "completed",
              error: null,
              prompt: latestPrompt,
              createdAt: "2026-03-10T00:00:00Z",
              startedAt: "2026-03-10T00:00:01Z",
              completedAt: "2026-03-10T00:00:02Z",
            });
          }
          return HttpResponse.json({
            id: `run-cancel-${runCount}`,
            status: "running",
            error: null,
            prompt: latestPrompt,
            createdAt: "2026-03-10T00:00:00Z",
            startedAt: "2026-03-10T00:00:01Z",
            completedAt: null,
          });
        }),
        http.post("*/api/zero/runs/:runId/cancel", () => {
          return new HttpResponse(null, { status: 204 });
        }),
        http.get("*/api/zero/runs/:runId", () => {
          return HttpResponse.json({
            result: { agentSessionId: "session-cancel" },
          });
        }),
      );
      useChatThreadHandlers();

      await setup();

      const sendPromise = context.store
        .set(sendZeroChatMessage$, "first message")
        .catch(() => {});

      await delay(50);
      expect(context.store.get(zeroChatSending$)).toBeTruthy();

      // Queue a follow-up
      context.store.set(queueZeroChatMessage$, "after cancel");
      expect(context.store.get(zeroChatQueuedMessage$)).toBeTruthy();

      // Cancel the active run — this aborts polling, which causes
      // sendZeroChatMessage$ to hit its finally block and auto-send
      await context.store.set(cancelActiveRun$);
      await sendPromise;

      // Poll until the detached auto-send completes (runCount reaches 2 and sending is false)
      for (let i = 0; i < 50; i++) {
        if (runCount >= 2 && !context.store.get(zeroChatSending$)) {
          break;
        }
        await delay(50);
      }

      expect(context.store.get(zeroChatQueuedMessage$)).toBeNull();
      // The queued message should have triggered a second run
      expect(runCount).toBe(2);
      expect(latestPrompt).toBe("after cancel");
      expect(context.store.get(zeroChatSending$)).toBeFalsy();
    });
  });
});
