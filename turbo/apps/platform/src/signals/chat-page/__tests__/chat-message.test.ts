import { assert, describe, it, expect, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { createDeferredPromise } from "../../utils.ts";
import {
  zeroChatMessages$,
  allFinished$,
  zeroChatInput$,
  chatThreads$,
  setZeroChatInput$,
  clearZeroChatInput$,
  startNewZeroSession$,
  sendExistingThreadMessage$,
  sendNewThreadMessage$,
  loadChatMessages$,
  zeroChatAttachments$,
  uploadZeroAttachment$,
  removeZeroAttachment$,
  createNewChatThread$,
  canSendZeroChat$,
} from "../chat-message.ts";
import { currentChatThreadId$ } from "../../agent-chat.ts";

const context = testContext();

function setup() {
  detachedSetupPage({
    context,
    path: "/",
    withoutRender: true,
  });
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

  describe("canSendZeroChat$", () => {
    it("should return false when input is empty and no attachments", async () => {
      await setup();
      expect(context.store.get(canSendZeroChat$)).toBeFalsy();
    });

    it("should return true when input has text", async () => {
      await setup();
      context.store.set(setZeroChatInput$, "hello");
      expect(context.store.get(canSendZeroChat$)).toBeTruthy();
    });

    it("should return false for whitespace-only input", async () => {
      await setup();
      context.store.set(setZeroChatInput$, "   ");
      expect(context.store.get(canSendZeroChat$)).toBeFalsy();
    });

    it("should return true when attachments exist even with empty input", async () => {
      server.use(
        http.get("*/api/zero/chat-threads", () => {
          return HttpResponse.json({ threads: [] });
        }),
        http.post("*/api/zero/uploads", () => {
          return HttpResponse.json({
            id: "upload-1",
            filename: "photo.png",
            contentType: "image/png",
            size: 1024,
            url: "https://example.com/photo.png",
          });
        }),
      );
      await setup();

      expect(context.store.get(canSendZeroChat$)).toBeFalsy();

      await context.store.set(
        uploadZeroAttachment$,
        new File(["content"], "photo.png", { type: "image/png" }),
        context.signal,
      );

      expect(context.store.get(canSendZeroChat$)).toBeTruthy();
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
                title: "Hello",
                agentId: "c0000000-0000-4000-a000-000000000001",
                createdAt: "2026-03-10T00:00:00Z",
                updatedAt: "2026-03-10T00:00:00Z",
              },
              {
                id: "t2",
                title: "World",
                agentId: "c0000000-0000-4000-a000-000000000001",
                createdAt: "2026-03-10T01:00:00Z",
                updatedAt: "2026-03-10T01:00:00Z",
              },
            ],
          });
        }),
      );

      await setup();

      await waitFor(async () => {
        const threads = await context.store.get(chatThreads$);
        expect(threads).toHaveLength(2);
        expect(threads[0]?.id).toBe("t1");
        expect(threads[1]?.title).toBe("World");
      });
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

      await waitFor(async () => {
        await context.store.get(chatThreads$);
        const url = new URL(capturedUrl);
        expect(url.searchParams.get("agentId")).toBe(
          "c0000000-0000-4000-a000-000000000001",
        );
      });
    });
  });

  describe("sendExistingThreadMessage$", () => {
    it("should send message on existing thread, poll to completion, and reload thread", async () => {
      let threadReloadCount = 0;

      server.use(
        http.get("*/api/zero/chat-threads", () => {
          return HttpResponse.json({ threads: [] });
        }),
        http.get("*/api/zero/chat-threads/:id", () => {
          threadReloadCount++;
          return HttpResponse.json({
            id: "thread-existing",
            title: null,
            agentId: "c0000000-0000-4000-a000-000000000001",
            chatMessages: [],
            latestSessionId: "session-existing",
            unsavedRuns: [],
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
          });
        }),
        http.post("*/api/zero/chat/messages", () => {
          return HttpResponse.json(
            {
              runId: "run-poll-1",
              threadId: "thread-existing",
              status: "running",
              createdAt: "2026-03-10T00:00:00Z",
            },
            { status: 201 },
          );
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
            id: "a0000000-0000-4000-a000-000000000098",
            sessionId: "session-existing",
            agentId: "zero",
            displayName: null,
            framework: "claude-code",
            modelProvider: null,
            selectedModel: null,
            triggerSource: "web",
            triggerAgentName: null,
            scheduleId: null,
            status: "completed",
            prompt: "test",
            appendSystemPrompt: null,
            error: null,
            createdAt: "2026-03-10T00:00:00Z",
            startedAt: "2026-03-10T00:00:01Z",
            completedAt: "2026-03-10T00:00:02Z",
            artifact: { name: null, version: null },
          });
        }),
      );

      // Set up on an existing thread URL so currentChatThreadId$ is pre-populated
      detachedSetupPage({
        context,
        path: "/chats/thread-existing",
        withoutRender: true,
      });

      await context.store.set(
        sendExistingThreadMessage$,
        "Hello",
        context.signal,
      );

      // Run loop must have completed
      await expect(context.store.get(allFinished$)).resolves.toBeTruthy();

      // finalizeCompletedRun$ must have invalidated the thread (at least one reload)
      expect(threadReloadCount).toBeGreaterThan(1);
    });

    it("should recover from transient network errors and complete polling via fibonacci backoff", async () => {
      let logsCallCount = 0;

      server.use(
        http.get("*/api/zero/chat-threads", () => {
          return HttpResponse.json({ threads: [] });
        }),
        http.get("*/api/zero/chat-threads/:id", () => {
          return HttpResponse.json({
            id: "thread-error-recovery",
            title: null,
            agentId: "c0000000-0000-4000-a000-000000000001",
            chatMessages: [],
            latestSessionId: "session-error-recovery",
            unsavedRuns: [],
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
          });
        }),
        http.post("*/api/zero/chat/messages", () => {
          return HttpResponse.json(
            {
              runId: "run-error-recovery",
              threadId: "thread-error-recovery",
              status: "running",
              createdAt: "2026-03-10T00:00:00Z",
            },
            { status: 201 },
          );
        }),
        http.get("*/api/zero/runs/:runId/telemetry/agent", () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            framework: "claude-code",
          });
        }),
        http.get("*/api/zero/logs/:runId", () => {
          logsCallCount++;
          // First call simulates a transient network error (500)
          if (logsCallCount === 1) {
            return HttpResponse.json(
              { error: "Internal Server Error" },
              { status: 500 },
            );
          }
          // Subsequent calls succeed with a completed run
          return HttpResponse.json({
            id: "a0000000-0000-4000-a000-000000000097",
            sessionId: "session-error-recovery",
            agentId: "zero",
            displayName: null,
            framework: "claude-code",
            modelProvider: null,
            selectedModel: null,
            triggerSource: "web",
            triggerAgentName: null,
            scheduleId: null,
            status: "completed",
            prompt: "test",
            appendSystemPrompt: null,
            error: null,
            createdAt: "2026-03-10T00:00:00Z",
            startedAt: "2026-03-10T00:00:01Z",
            completedAt: "2026-03-10T00:00:02Z",
            artifact: { name: null, version: null },
          });
        }),
      );

      detachedSetupPage({
        context,
        path: "/chats/thread-error-recovery",
        withoutRender: true,
      });

      await context.store.set(
        sendExistingThreadMessage$,
        "Hello",
        context.signal,
      );

      // Despite the first poll returning 500, setLoop retried via fibonacci backoff
      // and polling eventually completed
      await expect(context.store.get(allFinished$)).resolves.toBeTruthy();

      // The logs endpoint was called more than once: first call failed, subsequent succeeded
      expect(logsCallCount).toBeGreaterThan(1);
    });

    it("should not duplicate messages after run completes and server persists them", async () => {
      const RUN_ID = "a0000000-0000-4000-a000-000000000099";
      let threadLoadCount = 0;

      server.use(
        http.get("*/api/zero/chat-threads", () => {
          return HttpResponse.json({ threads: [] });
        }),
        http.get("*/api/zero/chat-threads/:id", () => {
          threadLoadCount++;
          // After initial load (empty), subsequent loads return persisted messages
          // simulating the server having persisted the session callback
          if (threadLoadCount <= 1) {
            return HttpResponse.json({
              id: "thread-dedup",
              title: null,
              agentId: "c0000000-0000-4000-a000-000000000001",
              chatMessages: [],
              latestSessionId: "session-dedup",
              unsavedRuns: [],
              createdAt: "2026-03-10T00:00:00Z",
              updatedAt: "2026-03-10T00:00:00Z",
            });
          }
          // After run completes, server returns persisted messages
          return HttpResponse.json({
            id: "thread-dedup",
            title: null,
            agentId: "c0000000-0000-4000-a000-000000000001",
            chatMessages: [
              {
                role: "user",
                content: "Hello dedup",
                createdAt: "2026-03-10T00:00:00Z",
              },
              {
                role: "assistant",
                content: "Hi there!",
                runId: RUN_ID,
                createdAt: "2026-03-10T00:00:01Z",
              },
            ],
            latestSessionId: "session-dedup",
            unsavedRuns: [],
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:01Z",
          });
        }),
        http.post("*/api/zero/chat/messages", () => {
          return HttpResponse.json(
            {
              runId: RUN_ID,
              threadId: "thread-dedup",
              status: "running",
              createdAt: "2026-03-10T00:00:00Z",
            },
            { status: 201 },
          );
        }),
        http.get("*/api/zero/runs/:runId/telemetry/agent", () => {
          return HttpResponse.json({
            events: [
              {
                id: "evt-1",
                sequenceNumber: 1,
                eventType: "result",
                eventData: { result: "Hi there!" },
                createdAt: "2026-03-10T00:00:01Z",
              },
            ],
            hasMore: false,
            framework: "claude-code",
          });
        }),
        http.get("*/api/zero/logs/:runId", () => {
          return HttpResponse.json({
            id: RUN_ID,
            sessionId: "session-dedup",
            agentId: "zero",
            displayName: null,
            framework: "claude-code",
            modelProvider: null,
            selectedModel: null,
            triggerSource: "web",
            triggerAgentName: null,
            scheduleId: null,
            status: "completed",
            prompt: "Hello dedup",
            appendSystemPrompt: null,
            error: null,
            createdAt: "2026-03-10T00:00:00Z",
            startedAt: "2026-03-10T00:00:00Z",
            completedAt: "2026-03-10T00:00:01Z",
            artifact: { name: null, version: null },
          });
        }),
      );

      detachedSetupPage({
        context,
        path: "/chats/thread-dedup",
        withoutRender: true,
      });

      await context.store.set(
        sendExistingThreadMessage$,
        "Hello dedup",
        context.signal,
      );

      await expect(context.store.get(allFinished$)).resolves.toBeTruthy();

      // After run completes, finalizeCompletedRun$ reloads the thread.
      // Server now returns persisted messages. The local optimistic messages
      // should be deduplicated against the server messages.
      const messages = await context.store.get(zeroChatMessages$);
      const userMessages = messages.filter((m) => {
        return m.role === "user";
      });
      const assistantMessages = messages.filter((m) => {
        return m.role === "assistant";
      });

      // There should be exactly one user message and one assistant message,
      // not duplicates from both server and local sources.
      expect(userMessages).toHaveLength(1);
      expect(assistantMessages).toHaveLength(1);
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
      expect(context.store.get(currentChatThreadId$)).toBeNull();
      await expect(context.store.get(allFinished$)).resolves.toBeTruthy();
    });

    it("should preserve attachments so they can be sent with the message", async () => {
      server.use(
        http.get("*/api/zero/chat-threads", () => {
          return HttpResponse.json({ threads: [] });
        }),
        http.post("*/api/zero/uploads", () => {
          return HttpResponse.json({
            id: "upload-1",
            filename: "test.png",
            contentType: "image/png",
            size: 1024,
            url: "https://example.com/test.png",
          });
        }),
      );
      await setup();

      await context.store.set(
        uploadZeroAttachment$,
        new File(["content"], "test.png", { type: "image/png" }),
        context.signal,
      );
      expect(context.store.get(zeroChatAttachments$)).toHaveLength(1);

      // Starting a new session must not clear the attachments
      context.store.set(startNewZeroSession$);

      expect(context.store.get(zeroChatAttachments$)).toHaveLength(1);
    });
  });

  describe("loadSessionFromSnapshot$", () => {
    it("should load session data from URL on route setup", async () => {
      server.use(
        http.get("*/api/zero/chat-threads/:id", () => {
          return HttpResponse.json({
            id: "url-thread",
            title: null,
            agentId: "c0000000-0000-4000-a000-000000000001",
            chatMessages: [
              {
                role: "user",
                content: "From URL",
                createdAt: "2026-03-10T00:00:00Z",
              },
            ],
            latestSessionId: "url-session",
            unsavedRuns: [],
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
          });
        }),
      );

      // Route setup calls loadSessionFromSnapshot$ which reads chatSessionSnapshot$
      detachedSetupPage({
        context,
        path: "/chats/url-thread",
        withoutRender: true,
      });

      expect(context.store.get(currentChatThreadId$)).toBe("url-thread");
      const messages = await context.store.get(zeroChatMessages$);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.role).toBe("user");
      if (messages[0]?.role === "user") {
        expect(messages[0].content).toBe("From URL");
      }
    });

    it("should return null for URL without session ID", () => {
      detachedSetupPage({
        context,
        path: "/chat",
        withoutRender: true,
      });

      expect(context.store.get(currentChatThreadId$)).toBeNull();
    });

    it("should skip load when messages are already present", async () => {
      let loadCount = 0;
      server.use(
        http.get("*/api/zero/chat-threads/:id", () => {
          loadCount++;
          return HttpResponse.json({
            id: "already-loaded",
            title: null,
            agentId: "c0000000-0000-4000-a000-000000000001",
            chatMessages: [
              {
                role: "user",
                content: "Existing msg",
                createdAt: "2026-03-10T00:00:00Z",
              },
            ],
            latestSessionId: null,
            unsavedRuns: [],
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
          });
        }),
      );

      // Route setup loads the thread
      detachedSetupPage({
        context,
        path: "/chats/already-loaded",
        withoutRender: true,
      });

      await expect(context.store.get(zeroChatMessages$)).resolves.toHaveLength(
        1,
      );
      const countAfterSetup = loadCount;

      // Second call skips because messages are already present
      await context.store.set(loadChatMessages$, context.signal);
      expect(loadCount).toBe(countAfterSetup);
    });
  });

  describe("createNewChatThread$", () => {
    it("should navigate to first thread when it has no title and matches agent", async () => {
      server.use(
        http.get("*/api/zero/chat-threads", () => {
          return HttpResponse.json({
            threads: [
              {
                id: "empty-thread-1",
                title: null,
                agentId: "c0000000-0000-4000-a000-000000000001",
                createdAt: "2026-03-10T00:00:00Z",
                updatedAt: "2026-03-10T00:00:00Z",
              },
              {
                id: "other-thread",
                title: null,
                agentId: "c0000000-0000-4000-a000-000000000001",
                createdAt: "2026-03-09T00:00:00Z",
                updatedAt: "2026-03-09T00:00:00Z",
              },
            ],
          });
        }),
      );

      await setup();

      await context.store.set(createNewChatThread$, null, context.signal);

      // Should navigate to the first empty thread, not the second
      expect(context.store.get(currentChatThreadId$)).toBe("empty-thread-1");
    });

    it("should create new thread when first thread has a title", async () => {
      server.use(
        http.get("*/api/zero/chat-threads", () => {
          return HttpResponse.json({
            threads: [
              {
                id: "titled-thread",
                title: "Existing chat",
                agentId: "c0000000-0000-4000-a000-000000000001",
                createdAt: "2026-03-10T00:00:00Z",
                updatedAt: "2026-03-10T00:00:00Z",
              },
            ],
          });
        }),
        http.post("*/api/zero/chat-threads", () => {
          return HttpResponse.json(
            {
              id: "new-thread-created",
              title: null,
              agentId: "c0000000-0000-4000-a000-000000000001",
              createdAt: "2026-03-10T01:00:00Z",
            },
            { status: 201 },
          );
        }),
      );

      await setup();

      await context.store.set(createNewChatThread$, null, context.signal);

      expect(context.store.get(currentChatThreadId$)).toBe(
        "new-thread-created",
      );
    });

    it("should create new thread when thread list is empty", async () => {
      server.use(
        http.get("*/api/zero/chat-threads", () => {
          return HttpResponse.json({ threads: [] });
        }),
        http.post("*/api/zero/chat-threads", () => {
          return HttpResponse.json(
            {
              id: "new-thread-empty-list",
              title: null,
              agentId: "c0000000-0000-4000-a000-000000000001",
              createdAt: "2026-03-10T01:00:00Z",
            },
            { status: 201 },
          );
        }),
      );

      await setup();

      await context.store.set(createNewChatThread$, null, context.signal);

      expect(context.store.get(currentChatThreadId$)).toBe(
        "new-thread-empty-list",
      );
    });

    it("should not navigate to second thread when first has a title", async () => {
      server.use(
        http.get("*/api/zero/chat-threads", () => {
          return HttpResponse.json({
            threads: [
              {
                id: "titled-thread",
                title: "Has messages",
                agentId: "c0000000-0000-4000-a000-000000000001",
                createdAt: "2026-03-10T01:00:00Z",
                updatedAt: "2026-03-10T01:00:00Z",
              },
              {
                id: "empty-second-thread",
                title: null,
                agentId: "c0000000-0000-4000-a000-000000000001",
                createdAt: "2026-03-10T00:00:00Z",
                updatedAt: "2026-03-10T00:00:00Z",
              },
            ],
          });
        }),
        http.post("*/api/zero/chat-threads", () => {
          return HttpResponse.json(
            {
              id: "brand-new-thread",
              title: null,
              agentId: "c0000000-0000-4000-a000-000000000001",
              createdAt: "2026-03-10T02:00:00Z",
            },
            { status: 201 },
          );
        }),
      );

      await setup();

      await context.store.set(createNewChatThread$, null, context.signal);

      // Should NOT navigate to empty-second-thread; should create brand new
      expect(context.store.get(currentChatThreadId$)).toBe("brand-new-thread");
    });
  });

  describe("attachment upload and cancel", () => {
    function useUploadHandler(options?: {
      deferred?: ReturnType<typeof createDeferredPromise<void>>;
    }) {
      server.use(
        http.get("*/api/zero/chat-threads", () => {
          return HttpResponse.json({ threads: [] });
        }),
        http.post("*/api/zero/uploads", async () => {
          if (options?.deferred) {
            await options.deferred.promise;
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
      const info = await context.store.get(attachments[0]!.fileInfo$);
      expect(info?.url).toBe("https://example.com/test.png");
      expect(info?.id).toBe("upload-1");
    });

    it("should cancel an in-flight upload and remove the attachment", async () => {
      const uploadDeferred = createDeferredPromise<void>(context.signal);
      useUploadHandler({ deferred: uploadDeferred });
      await setup();

      const uploadPromise = context.store.set(
        uploadZeroAttachment$,
        createTestFile(),
        context.signal,
      );

      // Wait for the placeholder to appear
      await vi.waitFor(() => {
        expect(context.store.get(zeroChatAttachments$)).toHaveLength(1);
      });

      const before = context.store.get(zeroChatAttachments$);

      // Cancel via removeZeroAttachment$ (which internally calls cancel$)
      context.store.set(removeZeroAttachment$, before[0]!);

      await expect(uploadPromise).rejects.toThrow();

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

      context.store.set(removeZeroAttachment$, attachments[0]!);

      expect(context.store.get(zeroChatAttachments$)).toHaveLength(0);
    });

    it("should include talk page attachments in the sent message", async () => {
      let capturedBody: unknown = null;

      server.use(
        http.get("*/api/zero/chat-threads", () => {
          return HttpResponse.json({ threads: [] });
        }),
        http.post("*/api/zero/uploads", () => {
          return HttpResponse.json({
            id: "upload-att-1",
            filename: "report.pdf",
            contentType: "application/pdf",
            size: 2048,
            url: "https://example.com/report.pdf",
          });
        }),
        http.post("*/api/zero/chat-threads", () => {
          return HttpResponse.json(
            {
              id: "thread-attach-1",
              title: null,
              agentId: "c0000000-0000-4000-a000-000000000001",
              createdAt: "2026-03-10T00:00:00Z",
            },
            { status: 201 },
          );
        }),
        http.post("*/api/zero/chat/messages", async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json(
            {
              runId: "run-attach-1",
              threadId: "thread-attach-1",
              status: "pending",
              createdAt: "2026-03-10T00:00:00Z",
            },
            { status: 201 },
          );
        }),
      );

      await setup();

      await context.store.set(
        uploadZeroAttachment$,
        new File(["content"], "report.pdf", { type: "application/pdf" }),
        context.signal,
      );
      expect(context.store.get(zeroChatAttachments$)).toHaveLength(1);

      // Simulate handleSendMessage: startNewSession then sendNewThread
      context.store.set(startNewZeroSession$);
      await context.store.set(
        sendNewThreadMessage$,
        "c0000000-0000-4000-a000-000000000001",
        "Check this file",
        context.signal,
      );

      // The sent prompt should include the attachment
      expect(capturedBody).toBeDefined();
      expect(JSON.stringify(capturedBody)).toContain(
        "https://example.com/report.pdf",
      );
      expect(JSON.stringify(capturedBody)).toContain("report.pdf");

      // Attachments should be cleared after the send
      expect(context.store.get(zeroChatAttachments$)).toHaveLength(0);
    });

    it("should send image-only message (no text, attachment only)", async () => {
      interface CapturedChatBody {
        prompt: string;
        hasTextContent: boolean;
      }

      function isCapturedChatBody(v: unknown): v is CapturedChatBody {
        return (
          typeof v === "object" &&
          v !== null &&
          "prompt" in v &&
          typeof (v as Record<string, unknown>).prompt === "string"
        );
      }

      let capturedBody: unknown = null;

      server.use(
        http.get("*/api/zero/chat-threads", () => {
          return HttpResponse.json({ threads: [] });
        }),
        http.post("*/api/zero/uploads", () => {
          return HttpResponse.json({
            id: "upload-img-1",
            filename: "photo.png",
            contentType: "image/png",
            size: 2048,
            url: "https://example.com/photo.png",
          });
        }),
        http.post("*/api/zero/chat-threads", () => {
          return HttpResponse.json(
            {
              id: "thread-img-1",
              title: null,
              agentId: "c0000000-0000-4000-a000-000000000001",
              createdAt: "2026-03-10T00:00:00Z",
            },
            { status: 201 },
          );
        }),
        http.post("*/api/zero/chat/messages", async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json(
            {
              runId: "run-img-1",
              threadId: "thread-img-1",
              status: "pending",
              createdAt: "2026-03-10T00:00:00Z",
            },
            { status: 201 },
          );
        }),
      );

      await setup();

      // Upload image attachment
      await context.store.set(
        uploadZeroAttachment$,
        new File(["img"], "photo.png", { type: "image/png" }),
        context.signal,
      );
      expect(context.store.get(zeroChatAttachments$)).toHaveLength(1);

      // Send with empty text (image-only)
      context.store.set(startNewZeroSession$);
      await context.store.set(
        sendNewThreadMessage$,
        "c0000000-0000-4000-a000-000000000001",
        "",
        context.signal,
      );

      // API should receive non-empty prompt (attachment markdown)
      assert(isCapturedChatBody(capturedBody));
      expect(capturedBody.prompt).toContain("https://example.com/photo.png");
      expect(capturedBody.prompt).toContain("photo.png");
      expect(capturedBody.prompt).not.toMatch(/^\n/);

      // Attachments should be cleared after send
      expect(context.store.get(zeroChatAttachments$)).toHaveLength(0);
    });

    it("should cancel one upload without affecting others", async () => {
      let requestCount = 0;
      const uploadDeferreds: ReturnType<typeof createDeferredPromise<void>>[] =
        [];
      server.use(
        http.get("*/api/zero/chat-threads", () => {
          return HttpResponse.json({ threads: [] });
        }),
        http.post("*/api/zero/uploads", async () => {
          requestCount++;
          const currentCount = requestCount;
          const deferred = createDeferredPromise<void>(context.signal);
          uploadDeferreds.push(deferred);
          await deferred.promise;
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

      // Wait for background bootstrap to complete the home-page redirect
      // and agent chat page setup (which clears the talk draft on entrance).
      // chatThreads$ resolves only after the agent ID is set and the API is called.
      await waitFor(async () => {
        const threads = await context.store.get(chatThreads$);
        expect(threads).toHaveLength(0);
      });

      const promise1 = context.store.set(
        uploadZeroAttachment$,
        createTestFile("file-a.png"),
        context.signal,
      );
      const promise2 = context.store.set(
        uploadZeroAttachment$,
        createTestFile("file-b.png"),
        context.signal,
      );

      // Wait for both requests to reach the MSW handler
      await vi.waitFor(() => {
        expect(uploadDeferreds).toHaveLength(2);
      });

      await vi.waitFor(() => {
        expect(context.store.get(zeroChatAttachments$)).toHaveLength(2);
      });

      const before = context.store.get(zeroChatAttachments$);
      context.store.set(removeZeroAttachment$, before[0]!);

      // Release both upload deferreds so the surviving upload can complete
      for (const d of uploadDeferreds) {
        if (!d.settled()) {
          d.resolve();
        }
      }

      await Promise.allSettled([promise1, promise2]);

      const after = context.store.get(zeroChatAttachments$);
      // Only the second upload should remain, completed
      expect(after).toHaveLength(1);
      const info = await context.store.get(after[0]!.fileInfo$);
      expect(info?.url).toContain("example.com");
    });
  });
});
