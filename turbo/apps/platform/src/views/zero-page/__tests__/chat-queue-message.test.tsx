import { describe, expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  click,
  detachedSetupPage,
  fill,
} from "../../../__tests__/page-helper.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { optimisticChatThread$ } from "../../../signals/chat-page/optimistic-chat-thread-state.ts";
import { createOptimisticChatMessagesForThread } from "../../../signals/chat-page/optimistic-chat-messages.ts";
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

async function expectQueuedMessages(contents: string[]): Promise<void> {
  await waitFor(() => {
    const queuedMessages = screen.getAllByLabelText("Queued message");
    expect(queuedMessages).toHaveLength(contents.length);
    for (const [index, content] of contents.entries()) {
      expect(queuedMessages[index]).toHaveTextContent(content);
    }
  });
}

async function expectNoRecalledMessages(): Promise<void> {
  await waitFor(() => {
    expect(screen.queryByLabelText("Recalled message")).not.toBeInTheDocument();
  });
}

async function expectQueuedMessagesBelowThinkingIndicator(
  contents: string[],
): Promise<void> {
  await waitFor(() => {
    const thinkingIndicator = document.querySelector<HTMLElement>(
      "[data-thinking-indicator]",
    );
    expect(thinkingIndicator).not.toBeNull();

    const queuedMessages = screen.getAllByLabelText("Queued message");
    expect(queuedMessages).toHaveLength(contents.length);
    for (const [index, content] of contents.entries()) {
      const queuedMessage = queuedMessages[index]!;
      expect(queuedMessage).toHaveTextContent(content);
      expect(
        thinkingIndicator!.compareDocumentPosition(queuedMessage) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
    }
  });
}

describe("chat queued user messages", () => {
  it("shows the thinking indicator immediately for an optimistic run user message", async () => {
    const user = userEvent.setup({ delay: null });
    const sendDeferred = createDeferredPromise<void>(context.signal);
    mockChatLifecycle({
      sendGate: sendDeferred.promise,
    });

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, textarea, "start optimistically");

    await waitFor(() => {
      expect(screen.getByText("start optimistically")).toBeInTheDocument();
      expect(
        document.querySelector("[data-thinking-indicator]"),
      ).toBeInTheDocument();
    });

    act(() => {
      sendDeferred.resolve();
    });
  });

  it("keeps the thinking indicator when the optimistic run user message settles", async () => {
    const user = userEvent.setup({ delay: null });
    const sendDeferred = createDeferredPromise<void>(context.signal);
    const optimisticMessages$ =
      createOptimisticChatMessagesForThread(THREAD_ID);
    const message = "settle without thinking flicker";
    const missingIndicatorSnapshots: string[] = [];
    mockChatLifecycle({
      sendGate: sendDeferred.promise,
    });

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, textarea, message);

    await waitFor(() => {
      expect(screen.getByText(message)).toBeInTheDocument();
      expect(
        document.querySelector("[data-thinking-indicator]"),
      ).toBeInTheDocument();
      expect(
        context.store.get(optimisticMessages$).some((entry) => {
          return entry.message.content === message;
        }),
      ).toBeTruthy();
    });

    const observer = new MutationObserver(() => {
      if (
        screen.queryByText(message) &&
        document.querySelector("[data-thinking-indicator]") === null
      ) {
        missingIndicatorSnapshots.push(document.body.textContent ?? "");
      }
    });
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
    });

    act(() => {
      sendDeferred.resolve();
    });

    await waitFor(() => {
      expect(
        context.store.get(optimisticMessages$).some((entry) => {
          return entry.message.content === message;
        }),
      ).toBeFalsy();
    });
    observer.disconnect();

    expect(missingIndicatorSnapshots).toHaveLength(0);
  });

  it("queues keyboard sends during an active run as independent user messages", async () => {
    const user = userEvent.setup({ delay: null });
    const appendedContents: string[] = [];
    const appendedClientIds: string[] = [];
    mockChatLifecycle({
      onQueuedMessageAppend: (body) => {
        appendedContents.push(body.content ?? "");
        appendedClientIds.push(body.clientMessageId);
      },
    });

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
    });

    await startActiveRun(user);
    await sendQueuedMessage(user, "first queued");
    await sendQueuedMessage(user, "second queued");

    await expectQueuedMessagesBelowThinkingIndicator([
      "first queued",
      "second queued",
    ]);
    expect(appendedContents).toStrictEqual(["first queued", "second queued"]);
    expect(new Set(appendedClientIds).size).toBe(2);
  });

  it("recalls a queued message back into the composer", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle();

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
    });

    await startActiveRun(user);
    await sendQueuedMessage(user, "recall this message");
    await expectQueuedMessages(["recall this message"]);

    click(screen.getByLabelText("Remove queued message"));

    await waitFor(() => {
      expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
      expect(
        screen.queryByLabelText("Recalled message"),
      ).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText(/Type your next message/)).toHaveValue(
        "recall this message",
      );
    });
  });

  it("recalls queued messages when stopping the active run", async () => {
    const user = userEvent.setup({ delay: null });
    const recalledTargets: string[] = [];
    const interruptedRuns: string[] = [];
    mockChatLifecycle({
      onInterruptMessageAppend: (body) => {
        interruptedRuns.push(body.interruptsRunId);
      },
      onRecallMessageAppend: (body) => {
        recalledTargets.push(body.revokesMessageId);
      },
    });

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
    });

    await startActiveRun(user);
    await sendQueuedMessage(user, "first queued");
    await sendQueuedMessage(user, "second queued");
    await expectQueuedMessages(["first queued", "second queued"]);

    click(screen.getByLabelText("Stop"));

    await waitFor(() => {
      expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
      expect(interruptedRuns).toHaveLength(1);
      expect(recalledTargets).toHaveLength(2);
    });
    await expectNoRecalledMessages();
  });

  it("stops the active run and recalls three queued messages without showing a thinking indicator", async () => {
    const user = userEvent.setup({ delay: null });
    const interruptedRuns: string[] = [];
    const recalledTargets: string[] = [];
    mockChatLifecycle({
      onInterruptMessageAppend: (body) => {
        interruptedRuns.push(body.interruptsRunId);
      },
      onRecallMessageAppend: (body) => {
        recalledTargets.push(body.revokesMessageId);
      },
    });

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
    });

    await startActiveRun(user);
    await sendQueuedMessage(user, "first queued");
    await sendQueuedMessage(user, "second queued");
    await sendQueuedMessage(user, "third queued");
    await expectQueuedMessages([
      "first queued",
      "second queued",
      "third queued",
    ]);

    click(screen.getByLabelText("Stop"));

    await waitFor(() => {
      expect(
        screen.getAllByText("Paused mid-thought — pick it back up whenever."),
      ).toHaveLength(1);
      expect(
        screen.getByText("Paused mid-thought — pick it back up whenever."),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
      expect(interruptedRuns).toHaveLength(1);
      expect(recalledTargets).toHaveLength(3);
    });
    await expectNoRecalledMessages();
    await waitFor(() => {
      expect(
        document.querySelector("[data-thinking-indicator]"),
      ).not.toBeInTheDocument();
    });
  });

  it("replays queued sends when a new optimistic thread settles after two queued messages", async () => {
    const user = userEvent.setup({ delay: null });
    const sendDeferred = createDeferredPromise<void>(context.signal);
    const appendedContents: string[] = [];
    mockChatLifecycle({
      sendGate: sendDeferred.promise,
      onQueuedMessageAppend: (body) => {
        appendedContents.push(body.content ?? "");
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
    await expectQueuedMessages([
      SECOND_NEW_THREAD_MESSAGE,
      THIRD_NEW_THREAD_MESSAGE,
    ]);

    await settleOptimisticNewThread(sendDeferred);

    await waitFor(() => {
      expect(appendedContents).toStrictEqual([
        SECOND_NEW_THREAD_MESSAGE,
        THIRD_NEW_THREAD_MESSAGE,
      ]);
    });
    await expectQueuedMessages([
      SECOND_NEW_THREAD_MESSAGE,
      THIRD_NEW_THREAD_MESSAGE,
    ]);
  });

  it("keeps queued sends independent when the optimistic thread settles between the second and third sends", async () => {
    const user = userEvent.setup({ delay: null });
    const sendDeferred = createDeferredPromise<void>(context.signal);
    const appendedContents: string[] = [];
    mockChatLifecycle({
      sendGate: sendDeferred.promise,
      onQueuedMessageAppend: (body) => {
        appendedContents.push(body.content ?? "");
      },
    });

    detachedSetupPage({
      context,
      path: AGENT_CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
    });

    await startOptimisticNewThreadRun(user);
    await sendQueuedMessage(user, SECOND_NEW_THREAD_MESSAGE);
    await settleOptimisticNewThread(sendDeferred);
    await sendQueuedMessage(user, THIRD_NEW_THREAD_MESSAGE);

    await waitFor(() => {
      expect(appendedContents).toStrictEqual([
        SECOND_NEW_THREAD_MESSAGE,
        THIRD_NEW_THREAD_MESSAGE,
      ]);
    });
    await expectQueuedMessages([
      SECOND_NEW_THREAD_MESSAGE,
      THIRD_NEW_THREAD_MESSAGE,
    ]);
  });

  it("keeps queued sends independent when the optimistic thread settles before both queued sends", async () => {
    const user = userEvent.setup({ delay: null });
    const sendDeferred = createDeferredPromise<void>(context.signal);
    const appendedContents: string[] = [];
    mockChatLifecycle({
      sendGate: sendDeferred.promise,
      onQueuedMessageAppend: (body) => {
        appendedContents.push(body.content ?? "");
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
      expect(appendedContents).toStrictEqual([
        SECOND_NEW_THREAD_MESSAGE,
        THIRD_NEW_THREAD_MESSAGE,
      ]);
    });
    await expectQueuedMessages([
      SECOND_NEW_THREAD_MESSAGE,
      THIRD_NEW_THREAD_MESSAGE,
    ]);
  });
});
