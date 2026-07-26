import { command, computed } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { waitFor } from "@testing-library/react";
import { platformRealtimeTokenContract } from "@vm0/api-contracts/contracts/realtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearMockedAuth,
  mockOrganization,
  mockUser,
} from "../../__tests__/mock-auth.ts";
import {
  setupRealtime$,
  setAblyLoop$,
  setAblyMessageLoop$,
  setAblyPayloadLoop$,
} from "../realtime.ts";
import { createChatThreadSignals } from "../chat-page/create-chat-thread.ts";
import type { SubscribeRealtimeArgs } from "../chat-page/chat-thread-data-source.ts";
import { createRemoteChatThreadDataSource } from "../chat-page/remote-chat-thread-data-source.ts";
import { createDeferredPromise } from "../utils.ts";
import { createDraftSignals } from "../zero-page/chat-draft.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

type ChatThreadRemote = ReturnType<typeof createRemoteChatThreadDataSource>;

const finishLoop$ = command((_ctx, _signal: AbortSignal) => {
  return true;
});

const keepAliveLoop$ = command((_ctx, _signal: AbortSignal) => {
  return Promise.resolve(false);
});

const keepAlivePayloadLoop$ = command(
  (_ctx, _payload: unknown, _signal: AbortSignal) => {
    return false;
  },
);

const failReadyCatchup$ = command((_ctx, _signal: AbortSignal) => {
  throw new Error("ready catchup should not run");
});

const failReadyCatchupAfterReady$ = command((_ctx, _signal: AbortSignal) => {
  throw new Error("ready catchup failed");
});

const waitForReadyCatchupAbort$ = command((_ctx, signal: AbortSignal) => {
  return createDeferredPromise<void>(signal).promise;
});

