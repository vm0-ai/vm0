import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  currentChatThreadSignals$,
  setDraftSyncDebounceMs$,
} from "../create-chat-thread.ts";

const context = testContext();

/**
 * Base MSW handlers required for setupChatPage$ to complete:
 * - GET /api/zero/chat-threads — sidebar thread list
 * - GET /api/zero/chat-threads/:id — thread detail (no active runs)
 * - GET /api/zero/agents/:id — agent info
 */
function setupBaseHandlers(threadId: string) {
  server.use(
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
    http.get(`*/api/zero/chat-threads/${threadId}`, () => {
      return HttpResponse.json({
        id: threadId,
        title: null,
        agentId: "c0000000-0000-4000-a000-000000000001",
        chatMessages: [],
        latestSessionId: null,
        unsavedRuns: [],
        draftContent: null,
        draftAttachments: null,
        createdAt: "2026-04-13T00:00:00Z",
        updatedAt: "2026-04-13T00:00:00Z",
      });
    }),
  );
}

describe("createDraftSync — scheduleDraftSync$, cancelDraftSync$, flushDraftClear$", () => {
  beforeEach(() => {
    // Override debounce delay to 0 so tests resolve without fake timers.
    context.store.set(setDraftSyncDebounceMs$, 0);
  });

  describe("scheduleDraftSync$", () => {
    it("should PATCH the server with the current draft after debounce", async () => {
      const threadId = "thread-draft-sync-1";
      let patchBody: unknown = null;

      server.use(
        http.patch(
          `*/api/zero/chat-threads/${threadId}`,
          async ({ request }) => {
            patchBody = await request.json();
            return new HttpResponse(null, { status: 204 });
          },
        ),
      );
      setupBaseHandlers(threadId);

      await setupPage({
        context,
        path: `/chats/${threadId}`,
        withoutRender: true,
      });

      const thread = context.store.get(currentChatThreadSignals$);
      expect(thread).not.toBeNull();

      // Set draft input so the PATCH has content to sync
      context.store.set(thread!.draft.setInput$, "hello world");

      // Schedule a debounced sync (debounce is 0ms in tests)
      context.store.set(thread!.scheduleDraftSync$, context.signal);

      // Wait for the PATCH to arrive
      await expect
        .poll(
          () => {
            return patchBody;
          },
          { timeout: 1000 },
        )
        .not.toBeNull();

      expect(patchBody).toMatchObject({
        draftContent: "hello world",
        draftAttachments: null,
      });
    });

    it("should debounce: only the last call triggers PATCH", async () => {
      const threadId = "thread-draft-sync-2";
      let patchCount = 0;

      server.use(
        http.patch(`*/api/zero/chat-threads/${threadId}`, () => {
          patchCount++;
          return new HttpResponse(null, { status: 204 });
        }),
      );
      setupBaseHandlers(threadId);

      await setupPage({
        context,
        path: `/chats/${threadId}`,
        withoutRender: true,
      });

      const thread = context.store.get(currentChatThreadSignals$)!;

      // Schedule sync, then schedule again immediately to reset the timer.
      // The first signal is aborted synchronously before its setTimeout(0) fires.
      context.store.set(thread.draft.setInput$, "first");
      context.store.set(thread.scheduleDraftSync$, context.signal);

      // Second call resets the debounce (aborts the first timer)
      context.store.set(thread.draft.setInput$, "second");
      context.store.set(thread.scheduleDraftSync$, context.signal);

      // Wait for exactly one PATCH from the second call
      await expect
        .poll(
          () => {
            return patchCount;
          },
          { timeout: 1000 },
        )
        .toBe(1);
    });

    it("should send null draft content when input is empty", async () => {
      const threadId = "thread-draft-sync-empty";
      let patchBody: unknown = null;

      server.use(
        http.patch(
          `*/api/zero/chat-threads/${threadId}`,
          async ({ request }) => {
            patchBody = await request.json();
            return new HttpResponse(null, { status: 204 });
          },
        ),
      );
      setupBaseHandlers(threadId);

      await setupPage({
        context,
        path: `/chats/${threadId}`,
        withoutRender: true,
      });

      const thread = context.store.get(currentChatThreadSignals$)!;

      // Leave input empty — should send null draftContent
      context.store.set(thread.scheduleDraftSync$, context.signal);

      await expect
        .poll(
          () => {
            return patchBody;
          },
          { timeout: 1000 },
        )
        .not.toBeNull();

      expect(patchBody).toMatchObject({
        draftContent: null,
        draftAttachments: null,
      });
    });
  });
});
