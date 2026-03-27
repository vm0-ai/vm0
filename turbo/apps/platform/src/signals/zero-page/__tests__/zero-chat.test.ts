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
  prepareSessionSwitch$,
  loadSessionFromSnapshot$,
  chatSessionSnapshot$,
  zeroChatAttachments$,
  uploadZeroAttachment$,
  removeZeroAttachment$,
  cancelZeroAttachmentUpload$,
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
    http.get("*/api/zero/chat-threads/:id", () => {
      return HttpResponse.json({
        chatMessages: [],
        unsavedRuns: [],
      });
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
                agentId: "mock-compose-id",
                createdAt: "2026-03-10T00:00:00Z",
                updatedAt: "2026-03-10T00:00:00Z",
              },
              {
                id: "t2",
                title: null,
                preview: "World",
                agentId: "mock-compose-id",
                createdAt: "2026-03-10T01:00:00Z",
                updatedAt: "2026-03-10T01:00:00Z",
              },
            ],
          });
        }),
      );

      await setup();
      await context.store.set(fetchZeroSessionList$, context.signal);

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
      await context.store.set(fetchZeroSessionList$, context.signal);

      expect(context.store.get(zeroSessionListError$)).toBe(
        "Failed to load chats (500)",
      );
      expect(context.store.get(zeroSessionListLoading$)).toBeFalsy();
    });

    it("should pass agentId as query parameter", async () => {
      let capturedUrl = "";
      server.use(
        http.get("*/api/zero/chat-threads", ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ threads: [] });
        }),
      );

      await setup();
      await context.store.set(fetchZeroSessionList$, context.signal);

      const url = new URL(capturedUrl);
      expect(url.searchParams.get("agentId")).toBe("mock-compose-id");
    });
  });

  describe("switchZeroSession$", () => {
    it("should set thread id and load messages from thread API", async () => {
      server.use(
        http.get("*/api/zero/chat-threads/:id", () => {
          return HttpResponse.json({
            id: "thread-abc",
            title: null,
            agentId: "mock-compose-id",
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
      context.store.set(switchZeroSession$, "thread-abc");
      await context.store.set(loadSessionFromSnapshot$, context.signal);

      expect(context.store.get(zeroChatThreadId$)).toBe("thread-abc");
      expect(context.store.get(zeroCurrentSessionId$)).toBe("session-abc");

      const messages = await context.store.get(zeroChatMessages$);
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
        http.get("*/api/zero/chat-threads", () => {
          return HttpResponse.json({ threads: [] });
        }),
      );

      await setup();
      context.store.set(switchZeroSession$, "bad-thread");

      // Snapshot returns null when both APIs fail (no throw, to avoid unhandled rejections)
      const snapshot = await context.store.get(chatSessionSnapshot$);
      expect(snapshot).toBeNull();
      await expect(context.store.get(zeroChatMessages$)).resolves.toHaveLength(
        0,
      );
    });

    it("should abort in-flight polling when switching threads", async () => {
      let pollCount = 0;
      useChatThreadHandlers();
      server.use(
        http.post("*/api/zero/runs", () => {
          return HttpResponse.json({ runId: "run-old" }, { status: 201 });
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
            agentId: "mock-compose-id",
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

      await setup();

      const sendPromise = context.store
        .set(sendZeroChatMessage$, "Start polling", undefined, context.signal)
        .catch(() => {});

      await delay(50);
      expect(pollCount).toBeGreaterThan(0);

      context.store.set(switchZeroSession$, "new-thread");
      await context.store.set(loadSessionFromSnapshot$, context.signal);
      await sendPromise;

      const pollCountAfterAbort = pollCount;
      await delay(200);
      expect(pollCount).toBe(pollCountAfterAbort);

      expect(context.store.get(zeroChatThreadId$)).toBe("new-thread");
      const messages = await context.store.get(zeroChatMessages$);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content).toBe("New thread msg");
    });

    it("should clear previous messages when switching", async () => {
      server.use(
        http.get("*/api/zero/chat-threads/:id", () => {
          return HttpResponse.json({
            id: "thread-1",
            title: null,
            agentId: "mock-compose-id",
            chatMessages: [],
            latestSessionId: null,
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
          });
        }),
      );

      await setup();

      context.store.set(setZeroChatInput$, "draft");
      context.store.set(switchZeroSession$, "thread-1");

      await expect(context.store.get(zeroChatMessages$)).resolves.toHaveLength(
        0,
      );
      expect(context.store.get(zeroChatSending$)).toBeFalsy();
    });
  });

  describe("prepareSessionSwitch$", () => {
    it("should clear messages and session error", async () => {
      useChatThreadHandlers();
      server.use(
        http.post("*/api/zero/runs", () => {
          return HttpResponse.json({ runId: "run-1" }, { status: 201 });
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
      await context.store.set(
        sendZeroChatMessage$,
        "Hello",
        undefined,
        context.signal,
      );
      await delay(50);
      expect(
        (await context.store.get(zeroChatMessages$)).length,
      ).toBeGreaterThan(0);

      context.store.set(prepareSessionSwitch$);

      await expect(context.store.get(zeroChatMessages$)).resolves.toHaveLength(
        0,
      );
      expect(context.store.get(zeroSessionError$)).toBeNull();
    });
  });

  describe("startNewZeroSession$", () => {
    it("should reset all chat state", async () => {
      await setup();

      context.store.set(setZeroChatInput$, "some input");
      context.store.set(startNewZeroSession$);

      await expect(context.store.get(zeroChatMessages$)).resolves.toHaveLength(
        0,
      );
      expect(context.store.get(zeroCurrentSessionId$)).toBeNull();
      expect(context.store.get(zeroChatThreadId$)).toBeNull();
      expect(context.store.get(zeroChatSending$)).toBeFalsy();
      expect(context.store.get(zeroChatInput$)).toBe("");
    });

    it("should abort in-flight polling when starting a new session", async () => {
      let pollCount = 0;
      server.use(
        http.post("*/api/zero/runs", () => {
          return HttpResponse.json({ runId: "run-poll" }, { status: 201 });
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
        .set(sendZeroChatMessage$, "Start polling", undefined, context.signal)
        .catch(() => {});

      await delay(50);
      expect(pollCount).toBeGreaterThan(0);

      context.store.set(startNewZeroSession$);
      await sendPromise;

      const pollCountAfterAbort = pollCount;
      await delay(200);
      expect(pollCount).toBe(pollCountAfterAbort);

      expect(context.store.get(zeroCurrentSessionId$)).toBeNull();
      await expect(context.store.get(zeroChatMessages$)).resolves.toHaveLength(
        0,
      );
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
        http.get("*/api/zero/chat-threads/:id", () => {
          return HttpResponse.json({
            chatMessages: [],
            unsavedRuns: [],
          });
        }),
        http.post("*/api/zero/runs", async ({ request }) => {
          capturedRunBody = (await request.json()) as Record<string, string>;
          return HttpResponse.json({ runId: "run-123" }, { status: 201 });
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
      await context.store.set(
        sendZeroChatMessage$,
        "What can you do?",
        undefined,
        context.signal,
      );

      expect(threadCreated).toBeTruthy();
      expect(runAssociated).toBeTruthy();

      expect(capturedRunBody).toBeTruthy();
      expect(capturedRunBody!.agentId).toBe("mock-compose-id");
      expect(capturedRunBody!.prompt).toBe("What can you do?");

      expect(context.store.get(zeroChatSending$)).toBeFalsy();
      expect(context.store.get(zeroChatThreadId$)).toBe("thread-new");

      const messages = await context.store.get(zeroChatMessages$);
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
      await context.store.set(
        sendZeroChatMessage$,
        "Hello",
        undefined,
        context.signal,
      );

      const messages = await context.store.get(zeroChatMessages$);
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
      await context.store.set(
        sendZeroChatMessage$,
        "Hello",
        undefined,
        context.signal,
      );

      const messages = await context.store.get(zeroChatMessages$);
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
      await context.store.set(
        sendZeroChatMessage$,
        "Hello",
        undefined,
        context.signal,
      );

      const messages = await context.store.get(zeroChatMessages$);
      const lastMsg = messages[messages.length - 1];
      expect(lastMsg?.error).toBe("Failed to start agent run (502)");
      expect(context.store.get(zeroChatSending$)).toBeFalsy();
    });

    it("should set error on thread creation failure", async () => {
      server.use(
        http.post("*/api/zero/chat-threads", () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      await setup();
      await context.store.set(
        sendZeroChatMessage$,
        "Hello",
        undefined,
        context.signal,
      );

      const messages = await context.store.get(zeroChatMessages$);
      const lastMsg = messages[messages.length - 1];
      expect(lastMsg?.error).toBe("Failed to create chat thread");
      expect(context.store.get(zeroChatSending$)).toBeFalsy();
    });

    it("should not send empty messages", async () => {
      let runCalled = false;
      server.use(
        http.post("*/api/zero/runs", () => {
          runCalled = true;
          return HttpResponse.json({ runId: "run-123" }, { status: 201 });
        }),
      );

      await setup();
      await context.store.set(
        sendZeroChatMessage$,
        "   ",
        undefined,
        context.signal,
      );

      expect(runCalled).toBeFalsy();
      await expect(context.store.get(zeroChatMessages$)).resolves.toHaveLength(
        0,
      );
    });

    it("should include sessionId when continuing a thread", async () => {
      let capturedRunBody: Record<string, string> | null = null;
      let threadCreateCalled = false;
      server.use(
        http.get("*/api/zero/chat-threads/:id", () => {
          return HttpResponse.json({
            id: "thread-existing",
            title: null,
            agentId: "mock-compose-id",
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
          return HttpResponse.json({ runId: "run-456" }, { status: 201 });
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
      context.store.set(switchZeroSession$, "thread-existing");
      await context.store.set(loadSessionFromSnapshot$, context.signal);

      // Now send a follow-up — should NOT create a new thread
      await context.store.set(
        sendZeroChatMessage$,
        "Follow up",
        undefined,
        context.signal,
      );

      expect(threadCreateCalled).toBeFalsy();
      expect(capturedRunBody).toBeTruthy();
      expect(capturedRunBody!.sessionId).toBe("existing-session");
    });
  });

  describe("loadSessionFromSnapshot$", () => {
    it("should load session data from URL on route setup", async () => {
      server.use(
        http.get("*/api/zero/chat-threads/:id", () => {
          return HttpResponse.json({
            id: "url-thread",
            title: null,
            agentId: "mock-compose-id",
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

      // Route setup calls loadSessionFromSnapshot$ which reads chatSessionSnapshot$
      await setupPage({
        context,
        path: "/chat/url-thread",
        withoutRender: true,
      });

      expect(context.store.get(zeroChatThreadId$)).toBe("url-thread");
      expect(context.store.get(zeroCurrentSessionId$)).toBe("url-session");
      const messages = await context.store.get(zeroChatMessages$);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content).toBe("From URL");
    });

    it("should return null for URL without session ID", async () => {
      await setupPage({
        context,
        path: "/chat",
        withoutRender: true,
      });

      expect(context.store.get(zeroChatThreadId$)).toBeNull();
    });

    it("should skip load when messages are already present", async () => {
      let loadCount = 0;
      server.use(
        http.get("*/api/zero/chat-threads/:id", () => {
          loadCount++;
          return HttpResponse.json({
            id: "already-loaded",
            title: null,
            agentId: "mock-compose-id",
            chatMessages: [
              {
                role: "user",
                content: "Existing msg",
                createdAt: "2026-03-10T00:00:00Z",
              },
            ],
            latestSessionId: null,
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
          });
        }),
      );

      // Route setup loads the thread
      await setupPage({
        context,
        path: "/chat/already-loaded",
        withoutRender: true,
      });

      await expect(context.store.get(zeroChatMessages$)).resolves.toHaveLength(
        1,
      );
      const countAfterSetup = loadCount;

      // Second call skips because messages are already present
      await context.store.set(loadSessionFromSnapshot$, context.signal);
      expect(loadCount).toBe(countAfterSetup);
    });
  });
  describe("attachment upload and cancel", () => {
    function useUploadHandler(options?: { delayMs?: number }) {
      const delayMs = options?.delayMs ?? 0;
      server.use(
        http.get("*/api/zero/chat-threads", () => {
          return HttpResponse.json({ threads: [] });
        }),
        http.post("*/api/zero/uploads", async () => {
          if (delayMs > 0) {
            await delay(delayMs);
          }
          return HttpResponse.json({
            id: "upload-1",
            filename: "test.png",
            contentType: "image/png",
            size: 1024,
            url: "https://example.com/test.png",
          });
        }),
      );
    }

    function createTestFile(name = "test.png") {
      return new File(["file-content"], name, { type: "image/png" });
    }

    it("should upload a file and update attachment state", async () => {
      useUploadHandler();
      await setup();

      await context.store.set(
        uploadZeroAttachment$,
        createTestFile(),
        context.signal,
      );

      const attachments = context.store.get(zeroChatAttachments$);
      expect(attachments).toHaveLength(1);
      expect(attachments[0]?.filename).toBe("test.png");
      expect(attachments[0]?.uploading).toBeFalsy();
      expect(attachments[0]?.url).toBe("https://example.com/test.png");
    });

    it("should cancel an in-flight upload and remove the attachment", async () => {
      useUploadHandler({ delayMs: 500 });
      await setup();

      const uploadPromise = context.store
        .set(uploadZeroAttachment$, createTestFile(), context.signal)
        .catch(() => {});

      // Wait for the placeholder to appear
      await delay(10);
      const before = context.store.get(zeroChatAttachments$);
      expect(before).toHaveLength(1);
      expect(before[0]?.uploading).toBeTruthy();
      const attachmentId = before[0]!.id;

      // Cancel the upload
      context.store.set(cancelZeroAttachmentUpload$, attachmentId);

      await uploadPromise;

      const after = context.store.get(zeroChatAttachments$);
      expect(after).toHaveLength(0);
    });

    it("should remove a completed attachment without aborting", async () => {
      useUploadHandler();
      await setup();

      await context.store.set(
        uploadZeroAttachment$,
        createTestFile(),
        context.signal,
      );

      const attachments = context.store.get(zeroChatAttachments$);
      expect(attachments).toHaveLength(1);
      const attachmentId = attachments[0]!.id;

      context.store.set(removeZeroAttachment$, attachmentId);

      expect(context.store.get(zeroChatAttachments$)).toHaveLength(0);
    });

    it("should cancel one upload without affecting others", async () => {
      let requestCount = 0;
      server.use(
        http.get("*/api/zero/chat-threads", () => {
          return HttpResponse.json({ threads: [] });
        }),
        http.post("*/api/zero/uploads", async () => {
          requestCount++;
          const currentCount = requestCount;
          await delay(300);
          return HttpResponse.json({
            id: `upload-${currentCount}`,
            filename: `file-${currentCount}.png`,
            contentType: "image/png",
            size: 1024,
            url: `https://example.com/file-${currentCount}.png`,
          });
        }),
      );
      await setup();

      const promise1 = context.store
        .set(
          uploadZeroAttachment$,
          createTestFile("file-a.png"),
          context.signal,
        )
        .catch(() => {});
      const promise2 = context.store
        .set(
          uploadZeroAttachment$,
          createTestFile("file-b.png"),
          context.signal,
        )
        .catch(() => {});

      // Wait for both placeholders
      await delay(10);
      const before = context.store.get(zeroChatAttachments$);
      expect(before).toHaveLength(2);

      // Cancel the first upload
      const firstId = before[0]!.id;
      context.store.set(cancelZeroAttachmentUpload$, firstId);

      await Promise.all([promise1, promise2]);

      const after = context.store.get(zeroChatAttachments$);
      // Only the second upload should remain, completed
      expect(after).toHaveLength(1);
      expect(after[0]?.uploading).toBeFalsy();
      expect(after[0]?.url).toContain("example.com");
    });

    it("should remove placeholder on upload failure", async () => {
      server.use(
        http.post("*/api/zero/uploads", () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );
      await setup();

      await context.store.set(
        uploadZeroAttachment$,
        createTestFile(),
        context.signal,
      );

      expect(context.store.get(zeroChatAttachments$)).toHaveLength(0);
    });
  });
});
