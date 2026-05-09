import { describe, expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  chatThreadMessagesContract,
  type PendingMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  fill,
  click,
} from "../../../__tests__/page-helper.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { changeChatPendingMessage } from "../../../mocks/mock-helpers.ts";
import { server } from "../../../mocks/server.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { hasSubscription, triggerAblyEvent } from "../../../mocks/ably.ts";
import { optimisticChatThread$ } from "../../../signals/chat-page/optimistic-chat-thread-state.ts";
import {
  mockChatLifecycle,
  sendMessageInUI,
  PLACEHOLDER,
} from "./chat-test-helpers.ts";

const context = testContext();

const THREAD_ID = "thread-test-1";
const CHAT_PATH = `/chats/${THREAD_ID}`;
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const AGENT_CHAT_PATH = `/agents/${AGENT_ID}/chat`;
const FIRST_NEW_THREAD_MESSAGE = "new thread first";
const SECOND_NEW_THREAD_MESSAGE = "new thread second";
const THIRD_NEW_THREAD_MESSAGE = "new thread third";

function getActiveRunTextarea(): Promise<HTMLTextAreaElement> {
  return waitFor(() => {
    return screen.getByPlaceholderText(
      /Type your next message/,
    ) as HTMLTextAreaElement;
  });
}

async function startActiveRun(
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLTextAreaElement> {
  const textarea = await waitFor(() => {
    return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
  });

  await sendMessageInUI(user, textarea, "start the active run");

  await waitFor(() => {
    expect(screen.getByLabelText("Stop")).toBeInTheDocument();
  });

  return await getActiveRunTextarea();
}

async function startOptimisticNewThreadRun(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  const textarea = await waitFor(() => {
    return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
  });
  await sendMessageInUI(user, textarea, FIRST_NEW_THREAD_MESSAGE);

  await waitFor(() => {
    expect(screen.getByText(FIRST_NEW_THREAD_MESSAGE)).toBeInTheDocument();
    expect(screen.getByLabelText("Stop")).toBeInTheDocument();
  });
}

async function sendQueuedMessage(
  user: ReturnType<typeof userEvent.setup>,
  text: string,
): Promise<void> {
  const textarea = await getActiveRunTextarea();
  await fill(textarea, text);
  await user.keyboard("{Enter}");
}

async function settleOptimisticNewThread(
  sendDeferred: ReturnType<typeof createDeferredPromise<void>>,
): Promise<void> {
  await act(async () => {
    if (!sendDeferred.settled()) {
      sendDeferred.resolve();
    }
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
    }
  });

  await waitFor(() => {
    expect(context.store.get(optimisticChatThread$)).toBeNull();
  });
}

async function expectQueuedSecondAndThird(): Promise<void> {
  await waitFor(() => {
    const queuedMessages = screen.getAllByLabelText("Queued message");
    expect(queuedMessages).toHaveLength(1);
    expect(queuedMessages[0]).toHaveTextContent(
      /new thread second\s+new thread third/,
    );
  });
}

