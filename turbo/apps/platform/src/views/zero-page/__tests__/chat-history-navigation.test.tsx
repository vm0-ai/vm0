import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  chatEventResponse,
  chatEventsContract,
  chatThreadByIdContract,
  chatThreadMarkReadContract,
  chatThreadEventsContract,
  chatThreadRenameContract,
  chatThreadsContract,
  type ChatThreadEvent,
  type ChatEvent,
} from "@vm0/api-contracts/contracts/chat-threads";
import { triggerAblyEvent } from "../../../mocks/ably.ts";
import { chatIdb$ } from "../../../signals/external/chat-idb-store.ts";
import { CHAT_THREAD_VIRTUAL_ROW_HEIGHT } from "../../../signals/zero-page/zero-sidebar-state.ts";
import { pathname$ } from "../../../signals/route.ts";
import { click, fill } from "../../../__tests__/page-helper.ts";
import {
  mockChatLifecycle,
  PLACEHOLDER,
  sendMessageInUI,
} from "./chat-test-helpers.ts";
import {
  context,
  detachedSetupPage,
  AGENT_ID,
  HISTORY_THREAD_ID,
  EVENT_SOURCED_RENAME_THREAD_ID,
  KEYBOARD_PREV_THREAD_ID,
  KEYBOARD_CURRENT_THREAD_ID,
  KEYBOARD_NEXT_THREAD_ID,
  AGENT_CHAT_PATH,
  makeRunGroupMessages,
  makeEvent,
  mockKeyboardNavigationThreads,
  buttonByText,
  buttonByLabel,
  linkByText,
  queryButtonByText,
  chatScrollContainer,
  chatComposerTextarea,
  activeElementIsInside,
  setScrollMetrics,
  mockResizeObserver,
} from "./chat-lifecycle-test-helpers.ts";

