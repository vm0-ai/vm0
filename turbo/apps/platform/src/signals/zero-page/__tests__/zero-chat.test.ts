import { describe, it, expect } from "vitest";
import { delay } from "signal-timers";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  zeroChatMessages$,
  allFinished$,
  zeroChatInput$,
  zeroSessionList$,
  zeroSessionListLoading$,
  zeroSessionListError$,
  zeroSessionError$,
  setZeroChatInput$,
  clearZeroChatInput$,
  switchZeroSession$,
  startNewZeroSession$,
  sendZeroChatMessage$,
  prepareSessionSwitch$,
  loadSessionFromSnapshot$,
  chatSessionSnapshot$,
  zeroChatAttachments$,
  uploadZeroAttachment$,
  removeZeroAttachment$,
} from "../zero-chat.ts";
import { chatThreadId$ } from "../zero-nav.ts";

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
  let runAssociated = false;

  server.use(
    http.post("*/api/zero/chat-threads", () => {
      return HttpResponse.json(
        { id: "thread-1", createdAt: "2026-03-10T00:00:00Z" },
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
        unsavedRuns: runAssociated
          ? [
              {
                runId: "run-1",
                status: "running",
                prompt: "Hello",
                error: null,
              },
            ]
          : [],
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

      const threads = await context.store.get(zeroSessionList$);
      expect(threads).toHaveLength(2);
      expect(threads[0]?.id).toBe("t1");
      expect(threads[1]?.preview).toBe("World");
      expect(context.store.get(zeroSessionListLoading$)).toBeFalsy();
      expect(context.store.get(zeroSessionListError$)).toBeNull();
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

      await context.store.get(zeroSessionList$);

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

      expect(context.store.get(chatThreadId$)).toBe("thread-abc");

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
      await expect(context.store.get(allFinished$)).resolves.toBeTruthy();
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
      expect(context.store.get(chatThreadId$)).toBeNull();
      await expect(context.store.get(allFinished$)).resolves.toBeTruthy();
      expect(context.store.get(zeroChatInput$)).toBe("");
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

      expect(context.store.get(chatThreadId$)).toBe("url-thread");
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

      expect(context.store.get(chatThreadId$)).toBeNull();
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
      const info = await context.store.get(attachments[0]!.fileInfo$);
      expect(info?.url).toBe("https://example.com/test.png");
      expect(info?.id).toBe("upload-1");
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

      // Cancel via removeZeroAttachment$ (which internally calls cancel$)
      context.store.set(removeZeroAttachment$, before[0]!);

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

      context.store.set(removeZeroAttachment$, attachments[0]!);

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

      // Cancel the first upload via removeZeroAttachment$ (which calls cancel$)
      context.store.set(removeZeroAttachment$, before[0]!);

      await Promise.all([promise1, promise2]);

      const after = context.store.get(zeroChatAttachments$);
      // Only the second upload should remain, completed
      expect(after).toHaveLength(1);
      const info = await context.store.get(after[0]!.fileInfo$);
      expect(info?.url).toContain("example.com");
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
