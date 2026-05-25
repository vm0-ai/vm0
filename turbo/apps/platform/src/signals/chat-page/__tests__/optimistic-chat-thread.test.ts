import { describe, it, expect } from "vitest";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  chatThreadsContract,
  chatThreadByIdContract,
  chatThreadMessagesContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { createDeferredPromise, detach, Reason } from "../../utils.ts";
import {
  createNewChatThreadOptimistically$,
  optimisticChatThread$,
} from "../optimistic-chat-thread-page.ts";

const context = testContext();
const mockApi = createMockApi(context);

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

function setupBaseHandlers() {
  server.use(
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, {
        pinned: [],
        threads: [],
        hasMore: false,
        nextCursor: null,
        totalCount: 0,
      });
    }),
    mockApi(chatThreadMessagesContract.list, ({ respond }) => {
      return respond(200, { messages: [] });
    }),
    mockApi(chatThreadByIdContract.get, ({ params, respond }) => {
      return respond(200, {
        id: params.id,
        title: null,
        agentId: AGENT_ID,
        latestSessionId: null,
        activeRunIds: [],
        draftContent: null,
        draftAttachments: null,
        createdAt: "2026-04-13T00:00:00Z",
        updatedAt: "2026-04-13T00:00:00Z",
      });
    }),
  );
}

describe("optimistic chat thread (local mode)", () => {
  it("exposes a placeholder thread with empty active runs and zero messages", async () => {
    setupBaseHandlers();
    // Hold create open so the optimistic entry stays around for assertions.
    const createDeferred = createDeferredPromise<void>(context.signal);
    server.use(
      mockApi(chatThreadsContract.create, async ({ body, respond }) => {
        await createDeferred.promise;
        return respond(201, {
          id: body.clientThreadId ?? "fallback-thread-id",
          title: null,
          createdAt: "2026-04-13T00:00:00Z",
        });
      }),
    );

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      withoutRender: true,
    });

    detach(
      context.store.set(
        createNewChatThreadOptimistically$,
        AGENT_ID,
        "main",
        context.signal,
      ),
      Reason.DomCallback,
    );

    const pending = await expect
      .poll(() => {
        return context.store.get(optimisticChatThread$);
      })
      .not.toBeNull();
    void pending;

    const optimistic = context.store.get(optimisticChatThread$)!;
    const threadData = await context.store.get(
      optimistic.pendingThread.threadData$,
    );
    expect(threadData).toMatchObject({
      id: optimistic.threadId,
      title: null,
      agentId: AGENT_ID,
      activeRunIds: [],
      activeRuns: [],
      isLegacySession: false,
      draftContent: null,
      draftAttachments: null,
      modelProviderId: null,
      selectedModel: null,
    });

    const initiallyFinished = await context.store.get(
      optimistic.pendingThread.allFinished$,
    );
    expect(initiallyFinished).toBeTruthy();

    createDeferred.resolve();
  });

  it("flips allFinished$ to true when cancelRun$ runs against a pending optimistic thread", async () => {
    setupBaseHandlers();
    const createDeferred = createDeferredPromise<void>(context.signal);
    server.use(
      mockApi(chatThreadsContract.create, async ({ body, respond }) => {
        await createDeferred.promise;
        return respond(201, {
          id: body.clientThreadId ?? "fallback-thread-id",
          title: null,
          createdAt: "2026-04-13T00:00:00Z",
        });
      }),
    );

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      withoutRender: true,
    });

    detach(
      context.store.set(
        createNewChatThreadOptimistically$,
        AGENT_ID,
        "main",
        context.signal,
      ),
      Reason.DomCallback,
    );

    await expect
      .poll(() => {
        return context.store.get(optimisticChatThread$);
      })
      .not.toBeNull();

    const optimistic = context.store.get(optimisticChatThread$)!;
    await context.store.set(
      optimistic.pendingThread.cancelRun$,
      context.signal,
    );

    const finished = await context.store.get(
      optimistic.pendingThread.allFinished$,
    );
    expect(finished).toBeTruthy();

    createDeferred.resolve();
  });

  it("does not PATCH the server when scheduleDraftSync$ runs on a local thread", async () => {
    setupBaseHandlers();
    let patchCount = 0;
    const createDeferred = createDeferredPromise<void>(context.signal);
    server.use(
      mockApi(chatThreadByIdContract.patch, ({ respond }) => {
        patchCount++;
        return respond(204);
      }),
      mockApi(chatThreadsContract.create, async ({ body, respond }) => {
        await createDeferred.promise;
        return respond(201, {
          id: body.clientThreadId ?? "fallback-thread-id",
          title: null,
          createdAt: "2026-04-13T00:00:00Z",
        });
      }),
    );

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      withoutRender: true,
    });

    detach(
      context.store.set(
        createNewChatThreadOptimistically$,
        AGENT_ID,
        "main",
        context.signal,
      ),
      Reason.DomCallback,
    );

    await expect
      .poll(() => {
        return context.store.get(optimisticChatThread$);
      })
      .not.toBeNull();

    const optimistic = context.store.get(optimisticChatThread$)!;
    context.store.set(
      optimistic.pendingThread.draft.setInput$,
      "draft text that should not reach the server",
    );
    await context.store.set(
      optimistic.pendingThread.scheduleDraftSync$,
      context.signal,
    );

    expect(patchCount).toBe(0);

    createDeferred.resolve();
  });
});