function mockSignedInUser(): void {
  mockUser(
    {
      id: "test-user-123",
      fullName: "Test User",
      email: "test@example.com",
    },
    { token: "test-token" },
  );
  mockOrganization({
    activeOrg: { id: "test-org-123", name: "Test Organization" },
    memberships: [{ id: "test-org-123" }],
  });
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function chatThreadRealtimeTopics(threadId: string): readonly string[] {
  return [
    `chatThreadAutomationsChanged:${threadId}`,
    `chatThreadArtifactsChanged:${threadId}`,
    `chatThreadWorkflowsChanged:${threadId}`,
    `chatThreadWorkflowQueueChanged:${threadId}`,
  ];
}

function expectNoChatThreadSubscriptions(threadId: string): void {
  for (const topic of chatThreadRealtimeTopics(threadId)) {
    expect(context.mocks.ably.hasSubscription(topic)).toBeFalsy();
  }
  expect(
    context.mocks.ably.hasSubscription(`chatThreadMessageCreated:${threadId}`),
  ).toBeFalsy();
}

function expectChatThreadSubscriptions(threadId: string): void {
  for (const topic of chatThreadRealtimeTopics(threadId)) {
    expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
  }
  expect(
    context.mocks.ably.hasSubscription(`chatThreadMessageCreated:${threadId}`),
  ).toBeFalsy();
}

function abortListenerCallCount(calls: readonly unknown[][]): number {
  return calls.filter((call) => {
    return call[0] === "abort";
  }).length;
}

function unexpectedDataSourceCall(name: string): never {
  throw new Error(`Unexpected data source call: ${name}`);
}

function createFailingSubscribeDataSource(): ChatThreadRemote {
  return {
    threadDraft$: computed(() => {
      return Promise.resolve({
        draftContent: null,
        draftAttachments: null,
      });
    }),
    patchDraft$: command(() => {
      return unexpectedDataSourceCall("patchDraft$");
    }),
    patchModelSelection$: command(() => {
      return unexpectedDataSourceCall("patchModelSelection$");
    }),
    patchComputerUseHost$: command(() => {
      return unexpectedDataSourceCall("patchComputerUseHost$");
    }),
    appendQueuedMessage$: command(() => {
      return unexpectedDataSourceCall("appendQueuedMessage$");
    }),
    recallMessage$: command(() => {
      return unexpectedDataSourceCall("recallMessage$");
    }),
    listMessagesAfter$: command(() => {
      return Promise.resolve({
        messages: [],
        hasHistoryBefore: false,
      });
    }),
    listMessagesBefore$: command(() => {
      return unexpectedDataSourceCall("listMessagesBefore$");
    }),
    cancelRuns$: command(() => {
      return unexpectedDataSourceCall("cancelRuns$");
    }),
    markRead$: command(() => {
      return unexpectedDataSourceCall("markRead$");
    }),
    subscribeRealtime$: command(
      async (_ctx, _args: SubscribeRealtimeArgs, signal: AbortSignal) => {
        await waitFor(() => {
          expect(
            context.mocks.ably.hasSubscription("computerUseHostsChanged"),
          ).toBeTruthy();
        });
        signal.throwIfAborted();
        throw new Error("chat realtime failed");
      },
    ),
  };
}

describe("realtime signals", () => {
  afterEach(() => {
    clearMockedAuth();
  });

  it("resolves a pending loop after realtime setup connects", async () => {
    mockSignedInUser();
    const topic = "test:pending-resolve";
    let runs = 0;
    const loop$ = command((_ctx, _signal: AbortSignal) => {
      runs += 1;
      return true;
    });

    const loopPromise = context.store.set(
      setAblyLoop$,
      {
        topic,
        loopCommand$: loop$,
      },
      context.signal,
    );
    expect(context.mocks.ably.hasSubscription(topic)).toBeFalsy();

    await context.store.set(setupRealtime$, context.signal);

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    context.mocks.ably.trigger(topic);

    await expect(loopPromise).resolves.toBeUndefined();
    expect(runs).toBe(1);
    expect(context.mocks.ably.hasSubscription(topic)).toBeFalsy();
  });

  it("removes and rejects a pending loop when the subscriber aborts", async () => {
    mockSignedInUser();
    const topic = "test:pending-abort";
    const subscriber = new AbortController();

    const loopPromise = context.store.set(
      setAblyLoop$,
      {
        topic,
        loopCommand$: finishLoop$,
      },
      subscriber.signal,
    );

    subscriber.abort(abortError("subscriber aborted"));

    await expect(loopPromise).rejects.toMatchObject({ name: "AbortError" });
    await context.store.set(setupRealtime$, context.signal);
    expect(context.mocks.ably.hasSubscription(topic)).toBeFalsy();
  });

  it("rejects pending loops when realtime auth fails", async () => {
    mockSignedInUser();
    context.mocks.api(platformRealtimeTokenContract.create, ({ respond }) => {
      return respond(500, {
        error: {
          message: "realtime token unavailable",
          code: "INTERNAL_SERVER_ERROR",
        },
      });
    });

    const topic = "test:auth-failure";
    const loopPromise = context.store.set(
      setAblyLoop$,
      {
        topic,
        loopCommand$: finishLoop$,
      },
      context.signal,
    );
    const setupPromise = context.store.set(setupRealtime$, context.signal);

    await expect(setupPromise).rejects.toThrow(/Ably connection failed/);
    await expect(loopPromise).rejects.toThrow(/Ably connection failed/);
    expect(context.mocks.ably.hasSubscription(topic)).toBeFalsy();
  });

  it("cleans up a loop subscription when abort races subscribe resolution", async () => {
    mockSignedInUser();
    const topic = "test:subscribe-abort-race";
    const subscriber = new AbortController();

    await context.store.set(setupRealtime$, context.signal);
    const loopPromise = context.store.set(
      setAblyLoop$,
      {
        topic,
        loopCommand$: finishLoop$,
      },
      subscriber.signal,
    );
    subscriber.abort(abortError("subscriber aborted"));

    await expect(loopPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(context.mocks.ably.hasSubscription(topic)).toBeFalsy();
  });

  it("cleans up a payload subscription when abort races subscribe resolution", async () => {
    mockSignedInUser();
    const topic = "test:payload-subscribe-abort-race";
    const subscriber = new AbortController();

    await context.store.set(setupRealtime$, context.signal);
    const loopPromise = context.store.set(
      setAblyPayloadLoop$,
      {
        topic,
        loopCommand$: keepAlivePayloadLoop$,
      },
      subscriber.signal,
    );
    subscriber.abort(abortError("subscriber aborted"));

    await expect(loopPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(context.mocks.ably.hasSubscription(topic)).toBeFalsy();
  });

  it("cleans up a payload subscription when channel attach fails", async () => {
    mockSignedInUser();
    const topic = "test:payload-subscribe-failure";

    await context.store.set(setupRealtime$, context.signal);
    context.mocks.ably.rejectNextSubscribe("Connection closed");

    await expect(
      context.store.set(
        setAblyPayloadLoop$,
        {
          topic,
          loopCommand$: keepAlivePayloadLoop$,
        },
        context.signal,
      ),
    ).resolves.toBeUndefined();
    expect(context.mocks.ably.hasSubscription(topic)).toBeFalsy();
  });

  it("reruns an active loop on reconnect", async () => {
    mockSignedInUser();
    const topic = "test:reconnect";
    const subscriber = new AbortController();
    let runs = 0;
    const loop$ = command((_ctx, _signal: AbortSignal) => {
      runs += 1;
      return false;
    });

    await context.store.set(setupRealtime$, context.signal);
    const loopPromise = context.store.set(
      setAblyLoop$,
      {
        topic,
        loopCommand$: loop$,
      },
      subscriber.signal,
    );

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    context.mocks.ably.trigger(topic);
    await waitFor(() => {
      expect(runs).toBe(1);
    });

    context.mocks.ably.triggerReconnect();
    await waitFor(() => {
      expect(runs).toBe(2);
    });

    subscriber.abort(abortError("test done"));
    await expect(loopPromise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reruns a loop for a notification received while the handler is in flight", async () => {
    mockSignedInUser();
    const topic = "test:in-flight-notification";
    const firstRunCanFinish = context.mocks.deferred<void>();
    let runs = 0;
    const loop$ = command(async (_ctx, signal: AbortSignal) => {
      runs += 1;
      if (runs === 1) {
        await firstRunCanFinish.promise;
        signal.throwIfAborted();
        return false;
      }
      return true;
    });

    await context.store.set(setupRealtime$, context.signal);
    const loopPromise = context.store.set(
      setAblyLoop$,
      {
        topic,
        loopCommand$: loop$,
      },
      context.signal,
    );

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    context.mocks.ably.trigger(topic);
    await waitFor(() => {
      expect(runs).toBe(1);
    });

    context.mocks.ably.trigger(topic);
    firstRunCanFinish.resolve();

    await expect(loopPromise).resolves.toBeUndefined();
    expect(runs).toBe(2);
  });

  it("retries an active loop after a transient handler error", async () => {
    mockSignedInUser();
    const topic = "test:transient-loop-error";
    let runs = 0;
    const loop$ = command((_ctx, _signal: AbortSignal) => {
      runs += 1;
      if (runs === 1) {
        throw new Error("temporary loop failure");
      }
      return true;
    });

    await context.store.set(setupRealtime$, context.signal);
    const loopPromise = context.store.set(
      setAblyLoop$,
      {
        topic,
        loopCommand$: loop$,
      },
      context.signal,
    );

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    context.mocks.ably.trigger(topic);

    await expect(loopPromise).resolves.toBeUndefined();
    expect(runs).toBe(2);
  });

  it("removes settled realtime wait abort listeners between notifications", async () => {
    mockSignedInUser();
    const topic = "test:listener-cleanup";
    const subscriber = new AbortController();
    const addListener = vi.spyOn(subscriber.signal, "addEventListener");
    const removeListener = vi.spyOn(subscriber.signal, "removeEventListener");
    let runs = 0;
    const loop$ = command((_ctx, _signal: AbortSignal) => {
      runs += 1;
      return false;
    });

    await context.store.set(setupRealtime$, context.signal);
    const loopPromise = context.store.set(
      setAblyLoop$,
      {
        topic,
        loopCommand$: loop$,
      },
      subscriber.signal,
    );

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    const removesAfterSubscribe = abortListenerCallCount(
      removeListener.mock.calls,
    );

    for (let i = 0; i < 5; i++) {
      context.mocks.ably.trigger(topic);
      await waitFor(() => {
        expect(runs).toBe(i + 1);
      });
    }

    expect(
      abortListenerCallCount(removeListener.mock.calls),
    ).toBeGreaterThanOrEqual(removesAfterSubscribe + 5);

    subscriber.abort(abortError("test done"));
    await expect(loopPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(
      abortListenerCallCount(removeListener.mock.calls),
    ).toBeGreaterThanOrEqual(abortListenerCallCount(addListener.mock.calls));
  });

  it("passes Ably payloads to payload loops", async () => {
    mockSignedInUser();
    const topic = "test:payload";
    const subscriber = new AbortController();
    const payloads: unknown[] = [];
    const loop$ = command((_ctx, payload: unknown, _signal: AbortSignal) => {
      payloads.push(payload);
      return false;
    });

    await context.store.set(setupRealtime$, context.signal);
    const loopPromise = context.store.set(
      setAblyPayloadLoop$,
      {
        topic,
        loopCommand$: loop$,
      },
      subscriber.signal,
    );

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    context.mocks.ably.trigger(topic, { threadId: "thread-1" });

    await waitFor(() => {
      expect(payloads).toStrictEqual([{ threadId: "thread-1" }]);
    });

    subscriber.abort(abortError("test done"));
    await expect(loopPromise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("serializes user-channel messages received while the handler is in flight", async () => {
    mockSignedInUser();
    const subscriber = new AbortController();
    const firstRunCanFinish = context.mocks.deferred<void>();
    const handledNames: (string | undefined)[] = [];
    let activeHandlers = 0;
    let maxActiveHandlers = 0;
    const loop$ = command(
      async (_ctx, message: unknown, signal: AbortSignal): Promise<boolean> => {
        activeHandlers += 1;
        maxActiveHandlers = Math.max(maxActiveHandlers, activeHandlers);
        handledNames.push(
          typeof message === "object" &&
            message !== null &&
            "name" in message &&
            typeof message.name === "string"
            ? message.name
            : undefined,
        );
        if (handledNames.length === 1) {
          await firstRunCanFinish.promise;
          signal.throwIfAborted();
        }
        activeHandlers -= 1;
        return false;
      },
    );

    await context.store.set(setupRealtime$, context.signal);
    const loopPromise = context.store.set(
      setAblyMessageLoop$,
      { loopCommand$: loop$ },
      subscriber.signal,
    );

    await waitFor(() => {
      expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
    });
    context.mocks.ably.trigger("chatThreadMessageCreated:thread-1");
    await waitFor(() => {
      expect(handledNames).toStrictEqual(["chatThreadMessageCreated:thread-1"]);
    });

    context.mocks.ably.trigger("chatThreadMessageCreated:thread-2");
    expect(handledNames).toStrictEqual(["chatThreadMessageCreated:thread-1"]);
    firstRunCanFinish.resolve();

    await waitFor(() => {
      expect(handledNames).toStrictEqual([
        "chatThreadMessageCreated:thread-1",
        "chatThreadMessageCreated:thread-2",
      ]);
    });
    expect(maxActiveHandlers).toBe(1);

    subscriber.abort(abortError("test done"));
    await expect(loopPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(context.mocks.ably.hasChannelSubscription()).toBeFalsy();
  });

  it("runs user-channel catch-up on reconnect without a queued message", async () => {
    mockSignedInUser();
    const subscriber = new AbortController();
    const handledMessages: unknown[] = [];
    let catchUps = 0;
    const loop$ = command(
      (_ctx, message: unknown, _signal: AbortSignal): boolean => {
        handledMessages.push(message);
        return false;
      },
    );
    const catchUp$ = command((_ctx, _signal: AbortSignal): boolean => {
      catchUps += 1;
      return false;
    });

    await context.store.set(setupRealtime$, context.signal);
    const loopPromise = context.store.set(
      setAblyMessageLoop$,
      {
        loopCommand$: loop$,
        catchUpCommand$: catchUp$,
      },
      subscriber.signal,
    );

    await waitFor(() => {
      expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
    });
    context.mocks.ably.triggerReconnect();

    await waitFor(() => {
      expect(catchUps).toBe(1);
    });
    expect(handledMessages).toStrictEqual([]);

    subscriber.abort(abortError("test done"));
    await expect(loopPromise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("retries a payload notification after a transient handler error", async () => {
    mockSignedInUser();
    const topic = "test:transient-payload-error";
    const payloads: unknown[] = [];
    let runs = 0;
    const loop$ = command((_ctx, payload: unknown, _signal: AbortSignal) => {
      runs += 1;
      if (runs === 1) {
        throw new Error("temporary payload failure");
      }
      payloads.push(payload);
      return true;
    });

    await context.store.set(setupRealtime$, context.signal);
    const loopPromise = context.store.set(
      setAblyPayloadLoop$,
      {
        topic,
        loopCommand$: loop$,
      },
      context.signal,
    );

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    context.mocks.ably.trigger(topic, { messageId: "message-1" });

    await expect(loopPromise).resolves.toBeUndefined();
    expect(runs).toBe(2);
    expect(payloads).toStrictEqual([{ messageId: "message-1" }]);
  });

  it("drops a payload after repeated handler failures and processes later payloads", async () => {
    mockSignedInUser();
    const topic = "test:poison-payload";
    const toastError = vi.spyOn(toast, "error").mockReturnValue("toast-id");
    const handled: unknown[] = [];
    let poisonAttempts = 0;
    const loop$ = command((_ctx, payload: unknown, _signal: AbortSignal) => {
      if (
        typeof payload === "object" &&
        payload !== null &&
        "poison" in payload
      ) {
        poisonAttempts += 1;
        throw new Error("permanent payload failure");
      }
      handled.push(payload);
      return true;
    });

    await context.store.set(setupRealtime$, context.signal);
    const loopPromise = context.store.set(
      setAblyPayloadLoop$,
      {
        topic,
        loopCommand$: loop$,
      },
      context.signal,
    );

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    context.mocks.ably.trigger(topic, { poison: "first" });
    context.mocks.ably.trigger(topic, { poison: "second" });
    context.mocks.ably.trigger(topic, { messageId: "message-1" });

    await expect(loopPromise).resolves.toBeUndefined();
    expect(poisonAttempts).toBe(8);
    expect(handled).toStrictEqual([{ messageId: "message-1" }]);
    expect(toastError).toHaveBeenCalledTimes(1);
    toastError.mockRestore();
  });

  it("stops retrying a failing notification handler until the next poke", async () => {
    mockSignedInUser();
    const topic = "test:poison-notification";
    const toastError = vi.spyOn(toast, "error").mockReturnValue("toast-id");
    let runs = 0;
    const loop$ = command((_ctx, _signal: AbortSignal) => {
      runs += 1;
      if (runs <= 4) {
        throw new Error("permanent notification failure");
      }
      return true;
    });

    await context.store.set(setupRealtime$, context.signal);
    const loopPromise = context.store.set(
      setAblyLoop$,
      {
        topic,
        loopCommand$: loop$,
      },
      context.signal,
    );

    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    context.mocks.ably.trigger(topic);

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledTimes(1);
    });
    expect(runs).toBe(4);

    context.mocks.ably.trigger(topic);
    await expect(loopPromise).resolves.toBeUndefined();
    expect(runs).toBe(5);
    toastError.mockRestore();
  });

  it("fails and cleans up when a chat realtime subscription ends before ready", async () => {
    mockSignedInUser();
    const threadId = "test-thread-partial-ready";
    const dataSource = createRemoteChatThreadDataSource(threadId);

    await context.store.set(setupRealtime$, context.signal);
    context.mocks.ably.rejectNextSubscribe("Connection closed");

    await expect(
      context.store.set(
        dataSource.subscribeRealtime$,
        {
          threadId,
          handlers: {
            onAutomationsChanged$: keepAliveLoop$,
            onArtifactsChanged$: keepAliveLoop$,
            onWorkflowsChanged$: keepAliveLoop$,
            onWorkflowQueueChanged$: keepAliveLoop$,
            onSubscribed$: failReadyCatchup$,
          },
        },
        context.signal,
      ),
    ).rejects.toThrow(
      `Realtime subscription ended before ready: chatThreadAutomationsChanged:${threadId}`,
    );

    expectNoChatThreadSubscriptions(threadId);
  });

  it("preserves the ready catchup error and cleans up subscriptions", async () => {
    mockSignedInUser();
    const threadId = "test-thread-ready-catchup-failure";
    const dataSource = createRemoteChatThreadDataSource(threadId);

    await context.store.set(setupRealtime$, context.signal);

    await expect(
      context.store.set(
        dataSource.subscribeRealtime$,
        {
          threadId,
          handlers: {
            onAutomationsChanged$: keepAliveLoop$,
            onArtifactsChanged$: keepAliveLoop$,
            onWorkflowsChanged$: keepAliveLoop$,
            onWorkflowQueueChanged$: keepAliveLoop$,
            onSubscribed$: failReadyCatchupAfterReady$,
          },
        },
        context.signal,
      ),
    ).rejects.toThrow("ready catchup failed");

    expectNoChatThreadSubscriptions(threadId);
  });

  it("keeps the replacement chat realtime subscription after old cleanup", async () => {
    mockSignedInUser();
    const threadId = "test-thread-replacement-subscription";
    const dataSource = createRemoteChatThreadDataSource(threadId);
    const replacement = new AbortController();

    await context.store.set(setupRealtime$, context.signal);
    const firstSubscription = context.store.set(
      dataSource.subscribeRealtime$,
      {
        threadId,
        handlers: {
          onAutomationsChanged$: keepAliveLoop$,
          onArtifactsChanged$: keepAliveLoop$,
          onWorkflowsChanged$: keepAliveLoop$,
          onWorkflowQueueChanged$: keepAliveLoop$,
          onSubscribed$: waitForReadyCatchupAbort$,
        },
      },
      context.signal,
    );

    await waitFor(() => {
      expectChatThreadSubscriptions(threadId);
    });

    const replacementSubscription = context.store.set(
      dataSource.subscribeRealtime$,
      {
        threadId,
        handlers: {
          onAutomationsChanged$: keepAliveLoop$,
          onArtifactsChanged$: keepAliveLoop$,
          onWorkflowsChanged$: keepAliveLoop$,
          onWorkflowQueueChanged$: keepAliveLoop$,
        },
      },
      replacement.signal,
    );

    await expect(firstSubscription).rejects.toMatchObject({
      name: "AbortError",
    });
    await waitFor(() => {
      expectChatThreadSubscriptions(threadId);
    });

    replacement.abort(abortError("test done"));
    await expect(replacementSubscription).rejects.toMatchObject({
      name: "AbortError",
    });
    expectNoChatThreadSubscriptions(threadId);
  });

  it("aborts sibling chat page subscriptions when chat realtime fails", async () => {
    mockSignedInUser();
    const threadId = "test-thread-chat-subscribe-fails";
    const signals = createChatThreadSignals(
      threadId,
      createDraftSignals(),
      createFailingSubscribeDataSource(),
    );

    await context.store.set(setupRealtime$, context.signal);

    await expect(
      context.store.set(signals.subscribeChatThread$, context.signal),
    ).rejects.toThrow("chat realtime failed");

    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("computerUseHostsChanged"),
      ).toBeFalsy();
    });
  });
});