describe("chat pending message queue", () => {
  it("queues keyboard sends during an active run when enabled", async () => {
    const user = userEvent.setup({ delay: null });
    const replacedContents: (string | undefined)[] = [];
    mockChatLifecycle({
      onPendingMessageReplace: (body) => {
        replacedContents.push(body.content);
      },
    });

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
    });

    let textarea = await startActiveRun(user);
    await fill(textarea, "first pending");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.getByLabelText("Queued message")).toBeInTheDocument();
      expect(screen.getByText("first pending")).toBeInTheDocument();
    });
    expect(textarea.value).toBe("");

    // The queued bubble lives inside the chat message list — not as a card
    // wrapping the composer textarea.
    const queued = screen.getByLabelText("Queued message");
    expect(queued.closest("[data-message-container]")).not.toBeNull();

    textarea = await getActiveRunTextarea();
    await fill(textarea, "second pending");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      const queued = screen.getByLabelText("Queued message");
      expect(queued).toHaveTextContent("first pending");
      expect(queued).toHaveTextContent("second pending");
    });
    expect(replacedContents).toStrictEqual([
      "first pending",
      "first pending\nsecond pending",
    ]);
  });

  it("attaches a pre-generated client message id to the replace request", async () => {
    const user = userEvent.setup({ delay: null });
    const replacedClientIds: (string | undefined)[] = [];
    mockChatLifecycle({
      onPendingMessageReplace: (body) => {
        replacedClientIds.push(body.clientMessageId);
      },
    });

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
    });

    let textarea = await startActiveRun(user);
    await fill(textarea, "first pending");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.getByLabelText("Queued message")).toBeInTheDocument();
    });

    // Subsequent replacements in the same active-run window keep coalescing into
    // the same queued row, so they reuse the client id of the first send.
    textarea = await getActiveRunTextarea();
    await fill(textarea, "second pending");
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(replacedClientIds).toHaveLength(2);
    });

    expect(replacedClientIds[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(replacedClientIds[1]).toBe(replacedClientIds[0]);
  });

  it("hides the queued bubble when the real message with the same id lands", async () => {
    // Auto-send-on-run-complete reuses the queued bubble's client id as
    // chat_messages.id. Once the realtime fetch surfaces the real row,
    // the optimistic queued bubble must dedupe so we don't paint the
    // same user message twice.
    const user = userEvent.setup({ delay: null });
    let capturedClientId: string | undefined;
    const ctrl = mockChatLifecycle({
      // Seed at least one message in the initial page so `fetchNextPage$`
      // has a sinceId to advance from when the realtime event lands.
      chatMessages: [
        {
          role: "assistant",
          content: "earlier reply",
          runId: "run-prior",
          status: "completed",
          createdAt: "2026-03-09T00:00:00Z",
        },
      ],
      onPendingMessageReplace: (body) => {
        capturedClientId = body.clientMessageId;
      },
    });

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
    });

    const textarea = await startActiveRun(user);
    await fill(textarea, "auto sent body");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "auto sent body",
      );
      expect(capturedClientId).toBeTruthy();
      expect(
        hasSubscription(`chatThreadMessageCreated:${THREAD_ID}`),
      ).toBeTruthy();
    });

    // Server claims the queued message — clears the pending columns and
    // inserts a chat_messages row with id = capturedClientId. The realtime
    // fetcher pulls it via chatThreadMessagesContract.list.
    ctrl.clearPendingMessage();
    server.use(
      mockApi(chatThreadMessagesContract.list, ({ query, respond }) => {
        if (query.sinceId) {
          return respond(200, {
            messages: [
              {
                id: capturedClientId!,
                role: "user",
                content: "auto sent body",
                createdAt: "2026-03-10T00:00:30Z",
              },
            ],
          });
        }
        return respond(200, { messages: [] });
      }),
    );
    triggerAblyEvent(`chatThreadMessageCreated:${THREAD_ID}`);

    // The "Queued" indicator goes away (real row is authoritative)…
    await waitFor(() => {
      expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
    });

    // …and only ONE bubble carries the queued content — no flash of a
    // duplicate user message.
    expect(screen.getAllByText("auto sent body")).toHaveLength(1);
  });

  it("recalls queued message into the draft optimistically without waiting on the server", async () => {
    const user = userEvent.setup({ delay: null });
    // Server recall hangs forever — proves the UI does not depend on it.
    const serverGate = createDeferredPromise<void>(context.signal);
    let recallRequestSeen = false;
    mockChatLifecycle({
      recallGate: serverGate.promise,
      onPendingMessageRecall: () => {
        recallRequestSeen = true;
      },
    });

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
    });

    let textarea = await startActiveRun(user);
    await fill(textarea, "first pending");
    await user.keyboard("{Enter}");

    textarea = await getActiveRunTextarea();
    await fill(textarea, "second pending");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      const queued = screen.getByLabelText("Queued message");
      expect(queued).toHaveTextContent("first pending");
      expect(queued).toHaveTextContent("second pending");
    });

    await user.click(screen.getByLabelText("Recall queued message"));

    // Local state flips synchronously: queued card is gone and the draft
    // is repopulated even though the server recall is still in flight.
    await waitFor(() => {
      expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
    });
    textarea = await getActiveRunTextarea();
    expect(textarea.value).toBe("first pending\nsecond pending");

    // Fire-and-forget: the server recall is still kicked off so the
    // queued message is cleared on the backend too.
    await waitFor(() => {
      expect(recallRequestSeen).toBeTruthy();
    });

    // Clean up so the deferred handler does not leak into other tests.
    serverGate.resolve();
  });

  it("recalls queued attachments alongside the message text", async () => {
    const user = userEvent.setup({ delay: null });
    const pendingMessage: PendingMessage = {
      content: "queued with files",
      attachments: [
        {
          id: "att-1",
          url: "https://example.com/notes.txt",
          filename: "notes.txt",
          contentType: "text/plain",
          size: 12,
        },
      ],
      createdAt: "2026-03-10T00:01:00Z",
      updatedAt: "2026-03-10T00:01:00Z",
      clientMessageId: null,
    };
    mockChatLifecycle({ pendingMessage });

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
    });

    await startActiveRun(user);

    await waitFor(() => {
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "queued with files",
      );
    });

    await user.click(screen.getByLabelText("Recall queued message"));

    const textarea = await getActiveRunTextarea();
    await waitFor(() => {
      expect(textarea.value).toBe("queued with files");
    });
    expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
    // Restored attachment shows as a chip in the composer.
    await waitFor(() => {
      expect(screen.getByTitle("notes.txt")).toBeInTheDocument();
    });
  });

  it("never shows a loading spinner on the recall button", async () => {
    const user = userEvent.setup({ delay: null });
    const gate = createDeferredPromise<void>(context.signal);
    mockChatLifecycle({ recallGate: gate.promise });

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
    });

    const textarea = await startActiveRun(user);
    await fill(textarea, "draft to recall");
    await user.keyboard("{Enter}");

    const recallButton = await waitFor(() => {
      return screen.getByLabelText("Recall queued message");
    });
    expect(recallButton.querySelector(".animate-spin")).toBeNull();
    expect(recallButton).not.toBeDisabled();

    await user.click(recallButton);

    // The queued card disappears immediately — there is no spinner phase.
    await waitFor(() => {
      expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
    });

    gate.resolve();
  });

  it("reloads the thread when the server publishes chatThreadPendingMessageChanged", async () => {
    // Server's auto-send-on-run-complete flow consumes the queued message
    // and fires this Ably channel; the frontend must reload the thread on
    // receipt so the queued card disappears in sync with the new run.
    const initialPending: PendingMessage = {
      content: "auto-sent on run complete",
      attachments: null,
      createdAt: "2026-03-10T00:01:00Z",
      updatedAt: "2026-03-10T00:01:00Z",
      clientMessageId: null,
    };
    const ctrl = mockChatLifecycle({ pendingMessage: initialPending });

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "auto-sent on run complete",
      );
    });

    // Server-side: pending claimed and dispatched as a new run.
    ctrl.clearPendingMessage();
    changeChatPendingMessage(THREAD_ID);

    await waitFor(() => {
      expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
    });
  });

  it("does not queue keyboard sends while the feature switch is disabled", async () => {
    const user = userEvent.setup({ delay: null });
    let replaceCount = 0;
    mockChatLifecycle({
      onPendingMessageReplace: () => {
        replaceCount++;
      },
    });

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.QueueMessage]: false },
    });

    const textarea = await startActiveRun(user);
    await fill(textarea, "should stay in the composer");
    await user.keyboard("{Enter}");

    expect(replaceCount).toBe(0);
    expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
    expect(textarea.value).toBe("should stay in the composer");
  });

  it("disables the Recall button during the optimistic window and enables it once the server confirms", async () => {
    const user = userEvent.setup({ delay: null });
    const replaceGate = createDeferredPromise<void>(context.signal);

    mockChatLifecycle({
      replaceGate: replaceGate.promise,
    });

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
    });

    const textarea = await startActiveRun(user);
    await fill(textarea, "optimistic test");
    await user.keyboard("{Enter}");

    // The queued bubble renders immediately (optimistic), and the Recall
    // button stays disabled while the replace request is in flight.
    await waitFor(() => {
      expect(screen.getByLabelText("Queued message")).toBeInTheDocument();
      expect(screen.getByLabelText("Recall queued message")).toBeDisabled();
    });

    // Release the gate — the replace completes, reload runs, server confirms
    // the pending row, and the optimistic slot yields.
    replaceGate.resolve();

    await waitFor(() => {
      expect(screen.getByLabelText("Recall queued message")).not.toBeDisabled();
    });
  });

  describe("new thread optimistic queue handoff", () => {
    it("replays the latest queued snapshot when the new thread settles", async () => {
      const user = userEvent.setup({ delay: null });
      const sendDeferred = createDeferredPromise<void>(context.signal);
      const replacedContents: (string | undefined)[] = [];
      mockChatLifecycle({
        sendGate: sendDeferred.promise,
        onPendingMessageReplace: (body) => {
          replacedContents.push(body.content);
        },
      });

      detachedSetupPage({
        context,
        path: AGENT_CHAT_PATH,
        featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
      });

      await startOptimisticNewThreadRun(user);
      await sendQueuedMessage(user, SECOND_NEW_THREAD_MESSAGE);
      await sendQueuedMessage(user, THIRD_NEW_THREAD_MESSAGE);

      await expectQueuedSecondAndThird();
      expect(replacedContents).toStrictEqual([]);

      await settleOptimisticNewThread(sendDeferred);

      await waitFor(() => {
        expect(replacedContents).toStrictEqual([
          `${SECOND_NEW_THREAD_MESSAGE}\n${THIRD_NEW_THREAD_MESSAGE}`,
        ]);
      });
      await expectQueuedSecondAndThird();
    });

    it("keeps one queued row when the new thread settles after the second queued send", async () => {
      const user = userEvent.setup({ delay: null });
      const sendDeferred = createDeferredPromise<void>(context.signal);
      const replacedContents: (string | undefined)[] = [];
      mockChatLifecycle({
        sendGate: sendDeferred.promise,
        onPendingMessageReplace: (body) => {
          replacedContents.push(body.content);
        },
      });

      detachedSetupPage({
        context,
        path: AGENT_CHAT_PATH,
        featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
      });

      await startOptimisticNewThreadRun(user);
      await sendQueuedMessage(user, SECOND_NEW_THREAD_MESSAGE);
      await waitFor(() => {
        expect(screen.getByLabelText("Queued message")).toHaveTextContent(
          SECOND_NEW_THREAD_MESSAGE,
        );
      });

      await settleOptimisticNewThread(sendDeferred);
      await waitFor(() => {
        expect(replacedContents).toStrictEqual([SECOND_NEW_THREAD_MESSAGE]);
      });

      await sendQueuedMessage(user, THIRD_NEW_THREAD_MESSAGE);

      await waitFor(() => {
        expect(replacedContents).toStrictEqual([
          SECOND_NEW_THREAD_MESSAGE,
          `${SECOND_NEW_THREAD_MESSAGE}\n${THIRD_NEW_THREAD_MESSAGE}`,
        ]);
      });
      await expectQueuedSecondAndThird();
    });

    it("keeps one queued row when the new thread settles before the second and third sends", async () => {
      const user = userEvent.setup({ delay: null });
      const sendDeferred = createDeferredPromise<void>(context.signal);
      const replacedContents: (string | undefined)[] = [];
      mockChatLifecycle({
        sendGate: sendDeferred.promise,
        onPendingMessageReplace: (body) => {
          replacedContents.push(body.content);
        },
      });

      detachedSetupPage({
        context,
        path: AGENT_CHAT_PATH,
        featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
      });

      await startOptimisticNewThreadRun(user);
      await settleOptimisticNewThread(sendDeferred);

      await sendQueuedMessage(user, SECOND_NEW_THREAD_MESSAGE);
      await sendQueuedMessage(user, THIRD_NEW_THREAD_MESSAGE);

      await waitFor(() => {
        expect(replacedContents).toStrictEqual([
          SECOND_NEW_THREAD_MESSAGE,
          `${SECOND_NEW_THREAD_MESSAGE}\n${THIRD_NEW_THREAD_MESSAGE}`,
        ]);
      });
      await expectQueuedSecondAndThird();
    });
  });

  describe("send button queues during active run when input has content", () => {
    it("shows Send button (not Stop) during active run when composer has content and clicking queues", async () => {
      const user = userEvent.setup({ delay: null });
      const replacedContents: (string | undefined)[] = [];
      mockChatLifecycle({
        onPendingMessageReplace: (body) => {
          replacedContents.push(body.content);
        },
      });

      detachedSetupPage({
        context,
        path: CHAT_PATH,
        featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
      });

      const textarea = await startActiveRun(user);

      // With content in the input, the Send button should be visible (not Stop)
      await fill(textarea, "queued by button");
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();

      // Clicking the Send button during an active run should queue the message
      click(screen.getByLabelText("Send"));

      await waitFor(() => {
        expect(screen.getByLabelText("Queued message")).toBeInTheDocument();
        expect(screen.getByText("queued by button")).toBeInTheDocument();
      });
      expect(textarea.value).toBe("");
      expect(replacedContents).toStrictEqual(["queued by button"]);
    });

    it("shows Stop button during active run when composer is empty", async () => {
      const user = userEvent.setup({ delay: null });
      mockChatLifecycle();

      detachedSetupPage({
        context,
        path: CHAT_PATH,
        featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
      });

      // After sendMessageInUI, the composer is cleared, so Stop should be visible
      const textarea = await startActiveRun(user);

      // Empty composer → Stop button
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
      expect(screen.queryByLabelText("Send")).not.toBeInTheDocument();
      expect(textarea.value).toBe("");
    });

    it("clicking Stop with a queued message recalls it to draft and cancels the run", async () => {
      const user = userEvent.setup({ delay: null });
      const ctrl = mockChatLifecycle();

      detachedSetupPage({
        context,
        path: CHAT_PATH,
        featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
      });

      let textarea = await startActiveRun(user);

      // Queue a message first
      await fill(textarea, "message to be recalled");
      await user.keyboard("{Enter}");

      await waitFor(() => {
        expect(screen.getByLabelText("Queued message")).toBeInTheDocument();
      });

      // Now the composer is empty, Stop button should be visible
      textarea = await getActiveRunTextarea();
      expect(textarea.value).toBe("");

      // Click Stop — should recall the queued message AND cancel the run
      click(screen.getByLabelText("Stop"));
      ctrl.cancelRun();

      // The queued message should be recalled into the draft
      await waitFor(() => {
        expect(
          screen.queryByLabelText("Queued message"),
        ).not.toBeInTheDocument();
      });

      // The textarea from line 508 still references the same DOM element
      // after cancel, but getActiveRunTextarea() would fail because the
      // placeholder reverts from "Type your next message" to PLACEHOLDER.
      textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
      await waitFor(() => {
        expect(textarea.value).toBe("message to be recalled");
      });

      // After cancel, the run ends and Send button returns
      await waitFor(() => {
        expect(screen.getByLabelText("Send")).toBeInTheDocument();
        expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
      });
    });

    it("clicking Stop with no queued message only cancels the run", async () => {
      const user = userEvent.setup({ delay: null });
      const ctrl = mockChatLifecycle();

      detachedSetupPage({
        context,
        path: CHAT_PATH,
        featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
      });

      const textarea = await startActiveRun(user);

      // No queued message, just click Stop
      click(screen.getByLabelText("Stop"));
      ctrl.cancelRun();

      // After cancel, the run ends and Send button returns
      await waitFor(() => {
        expect(screen.getByLabelText("Send")).toBeInTheDocument();
        expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
      });

      // Draft should still be empty (nothing to recall)
      await waitFor(() => {
        expect(textarea.value).toBe("");
      });
    });
  });
});