describe("chat lifecycle", () => {
  it("skips backward history fetch when persistent messages start at seq one", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000729";
    const initialEvent = {
      id: "00000000-0000-4000-8000-000000000729",
      threadId,
      eventType: "output.message",
      content: "Complete history starts here",
      createdAt: "2026-06-09T10:00:00.000Z",
      seqId: 1,
    } satisfies ChatEvent;
    const beforeSeqIds: number[] = [];

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Complete history",
    });
    context.mocks.api(chatThreadEventsContract.list, ({ query, respond }) => {
      if (query.beforeSeqId !== undefined) {
        beforeSeqIds.push(query.beforeSeqId);
        return respond(200, { events: [], hasHistoryBefore: false });
      }
      if (query.sinceSeqId === initialEvent.seqId) {
        return respond(200, { events: [] });
      }
      if (query.sinceSeqId === undefined) {
        return respond(200, {
          events: [chatEventResponse(initialEvent)],
          hasHistoryBefore: true,
        });
      }
      throw new Error(`Unexpected message cursor: ${JSON.stringify(query)}`);
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await expect(
      screen.findByText(initialEvent.content),
    ).resolves.toBeInTheDocument();
    expect(beforeSeqIds).toStrictEqual([]);
  });

  it("publishes the initial page before batching the remaining history", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000730";
    const messages = Array.from({ length: 70 }, (_, index) => {
      const itemNumber = index + 1;
      return {
        id: `00000000-0000-4000-8000-${String(itemNumber).padStart(12, "0")}`,
        threadId,
        eventType: "output.message" as const,
        content: `Delayed history reply ${itemNumber}`,
        createdAt: new Date(Date.UTC(2026, 5, 9, 10, index, 0)).toISOString(),
        seqId: itemNumber,
      } satisfies ChatEvent;
    });
    const initialPageGate = context.mocks.deferred<void>();
    const beforePageGate = context.mocks.deferred<void>();
    let initialPageRequested = false;
    const beforeSeqIds: number[] = [];
    const sinceSeqIds: number[] = [];

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Delayed history",
    });
    context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        lastReadAt: null,
      });
    });
    context.mocks.api(
      chatThreadEventsContract.list,
      async ({ query, respond }) => {
        if (query.beforeSeqId) {
          beforeSeqIds.push(query.beforeSeqId);
          if (query.beforeSeqId === messages[10]!.seqId) {
            await beforePageGate.promise;
            return respond(200, {
              events: messages.slice(0, 10).map(chatEventResponse),
              hasHistoryBefore: false,
            });
          }
          return respond(200, {
            events: messages.slice(10, 20).map(chatEventResponse),
            hasHistoryBefore: true,
          });
        }
        if (query.sinceSeqId) {
          sinceSeqIds.push(query.sinceSeqId);
          return respond(200, { events: [] });
        }

        initialPageRequested = true;
        await initialPageGate.promise;
        return respond(200, {
          events: messages.slice(20).map(chatEventResponse),
          hasHistoryBefore: true,
        });
      },
    );
    context.mocks.api(chatThreadMarkReadContract.markRead, ({ respond }) => {
      return respond(200, { lastReadAt: null, unreads: [] });
    });

    try {
      detachedSetupPage({ context, path: `/chats/${threadId}` });

      await waitFor(() => {
        expect(initialPageRequested).toBeTruthy();
      });
      expect(beforeSeqIds).toStrictEqual([]);
      expect(document.querySelector("[data-chat-skeleton]")).not.toBeNull();

      initialPageGate.resolve();
      await waitFor(() => {
        expect(beforeSeqIds).toStrictEqual([
          messages[20]!.seqId,
          messages[10]!.seqId,
        ]);
      });
      expect(screen.getByText("Delayed history reply 70")).toBeInTheDocument();
      expect(
        screen.queryByText("Delayed history reply 11"),
      ).not.toBeInTheDocument();
      expect(document.querySelector("[data-chat-skeleton]")).toBeNull();

      beforePageGate.resolve();
    } finally {
      if (!initialPageGate.settled()) {
        initialPageGate.resolve();
      }
      if (!beforePageGate.settled()) {
        beforePageGate.resolve();
      }
    }

    await waitFor(() => {
      expect(screen.getByText("Delayed history reply 1")).toBeInTheDocument();
      expect(screen.getByText("Delayed history reply 60")).toBeInTheDocument();
    });

    const forwardRequestCount = sinceSeqIds.length;
    const latestMessageSeqId = messages.at(-1)!.seqId;
    await waitFor(() => {
      expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
    });
    expect(
      context.mocks.ably.hasSubscription(
        `chatThreadMessageCreated:${threadId}`,
      ),
    ).toBeFalsy();
    context.mocks.ably.trigger(`chatThreadMessageCreated:${threadId}`, {});
    await waitFor(() => {
      expect(sinceSeqIds.slice(forwardRequestCount)).toStrictEqual([
        latestMessageSeqId,
      ]);
    });
    expect(beforeSeqIds).toStrictEqual([
      messages[20]!.seqId,
      messages[10]!.seqId,
    ]);
  });

  it("renders new messages after a payload-less created event", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000731";
    const initialMessage = {
      id: "00000000-0000-4000-8000-000000000741",
      threadId,
      eventType: "output.message" as const,
      content: "Reply already visible",
      createdAt: "2026-06-09T10:00:00.000Z",
      seqId: 1,
    } satisfies ChatEvent;
    const newMessage = {
      id: "00000000-0000-4000-8000-000000000742",
      threadId,
      eventType: "output.message" as const,
      content: "Reply delivered while the thread stays open",
      createdAt: "2026-06-09T10:01:00.000Z",
      seqId: 2,
    } satisfies ChatEvent;
    let exposeNewMessage = false;
    let emptyForwardRequests = 0;

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Live message regression",
    });
    context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        lastReadAt: null,
      });
    });
    context.mocks.api(chatThreadEventsContract.list, ({ query, respond }) => {
      if (query.sinceSeqId === undefined) {
        return respond(200, {
          events: [chatEventResponse(initialMessage)],
          hasHistoryBefore: false,
        });
      }
      if (query.sinceSeqId === initialMessage.seqId) {
        if (!exposeNewMessage) {
          emptyForwardRequests += 1;
          return respond(200, { events: [], hasHistoryBefore: false });
        }
        return respond(200, {
          events: [chatEventResponse(newMessage)],
          hasHistoryBefore: false,
        });
      }
      if (query.sinceSeqId === newMessage.seqId) {
        return respond(200, { events: [], hasHistoryBefore: false });
      }
      throw new Error(`Unexpected message cursor: ${JSON.stringify(query)}`);
    });
    context.mocks.api(chatThreadMarkReadContract.markRead, ({ respond }) => {
      return respond(200, { lastReadAt: null, unreads: [] });
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByText(initialMessage.content)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
    });
    expect(
      context.mocks.ably.hasSubscription(
        `chatThreadMessageCreated:${threadId}`,
      ),
    ).toBeFalsy();

    const requestsBeforePayloadlessEvent = emptyForwardRequests;
    context.mocks.ably.trigger(`chatThreadMessageCreated:${threadId}`);
    await waitFor(() => {
      expect(emptyForwardRequests).toBeGreaterThan(
        requestsBeforePayloadlessEvent,
      );
    });

    exposeNewMessage = true;
    context.mocks.ably.trigger(`chatThreadMessageCreated:${threadId}`);

    await waitFor(() => {
      expect(screen.getByText(newMessage.content)).toBeInTheDocument();
    });
  });

  it("reconciles optimistic messages through global created events", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "b0000000-0000-4000-a000-000000000733";
    const runId = "d0000000-0000-4000-a000-000000000750";
    const prompt = "Optimistic message awaiting server persistence";
    const initialMessage = {
      id: "00000000-0000-4000-8000-000000000750",
      threadId,
      eventType: "output.message" as const,
      content: "Reply visible before optimistic reconciliation",
      createdAt: "2026-06-09T10:00:00.000Z",
      seqId: 1,
    } satisfies ChatEvent;
    const acknowledgement = {
      id: "00000000-0000-4000-8000-000000000751",
      threadId,
      eventType: "output.message" as const,
      content: "Server acknowledged the optimistic message",
      createdAt: "2026-06-09T10:02:00.000Z",
      seqId: 3,
      runId,
    } satisfies ChatEvent;
    const initialMessagesCaughtUp = context.mocks.deferred<void>();
    let persistedMessage: ChatEvent | null = null;
    let exposePersistedMessage = false;

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Optimistic realtime reconciliation",
    });
    context.mocks.api(chatThreadEventsContract.list, ({ query, respond }) => {
      if (query.sinceSeqId === undefined) {
        return respond(200, {
          events: [chatEventResponse(initialMessage)],
          hasHistoryBefore: false,
        });
      }
      if (query.sinceSeqId === initialMessage.seqId) {
        if (!exposePersistedMessage || persistedMessage === null) {
          initialMessagesCaughtUp.resolve();
          return respond(200, { events: [], hasHistoryBefore: false });
        }
        return respond(200, {
          events: [
            chatEventResponse(persistedMessage),
            chatEventResponse(acknowledgement),
          ],
          hasHistoryBefore: false,
        });
      }
      if (query.sinceSeqId === acknowledgement.seqId) {
        return respond(200, { events: [], hasHistoryBefore: false });
      }
      throw new Error(`Unexpected message cursor: ${JSON.stringify(query)}`);
    });
    context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
      const clientEventId = body.clientEventId;
      if (clientEventId === undefined) {
        throw new Error("Expected send request to include clientEventId");
      }
      if (body.prompt !== prompt) {
        throw new Error("Expected send request to include the typed prompt");
      }
      persistedMessage = {
        id: clientEventId,
        threadId,
        eventType: "input.prompt",
        content: null,
        userMessage: body.userMessage,
        createdAt: "2026-06-09T10:01:00.000Z",
        seqId: 2,
        runId,
      };
      return respond(201, {
        runId,
        threadId,
        status: "pending",
        createdAt: "2026-06-09T10:01:00.000Z",
      });
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await initialMessagesCaughtUp.promise;
    await expect(
      screen.findByText(initialMessage.content),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
    });

    await sendMessageInUI(user, chatComposerTextarea(), prompt);
    await waitFor(() => {
      expect(screen.getAllByText(prompt)).toHaveLength(1);
      expect(persistedMessage).not.toBeNull();
    });

    exposePersistedMessage = true;
    context.mocks.ably.trigger(`chatThreadMessageCreated:${threadId}`);

    await expect(
      screen.findByText(acknowledgement.content),
    ).resolves.toBeInTheDocument();
    expect(screen.getAllByText(prompt)).toHaveLength(1);
  });

  it("renders synced messages when IndexedDB is unavailable", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000732";
    const initialMessage = {
      id: "00000000-0000-4000-8000-000000000743",
      threadId,
      eventType: "output.message" as const,
      content: "Reply visible before IndexedDB closes",
      createdAt: "2026-06-09T10:00:00.000Z",
      seqId: 1,
    } satisfies ChatEvent;
    const newMessage = {
      id: "00000000-0000-4000-8000-000000000744",
      threadId,
      eventType: "output.message" as const,
      content: "Reply delivered without IndexedDB",
      createdAt: "2026-06-09T10:01:00.000Z",
      seqId: 2,
    } satisfies ChatEvent;
    const initialMessagesCaughtUp = context.mocks.deferred<void>();
    let exposeNewMessage = false;
    let uncursoredRequests = 0;

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "IndexedDB failure delivery",
    });
    context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        lastReadAt: null,
      });
    });
    context.mocks.api(chatThreadEventsContract.list, ({ query, respond }) => {
      if (query.sinceSeqId === undefined) {
        uncursoredRequests += 1;
        return respond(200, {
          events: (exposeNewMessage
            ? [initialMessage, newMessage]
            : [initialMessage]
          ).map(chatEventResponse),
          hasHistoryBefore: false,
        });
      }
      if (query.sinceSeqId === initialMessage.seqId) {
        if (!exposeNewMessage) {
          initialMessagesCaughtUp.resolve();
          return respond(200, { events: [], hasHistoryBefore: false });
        }
        return respond(200, {
          events: [chatEventResponse(newMessage)],
          hasHistoryBefore: false,
        });
      }
      if (query.sinceSeqId === newMessage.seqId) {
        return respond(200, { events: [], hasHistoryBefore: false });
      }
      throw new Error(`Unexpected message cursor: ${JSON.stringify(query)}`);
    });
    context.mocks.api(chatThreadMarkReadContract.markRead, ({ respond }) => {
      return respond(200, { lastReadAt: null, unreads: [] });
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await initialMessagesCaughtUp.promise;
    await expect(
      screen.findByText(initialMessage.content),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
    });
    expect(
      context.mocks.ably.hasSubscription(
        `chatThreadMessageCreated:${threadId}`,
      ),
    ).toBeFalsy();

    const uncursoredRequestsBeforeEvent = uncursoredRequests;
    const appDb = await context.store.get(chatIdb$);
    appDb.close();
    exposeNewMessage = true;
    context.mocks.ably.trigger(`chatThreadMessageCreated:${threadId}`);

    await expect(
      screen.findByText(newMessage.content),
    ).resolves.toBeInTheDocument();
    expect(uncursoredRequests).toBeGreaterThan(uncursoredRequestsBeforeEvent);
  });

  it("delivers globally synced messages to the open sidebar thread", async () => {
    const mainThreadId = KEYBOARD_CURRENT_THREAD_ID;
    const sidebarThreadId = KEYBOARD_NEXT_THREAD_ID;
    const mainInitialMessage = {
      id: "00000000-0000-4000-8000-000000000745",
      threadId: mainThreadId,
      eventType: "output.message" as const,
      content: "Main pane baseline",
      createdAt: "2026-06-09T10:00:00.000Z",
      seqId: 1,
    } satisfies ChatEvent;
    const sidebarInitialMessage = {
      id: "00000000-0000-4000-8000-000000000746",
      threadId: sidebarThreadId,
      eventType: "output.message" as const,
      content: "Sidebar pane baseline",
      createdAt: "2026-06-09T10:00:00.000Z",
      seqId: 1,
    } satisfies ChatEvent;
    const sidebarNewMessage = {
      id: "00000000-0000-4000-8000-000000000747",
      threadId: sidebarThreadId,
      eventType: "output.message" as const,
      content: "Sidebar pane live reply",
      createdAt: "2026-06-09T10:01:00.000Z",
      seqId: 2,
    } satisfies ChatEvent;
    const sidebarMessagesCaughtUp = context.mocks.deferred<void>();
    let exposeSidebarMessage = false;

    mockKeyboardNavigationThreads();
    context.mocks.api(
      chatThreadEventsContract.list,
      ({ params, query, respond }) => {
        const initialMessage =
          params.threadId === KEYBOARD_CURRENT_THREAD_ID
            ? mainInitialMessage
            : sidebarInitialMessage;
        if (query.sinceSeqId === undefined) {
          return respond(200, {
            events: [chatEventResponse(initialMessage)],
            hasHistoryBefore: false,
          });
        }
        if (query.sinceSeqId === initialMessage.seqId) {
          if (params.threadId !== KEYBOARD_NEXT_THREAD_ID) {
            return respond(200, { events: [], hasHistoryBefore: false });
          }
          if (!exposeSidebarMessage) {
            sidebarMessagesCaughtUp.resolve();
            return respond(200, { events: [], hasHistoryBefore: false });
          }
          return respond(200, {
            events: [chatEventResponse(sidebarNewMessage)],
            hasHistoryBefore: false,
          });
        }
        if (
          params.threadId === KEYBOARD_NEXT_THREAD_ID &&
          query.sinceSeqId === sidebarNewMessage.seqId
        ) {
          return respond(200, { events: [], hasHistoryBefore: false });
        }
        throw new Error(
          `Unexpected message cursor: ${JSON.stringify({
            threadId: params.threadId,
            query,
          })}`,
        );
      },
    );
    context.mocks.api(chatThreadMarkReadContract.markRead, ({ respond }) => {
      return respond(200, { lastReadAt: null, unreads: [] });
    });

    detachedSetupPage({
      context,
      path: `/chats/${KEYBOARD_CURRENT_THREAD_ID}?sidebar=${KEYBOARD_NEXT_THREAD_ID}`,
    });

    await sidebarMessagesCaughtUp.promise;
    await waitFor(() => {
      expect(screen.getByText(mainInitialMessage.content)).toBeInTheDocument();
      expect(
        screen.getByText(sidebarInitialMessage.content),
      ).toBeInTheDocument();
      expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
    });
    expect(
      context.mocks.ably.hasSubscription(
        `chatThreadMessageCreated:${KEYBOARD_CURRENT_THREAD_ID}`,
      ),
    ).toBeFalsy();
    expect(
      context.mocks.ably.hasSubscription(
        `chatThreadMessageCreated:${KEYBOARD_NEXT_THREAD_ID}`,
      ),
    ).toBeFalsy();

    exposeSidebarMessage = true;
    context.mocks.ably.trigger(
      `chatThreadMessageCreated:${KEYBOARD_NEXT_THREAD_ID}`,
    );

    await waitFor(() => {
      const threadRegions = screen.getAllByLabelText("Chat thread");
      expect(threadRegions).toHaveLength(2);
      expect(
        within(threadRegions[1]!).getByText(sidebarNewMessage.content),
      ).toBeInTheDocument();
    });
  });

  it("automatically loads older chat history after publishing recent messages", async () => {
    const olderReply = "Earlier launch notes from last week.";
    const beforeHistoryGate = context.mocks.deferred<void>();
    let initialPageReturned = false;

    mockChatLifecycle(context, {
      threadId: HISTORY_THREAD_ID,
      threadTitle: "History review",
      beforeHistoryGate: beforeHistoryGate.promise,
      afterInitialEventsList: () => {
        initialPageReturned = true;
      },
      historyEvents: [
        {
          eventType: "output.message" as const,
          role: "assistant",
          content: olderReply,
          runId: undefined,
          createdAt: "2026-06-02T10:00:00Z",
        },
      ],
      chatEvents: [
        {
          eventType: "input.prompt" as const,
          role: "user",
          content: "Continue the launch review",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          eventType: "output.message" as const,
          role: "assistant",
          content: "Current launch risks are ready.",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${HISTORY_THREAD_ID}` });

    try {
      await waitFor(() => {
        expect(initialPageReturned).toBeTruthy();
      });
      expect(
        screen.getByText("Current launch risks are ready."),
      ).toBeInTheDocument();
      expect(queryButtonByText("Load history")).toBeNull();
      expect(screen.queryByText(olderReply)).not.toBeInTheDocument();

      beforeHistoryGate.resolve();
    } finally {
      if (!beforeHistoryGate.settled()) {
        beforeHistoryGate.resolve();
      }
    }

    await waitFor(() => {
      expect(screen.getByText(olderReply)).toBeInTheDocument();
      expect(
        screen.getByText("Current launch risks are ready."),
      ).toBeInTheDocument();
      expect(queryButtonByText("Load history")).toBeNull();
    });
  });

  it("keeps chat scroll controls responsive to buttons and keyboard", async () => {
    mockResizeObserver();
    const threadId = "b0000000-0000-4000-a000-000000000722";
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Scroll history",
      chatEvents: Array.from({ length: 8 }, (_, index) => {
        return makeEvent(
          `scroll-message-${index}`,
          `Visible launch update ${index}`,
          threadId,
        );
      }),
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    let scrollContainer: HTMLElement | undefined;
    await waitFor(() => {
      scrollContainer = chatScrollContainer();
      expect(scrollContainer).toBeInTheDocument();
    });
    if (scrollContainer === undefined) {
      throw new Error("Chat scroll container not found");
    }
    setScrollMetrics(scrollContainer, {
      scrollHeight: 1200,
      clientHeight: 300,
    });

    await waitFor(() => {
      expect(screen.getByText("Visible launch update 7")).toBeInTheDocument();
      expect(queryButtonByText("Load history")).toBeNull();
    });

    scrollContainer.scrollTop = 900;
    fireEvent.scroll(scrollContainer);
    fireEvent.wheel(scrollContainer);
    scrollContainer.scrollTop = 520;
    fireEvent.scroll(scrollContainer);

    const scrollToBottom = await screen.findByLabelText("Scroll to bottom");
    click(scrollToBottom);
    expect(scrollContainer.scrollTop).toBe(1200);
    fireEvent.scroll(scrollContainer);
    await waitFor(() => {
      expect(screen.queryByLabelText("Scroll to bottom")).toBeNull();
    });

    const threadRegion = screen.getByLabelText("Chat thread");
    threadRegion.focus();
    fireEvent.keyDown(threadRegion, { key: "ArrowUp", ctrlKey: true });
    expect(scrollContainer.scrollTop).toBe(0);
    fireEvent.scroll(scrollContainer);
    await waitFor(() => {
      expect(screen.getByLabelText("Scroll to bottom")).toBeInTheDocument();
    });

    scrollContainer.scrollTop = 420;
    fireEvent.scroll(scrollContainer);
    const composer = screen.getByPlaceholderText(PLACEHOLDER);
    composer.focus();
    fireEvent.keyDown(composer, { key: "ArrowUp" });
    expect(scrollContainer.scrollTop).toBe(420);

    setScrollMetrics(scrollContainer, {
      scrollHeight: 1500,
      clientHeight: 300,
    });
    fireEvent.keyDown(composer, { key: "ArrowUp", ctrlKey: true });
    expect(scrollContainer.scrollTop).toBe(0);

    scrollContainer.scrollTop = 420;
    fireEvent.scroll(scrollContainer);
    fireEvent.keyDown(composer, { key: "ArrowDown", ctrlKey: true });
    expect(scrollContainer.scrollTop).toBe(1500);

    threadRegion.focus();
    fireEvent.keyDown(threadRegion, { key: "ArrowDown", ctrlKey: true });
    expect(scrollContainer.scrollTop).toBe(1500);
  });

  it("renders the latest chat groups first and prepends older in-memory groups near the top", async () => {
    mockResizeObserver();
    let markReadCalls = 0;
    const threadId = "render-window-thread";
    const chatEvents: ChatEvent[] = Array.from({ length: 24 }, (_, index) => {
      return {
        id: `render-window-message-${index}`,
        threadId,
        eventType: "run.completed" as const,
        content: `Render window reply ${index}`,
        runId: `render-window-run-${index}`,
        runLifecycleEvent: "completed",
        createdAt: `2026-06-09T10:${String(index).padStart(2, "0")}:00Z`,
        seqId: index + 1,
      };
    });

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Render window",
      chatEvents,
    });
    context.mocks.api(chatThreadMarkReadContract.markRead, ({ respond }) => {
      markReadCalls += 1;
      return respond(200, {
        lastReadAt: "2026-06-09T10:23:00Z",
        unreads: [],
      });
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByText("Render window reply 23")).toBeInTheDocument();
      expect(screen.queryByText("Render window reply 13")).toBeNull();
      expect(markReadCalls).toBeGreaterThan(0);
    });

    const scrollContainer = chatScrollContainer();
    setScrollMetrics(scrollContainer, {
      scrollHeight: 1000,
      clientHeight: 300,
    });
    scrollContainer.scrollTop = 80;
    fireEvent.scroll(scrollContainer);

    await waitFor(() => {
      expect(screen.getByText("Render window reply 4")).toBeInTheDocument();
    });
    expect(screen.queryByText("Render window reply 3")).toBeNull();

    scrollContainer.scrollTop = 80;
    fireEvent.scroll(scrollContainer);

    await waitFor(() => {
      expect(screen.getByText("Render window reply 3")).toBeInTheDocument();
    });

    scrollContainer.scrollTop = 80;
    fireEvent.scroll(scrollContainer);
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByText("Render window reply 3")).toBeInTheDocument();
  });

  it("counts a folded tail run group as one item in the initial chat window", async () => {
    const threadId = "render-window-tail-run-group";
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Tail run group window",
      chatEvents: [
        ...makeRunGroupMessages({
          label: "A",
          count: 11,
          runGroupId: "tail-group-a",
          startMinute: 0,
        }),
        ...makeRunGroupMessages({
          label: "B",
          count: 1,
          runGroupId: "tail-group-b",
          startMinute: 30,
        }),
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      expect(buttonByLabel("Expand grouped run history")).toHaveTextContent(
        "10 runs",
      );
      expect(screen.getByText("A reply 11")).toBeInTheDocument();
      expect(screen.getByText("B reply 1")).toBeInTheDocument();
      expect(screen.queryByText("A reply 10")).not.toBeInTheDocument();
    });
  });

  it("labels folded runs from their userMessage projection", async () => {
    const threadId = "structured-run-group-label";
    const messages = makeRunGroupMessages({
      label: "legacy run label",
      count: 2,
      runGroupId: "structured-label-group",
      startMinute: 0,
    }).map((message) => {
      return message.role === "user"
        ? {
            ...message,
            userMessage: {
              version: 1 as const,
              parts: [
                {
                  type: "file" as const,
                  fileId: "roadmap-file",
                  filenameSnapshot: "roadmap.pdf",
                  contentType: "application/pdf",
                },
                { type: "text" as const, text: "Review the roadmap" },
              ],
            },
          }
        : message;
    });
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Structured run group label",
      chatEvents: messages,
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    const userMessageLabel = "1 run for [File: roadmap.pdf] Review the roadmap";
    const legacyLabel = "1 run for legacy run label";
    await waitFor(() => {
      expect(buttonByLabel("Expand grouped run history")).toHaveTextContent(
        userMessageLabel,
      );
    });
    expect(buttonByLabel("Expand grouped run history")).not.toHaveTextContent(
      legacyLabel,
    );
  });

  it("keeps the item before a folded middle run group in the initial chat window", async () => {
    const threadId = "render-window-middle-run-group";
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Middle run group window",
      chatEvents: [
        ...makeRunGroupMessages({
          label: "A",
          count: 1,
          runGroupId: "middle-group-a",
          startMinute: 0,
        }),
        ...makeRunGroupMessages({
          label: "B",
          count: 10,
          runGroupId: "middle-group-b",
          startMinute: 10,
        }),
        ...makeRunGroupMessages({
          label: "C",
          count: 1,
          runGroupId: "middle-group-c",
          startMinute: 30,
        }),
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      expect(screen.getByText("A reply 1")).toBeInTheDocument();
      expect(buttonByLabel("Expand grouped run history")).toHaveTextContent(
        "9 runs",
      );
      expect(screen.getByText("B reply 10")).toBeInTheDocument();
      expect(screen.getByText("C reply 1")).toBeInTheDocument();
      expect(screen.queryByText("B reply 9")).not.toBeInTheDocument();
    });
  });

  it("moves between chat threads with keyboard shortcuts", async () => {
    const resizeObserver = mockResizeObserver();
    mockKeyboardNavigationThreads();

    detachedSetupPage({
      context,
      path: "/chats/b0000000-0000-4000-a000-000000000708",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
      expect(screen.getByText("Previous keyboard thread")).toBeInTheDocument();
      expect(screen.getByText("Next keyboard thread")).toBeInTheDocument();
    });

    const threadRegion = screen.getByLabelText("Chat thread");
    const initialScrollContainer = chatScrollContainer();
    setScrollMetrics(initialScrollContainer, {
      scrollHeight: 1200,
      clientHeight: 300,
    });
    initialScrollContainer.scrollTop = 900;
    fireEvent.scroll(initialScrollContainer);
    fireEvent.wheel(initialScrollContainer);
    initialScrollContainer.scrollTop = 480;
    fireEvent.scroll(initialScrollContainer);
    await waitFor(() => {
      expect(screen.getByLabelText("Scroll to bottom")).toBeInTheDocument();
    });

    threadRegion.focus();
    fireEvent.keyDown(threadRegion, {
      key: "ArrowUp",
      ctrlKey: true,
      shiftKey: true,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Previous thread launch note"),
      ).toBeInTheDocument();
    });
    expect(context.store.get(pathname$)).toBe(
      `/chats/${KEYBOARD_PREV_THREAD_ID}`,
    );

    const previousThreadRegion = screen.getByLabelText("Chat thread");
    previousThreadRegion.focus();
    fireEvent.keyDown(previousThreadRegion, {
      key: "ArrowDown",
      ctrlKey: true,
      shiftKey: true,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
    });
    expect(context.store.get(pathname$)).toBe(
      `/chats/${KEYBOARD_CURRENT_THREAD_ID}`,
    );

    const restoredScrollContainer = chatScrollContainer();
    setScrollMetrics(restoredScrollContainer, {
      scrollHeight: 1200,
      clientHeight: 300,
    });
    resizeObserver.automationAll();
    expect(restoredScrollContainer.scrollTop).toBe(480);
    expect(screen.getByLabelText("Scroll to bottom")).toBeInTheDocument();

    const currentThreadRegion = screen.getByLabelText("Chat thread");
    currentThreadRegion.focus();
    fireEvent.keyDown(currentThreadRegion, { key: "?", shiftKey: true });

    await waitFor(() => {
      expect(screen.getByText("Keyboard Shortcuts")).toBeInTheDocument();
      expect(screen.getByText("Previous thread")).toBeInTheDocument();
      expect(screen.getByText("Next thread")).toBeInTheDocument();
      expect(screen.getByText("Rename chat")).toBeInTheDocument();
      expect(screen.getByText("Change icon")).toBeInTheDocument();
      expect(screen.getAllByText("F2")).toHaveLength(2);
      expect(screen.getAllByText("Shift").length).toBeGreaterThan(0);
    });
  });

  it("keeps shifted slash editable in the chat composer", async () => {
    mockResizeObserver();
    mockKeyboardNavigationThreads();

    detachedSetupPage({
      context,
      path: "/chats/b0000000-0000-4000-a000-000000000708",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
    });

    const composer = chatComposerTextarea();
    composer.focus();
    fireEvent.keyDown(composer, { key: "?", shiftKey: true });

    expect(screen.queryByText("Keyboard Shortcuts")).not.toBeInTheDocument();
  });

  it("moves between chat threads with page shortcuts from the composer", async () => {
    mockResizeObserver();
    mockKeyboardNavigationThreads({ leadingThreadCount: 20 });

    detachedSetupPage({
      context,
      path: "/chats/b0000000-0000-4000-a000-000000000708",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("sidebar-chat-threads-virtual-list"),
      ).toBeInTheDocument();
    });

    const sidebarScrollArea = screen.getByTestId("sidebar-scroll-area");
    Object.defineProperties(sidebarScrollArea, {
      clientHeight: {
        configurable: true,
        value: CHAT_THREAD_VIRTUAL_ROW_HEIGHT * 2,
      },
      scrollHeight: {
        configurable: true,
        value: CHAT_THREAD_VIRTUAL_ROW_HEIGHT * 24,
      },
      scrollTop: {
        configurable: true,
        value: CHAT_THREAD_VIRTUAL_ROW_HEIGHT * 20,
        writable: true,
      },
    });
    fireEvent.scroll(sidebarScrollArea);

    let composer = chatComposerTextarea();
    composer.focus();
    fireEvent.keyDown(composer, {
      key: "ArrowDown",
      ctrlKey: true,
      shiftKey: true,
    });

    await waitFor(() => {
      expect(screen.getByText("Next thread launch note")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-scroll-area").scrollTop).toBe(
        CHAT_THREAD_VIRTUAL_ROW_HEIGHT * 21,
      );
    });

    composer = chatComposerTextarea();
    composer.focus();
    fireEvent.keyDown(composer, {
      key: "ArrowUp",
      ctrlKey: true,
      shiftKey: true,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
    });
  });

  it("moves the main chat when a page shortcut comes from the sidebar thread link", async () => {
    mockResizeObserver();
    mockKeyboardNavigationThreads();

    detachedSetupPage({
      context,
      path: "/chats/b0000000-0000-4000-a000-000000000708",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
      expect(screen.getByText("Previous keyboard thread")).toBeInTheDocument();
      expect(screen.getByText("Next keyboard thread")).toBeInTheDocument();
    });

    const currentThreadLink = linkByText("Current keyboard thread");
    currentThreadLink.focus();
    expect(currentThreadLink).toHaveFocus();
    expect(
      fireEvent.keyDown(currentThreadLink, {
        key: "ArrowUp",
        ctrlKey: true,
        shiftKey: true,
      }),
    ).toBeFalsy();

    await waitFor(() => {
      expect(
        screen.getByText("Previous thread launch note"),
      ).toBeInTheDocument();
    });
  });

  it("opens the current chat rename dialog with F2", async () => {
    mockResizeObserver();
    mockKeyboardNavigationThreads();

    detachedSetupPage({
      context,
      path: "/chats/b0000000-0000-4000-a000-000000000708",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
      expect(
        screen.getAllByText("Current keyboard thread").length,
      ).toBeGreaterThan(0);
    });
    const emojiButton = screen.getByLabelText("Change icon");
    expect(emojiButton).toHaveTextContent("");
    expect(emojiButton.querySelector("svg")).toBeInTheDocument();
    expect(emojiButton).toHaveClass("h-7", "w-7");

    const threadRegion = screen.getByLabelText("Chat thread");
    threadRegion.focus();
    fireEvent.keyDown(threadRegion, { key: "F2" });

    let dialog = await screen.findByRole("dialog", { name: "Rename chat" });
    expect(within(dialog).getByPlaceholderText("Chat title")).toHaveValue(
      "Current keyboard thread",
    );

    click(buttonByText("Cancel"));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Rename chat" }),
      ).not.toBeInTheDocument();
    });

    const composer = chatComposerTextarea();
    composer.focus();
    fireEvent.keyDown(composer, { key: "F2" });

    dialog = await screen.findByRole("dialog", { name: "Rename chat" });
    expect(within(dialog).getByPlaceholderText("Chat title")).toHaveValue(
      "Current keyboard thread",
    );
  });

  it("opens the current chat rename dialog by double-clicking the header title", async () => {
    mockResizeObserver();
    mockKeyboardNavigationThreads();

    detachedSetupPage({
      context,
      path: "/chats/b0000000-0000-4000-a000-000000000708",
    });

    const headerTitle = await screen.findByTestId("chat-thread-header-title");
    expect(headerTitle).toHaveTextContent("Current keyboard thread");

    fireEvent.doubleClick(headerTitle);

    const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
    expect(within(dialog).getByPlaceholderText("Chat title")).toHaveValue(
      "Current keyboard thread",
    );
  });

  it("keeps F2 rename available after renaming the current chat", async () => {
    const user = userEvent.setup({ delay: null });
    mockResizeObserver();
    mockKeyboardNavigationThreads();

    detachedSetupPage({
      context,
      path: "/chats/b0000000-0000-4000-a000-000000000708",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
      expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
        "Current keyboard thread",
      );
    });

    const threadRegion = screen.getByLabelText("Chat thread");
    threadRegion.focus();
    await user.keyboard("{F2}");

    const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
    await fill(
      within(dialog).getByPlaceholderText("Chat title"),
      "Renamed keyboard thread",
    );
    click(buttonByText("Rename"));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Rename chat" }),
      ).not.toBeInTheDocument();
    });

    await waitFor(() => {
      expect(activeElementIsInside(threadRegion)).toBeTruthy();
    });

    await user.keyboard("{F2}");

    const reopenedDialog = await screen.findByRole("dialog", {
      name: "Rename chat",
    });
    expect(
      within(reopenedDialog).getByPlaceholderText("Chat title"),
    ).toHaveValue("Renamed keyboard thread");
  });

  it("renames the event-sourced current chat while thread detail is pending", async () => {
    const user = userEvent.setup({ delay: null });
    mockResizeObserver();
    const originalTitle = "Original event-sourced thread";
    const renamedTitle = "Renamed event-sourced thread";
    const thread = {
      id: EVENT_SOURCED_RENAME_THREAD_ID,
      title: originalTitle,
      agent: { id: AGENT_ID, avatarUrl: null },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
      pinnedAt: null,
    };
    const lifecycle = mockChatLifecycle(context, {
      threadId: EVENT_SOURCED_RENAME_THREAD_ID,
      threadTitle: "Thread detail should stay pending",
    });
    lifecycle.setThreadList([thread]);
    const renameRequest = vi.fn();
    let persistedRenameEvent: ChatThreadEvent | null = null;

    context.mocks.api(chatThreadByIdContract.get, ({ never }) => {
      return never();
    });
    context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
      return respond(200, {
        chatThreads: [
          {
            id: EVENT_SOURCED_RENAME_THREAD_ID,
            agentId: AGENT_ID,
            title: originalTitle,
            sortAt: "2026-06-01T00:00:00.000Z",
            createdAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-06-01T00:00:00.000Z",
            pinnedAt: null,
            renamedAt: null,
            selectedModel: null,
            serviceTier: null,
            computerUseHostId: null,
          },
        ],
        latestEventId: null,
        latestSeqId: null,
      });
    });
    context.mocks.api(chatThreadsContract.events, ({ respond }) => {
      return respond(200, {
        events: persistedRenameEvent ? [persistedRenameEvent] : [],
        hasMore: false,
      });
    });
    context.mocks.api(
      chatThreadRenameContract.rename,
      ({ body, params, respond }) => {
        renameRequest(params.id, body.title);
        if (!body.eventId) {
          throw new Error("Expected rename event id");
        }
        persistedRenameEvent = {
          id: body.eventId,
          seqId: 1,
          kind: "renamed",
          chatThreadId: EVENT_SOURCED_RENAME_THREAD_ID,
          agentId: AGENT_ID,
          title: body.title,
          selectedModel: null,
          serviceTier: null,
          computerUseHostId: null,
          createdAt: "2026-06-01T00:00:01.000Z",
        };
        return respond(204);
      },
    );

    detachedSetupPage({
      context,
      path: `/chats/${EVENT_SOURCED_RENAME_THREAD_ID}`,
    });

    const threadRegion = await screen.findByLabelText("Chat thread");
    await waitFor(() => {
      expect(within(threadRegion).getByText(originalTitle)).toBeInTheDocument();
      expect(document.title).toBe(`${originalTitle} | VM0`);
    });
    expect(
      within(threadRegion).queryByText("Thread detail should stay pending"),
    ).not.toBeInTheDocument();

    threadRegion.focus();
    await user.keyboard("{F2}");

    const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
    expect(within(dialog).getByPlaceholderText("Chat title")).toHaveValue(
      originalTitle,
    );
    await fill(within(dialog).getByPlaceholderText("Chat title"), renamedTitle);
    click(buttonByText("Rename", dialog));

    await waitFor(() => {
      expect(renameRequest).toHaveBeenCalledWith(
        EVENT_SOURCED_RENAME_THREAD_ID,
        renamedTitle,
      );
      expect(within(threadRegion).getByText(renamedTitle)).toBeInTheDocument();
    });

    expect(document.title).toBe(`${originalTitle} | VM0`);
    triggerAblyEvent("threadListChanged");
    await waitFor(() => {
      expect(document.title).toBe(`${renamedTitle} | VM0`);
    });
  });

  it("keeps F2 rename available after creating a chat from the agent composer", async () => {
    const user = userEvent.setup({ delay: null });
    mockResizeObserver();
    mockChatLifecycle(context);

    detachedSetupPage({ context, path: AGENT_CHAT_PATH });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, textarea, "Name this thread from F2");

    await waitFor(() => {
      expect(screen.getByText("Name this thread from F2")).toBeInTheDocument();
    });

    const threadRegion = screen.getByLabelText("Chat thread");
    expect(activeElementIsInside(threadRegion)).toBeTruthy();

    await user.keyboard("{F2}");

    const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
    expect(within(dialog).getByPlaceholderText("Chat title")).toHaveValue("");
  });

  it("renames the focused side chat with F2", async () => {
    const user = userEvent.setup({ delay: null });
    mockResizeObserver();
    mockKeyboardNavigationThreads();

    detachedSetupPage({
      context,
      path: "/chats/b0000000-0000-4000-a000-000000000708?sidebar=b0000000-0000-4000-a000-000000000709",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
      expect(screen.getByText("Next thread launch note")).toBeInTheDocument();
    });

    const threadRegions = screen.getAllByLabelText("Chat thread");
    expect(threadRegions).toHaveLength(2);
    threadRegions[1]?.focus();

    await user.keyboard("{F2}");

    const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
    expect(within(dialog).getByPlaceholderText("Chat title")).toHaveValue(
      "Next keyboard thread",
    );
  });

  it("moves the focused side chat with page keyboard shortcuts", async () => {
    mockResizeObserver();
    mockKeyboardNavigationThreads();

    detachedSetupPage({
      context,
      path: "/chats/b0000000-0000-4000-a000-000000000708?sidebar=b0000000-0000-4000-a000-000000000709",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
      expect(screen.getByText("Next thread launch note")).toBeInTheDocument();
    });

    const threadRegions = screen.getAllByLabelText("Chat thread");
    expect(threadRegions).toHaveLength(2);
    const sideThreadRegion = threadRegions[1];
    if (!sideThreadRegion) {
      throw new Error("Side chat thread not found");
    }
    sideThreadRegion.focus();
    fireEvent.keyDown(sideThreadRegion, {
      key: "ArrowUp",
      ctrlKey: true,
      shiftKey: true,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Previous thread launch note"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
    });
  });

  it("adds an emoji to the current chat from the Shift+F2 picker", async () => {
    const renameRequest = vi.fn();
    mockResizeObserver();
    mockKeyboardNavigationThreads({ currentDetailTitle: null });
    context.mocks.api(
      chatThreadRenameContract.rename,
      ({ body, params, respond }) => {
        renameRequest(params.id, body.title);
        return respond(204);
      },
    );

    detachedSetupPage({
      context,
      path: "/chats/b0000000-0000-4000-a000-000000000708",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
      expect(
        screen.getAllByText("Current keyboard thread").length,
      ).toBeGreaterThan(0);
    });

    const composer = chatComposerTextarea();
    composer.focus();
    fireEvent.keyDown(composer, { key: "F2", shiftKey: true });

    await screen.findByLabelText("Search emoji");
    click(screen.getByLabelText("Done"));

    await waitFor(() => {
      expect(renameRequest).toHaveBeenCalledWith(
        "b0000000-0000-4000-a000-000000000708",
        "✅ Current keyboard thread",
      );
    });
  });

  it("adds an emoji to the current chat directly with Ctrl+Shift+1", async () => {
    const renameRequest = vi.fn();
    mockResizeObserver();
    mockKeyboardNavigationThreads({ currentDetailTitle: null });
    context.mocks.api(
      chatThreadRenameContract.rename,
      ({ body, params, respond }) => {
        renameRequest(params.id, body.title);
        return respond(204);
      },
    );

    detachedSetupPage({
      context,
      path: "/chats/b0000000-0000-4000-a000-000000000708",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
    });

    const threadRegion = screen.getByLabelText("Chat thread");
    threadRegion.focus();
    fireEvent.keyDown(threadRegion, {
      key: "!",
      code: "Digit1",
      ctrlKey: true,
      shiftKey: true,
    });

    await waitFor(() => {
      expect(renameRequest).toHaveBeenCalledWith(
        "b0000000-0000-4000-a000-000000000708",
        "✅ Current keyboard thread",
      );
    });
    expect(screen.queryByLabelText("Search emoji")).not.toBeInTheDocument();
  });

  it("adds an emoji to the focused side chat directly with Ctrl+Shift+1", async () => {
    const renameRequest = vi.fn();
    mockResizeObserver();
    mockKeyboardNavigationThreads({ currentDetailTitle: null });
    context.mocks.api(
      chatThreadRenameContract.rename,
      ({ body, params, respond }) => {
        renameRequest(params.id, body.title);
        return respond(204);
      },
    );

    detachedSetupPage({
      context,
      path: "/chats/b0000000-0000-4000-a000-000000000708?sidebar=b0000000-0000-4000-a000-000000000709",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
      expect(screen.getByText("Next thread launch note")).toBeInTheDocument();
    });

    const sideThreadRegion = screen.getAllByLabelText("Chat thread")[1];
    if (!sideThreadRegion) {
      throw new Error("Side chat thread not found");
    }
    sideThreadRegion.focus();
    fireEvent.keyDown(sideThreadRegion, {
      key: "!",
      code: "Digit1",
      ctrlKey: true,
      shiftKey: true,
    });

    await waitFor(() => {
      expect(renameRequest).toHaveBeenCalledWith(
        "b0000000-0000-4000-a000-000000000709",
        "✅ Next keyboard thread",
      );
    });
  });

  it("adds an emoji from the composer with Ctrl+Shift+1", async () => {
    const renameRequest = vi.fn();
    mockResizeObserver();
    mockKeyboardNavigationThreads({ currentDetailTitle: null });
    context.mocks.api(
      chatThreadRenameContract.rename,
      ({ body, params, respond }) => {
        renameRequest(params.id, body.title);
        return respond(204);
      },
    );

    detachedSetupPage({
      context,
      path: "/chats/b0000000-0000-4000-a000-000000000708",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
    });

    const composer = chatComposerTextarea();
    composer.focus();
    fireEvent.keyDown(composer, {
      key: "!",
      code: "Digit1",
      ctrlKey: true,
      shiftKey: true,
    });

    await waitFor(() => {
      expect(renameRequest).toHaveBeenCalledWith(
        "b0000000-0000-4000-a000-000000000708",
        "✅ Current keyboard thread",
      );
    });
  });

  it("clears the current chat emoji directly with Ctrl+Shift+0", async () => {
    const renameRequest = vi.fn();
    mockResizeObserver();
    mockKeyboardNavigationThreads({
      currentTitle: "🔥 Current keyboard thread",
    });
    context.mocks.api(
      chatThreadRenameContract.rename,
      ({ body, params, respond }) => {
        renameRequest(params.id, body.title);
        return respond(204);
      },
    );

    detachedSetupPage({
      context,
      path: "/chats/b0000000-0000-4000-a000-000000000708",
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Change icon")).toHaveTextContent("🔥");
    });

    const threadRegion = screen.getByLabelText("Chat thread");
    threadRegion.focus();
    fireEvent.keyDown(threadRegion, {
      key: ")",
      code: "Digit0",
      ctrlKey: true,
      shiftKey: true,
    });

    await waitFor(() => {
      expect(renameRequest).toHaveBeenCalledWith(
        "b0000000-0000-4000-a000-000000000708",
        "Current keyboard thread",
      );
    });
  });

  it("keeps shifted digit input editable in the chat composer", async () => {
    const user = userEvent.setup({ delay: null });
    const renameRequest = vi.fn();
    mockResizeObserver();
    mockKeyboardNavigationThreads({ currentDetailTitle: null });
    context.mocks.api(
      chatThreadRenameContract.rename,
      ({ body, params, respond }) => {
        renameRequest(params.id, body.title);
        return respond(204);
      },
    );

    detachedSetupPage({
      context,
      path: "/chats/b0000000-0000-4000-a000-000000000708",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
    });

    const composer = chatComposerTextarea();
    await user.type(composer, "!");

    expect(composer).toHaveTextContent("!");
    expect(renameRequest).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("does not refocus the chat emoji button or show its tooltip after closing the picker from outside", async () => {
    const user = userEvent.setup({ delay: null });
    mockResizeObserver();
    mockKeyboardNavigationThreads({
      currentTitle: "🔥 Current keyboard thread",
    });

    detachedSetupPage({
      context,
      path: "/chats/b0000000-0000-4000-a000-000000000708",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Change icon")).toHaveTextContent("🔥");
    });

    const emojiButton = screen.getByLabelText("Change icon");
    function visibleChatThreadIconTooltip(): HTMLElement | undefined {
      return screen.queryAllByText("Chat thread icon").find((element) => {
        try {
          expect(element).toBeVisible();
          return true;
        } catch {
          return false;
        }
      });
    }

    await user.hover(emojiButton);
    await waitFor(() => {
      expect(visibleChatThreadIconTooltip()).toBeDefined();
    });

    await user.click(emojiButton);
    await expect(
      screen.findByLabelText("Search emoji"),
    ).resolves.toBeInTheDocument();

    fireEvent.pointerOut(emojiButton);
    fireEvent.mouseOut(emojiButton);
    click(document.body);

    await waitFor(() => {
      expect(screen.queryByLabelText("Search emoji")).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(visibleChatThreadIconTooltip()).toBeUndefined();
      expect(emojiButton).not.toHaveFocus();
    });
  });

  it("replaces the current chat emoji from the Shift+F2 picker", async () => {
    const renameRequest = vi.fn();
    mockResizeObserver();
    mockKeyboardNavigationThreads({
      currentTitle: "🔥   Current keyboard thread",
    });
    context.mocks.api(
      chatThreadRenameContract.rename,
      ({ body, params, respond }) => {
        renameRequest(params.id, body.title);
        return respond(204);
      },
    );

    detachedSetupPage({
      context,
      path: "/chats/b0000000-0000-4000-a000-000000000708",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
      expect(document.title).toBe("🔥   Current keyboard thread | VM0");
      expect(screen.getByLabelText("Change icon")).toHaveTextContent("🔥");
      expect(screen.getByText("Current keyboard thread")).toBeInTheDocument();
    });

    const threadRegion = screen.getByLabelText("Chat thread");
    threadRegion.focus();
    fireEvent.keyDown(threadRegion, { key: "F2", shiftKey: true });

    await screen.findByLabelText("Search emoji");
    click(screen.getByLabelText("Done"));

    await waitFor(() => {
      expect(renameRequest).toHaveBeenCalledWith(
        "b0000000-0000-4000-a000-000000000708",
        "✅ Current keyboard thread",
      );
    });
  });

  it("clears the current chat emoji from the picker Remove button", async () => {
    const renameRequest = vi.fn();
    mockResizeObserver();
    mockKeyboardNavigationThreads({
      currentTitle: "🔥 Current keyboard thread",
    });
    context.mocks.api(
      chatThreadRenameContract.rename,
      ({ body, params, respond }) => {
        renameRequest(params.id, body.title);
        return respond(204);
      },
    );

    detachedSetupPage({
      context,
      path: "/chats/b0000000-0000-4000-a000-000000000708",
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Change icon")).toHaveTextContent("🔥");
    });

    const threadRegion = screen.getByLabelText("Chat thread");
    threadRegion.focus();
    fireEvent.keyDown(threadRegion, { key: "F2", shiftKey: true });

    await screen.findByLabelText("Search emoji");
    click(buttonByText("Remove"));

    await waitFor(() => {
      expect(renameRequest).toHaveBeenCalledWith(
        "b0000000-0000-4000-a000-000000000708",
        "Current keyboard thread",
      );
    });
  });

  it("does not clear the emoji when the chat has no other title text", async () => {
    const renameRequest = vi.fn();
    mockResizeObserver();
    mockKeyboardNavigationThreads({ currentTitle: "🔥" });
    context.mocks.api(
      chatThreadRenameContract.rename,
      ({ body, params, respond }) => {
        renameRequest(params.id, body.title);
        return respond(204);
      },
    );

    detachedSetupPage({
      context,
      path: "/chats/b0000000-0000-4000-a000-000000000708",
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Change icon")).toHaveTextContent("🔥");
    });

    const threadRegion = screen.getByLabelText("Chat thread");
    threadRegion.focus();
    fireEvent.keyDown(threadRegion, { key: "F2", shiftKey: true });

    await screen.findByLabelText("Search emoji");
    click(buttonByText("Remove"));

    expect(renameRequest).not.toHaveBeenCalled();
  });
});
