import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import type { PendingMessage } from "@vm0/api-contracts/contracts/chat-threads";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  click,
  detachedSetupPage,
  fill,
} from "../../../__tests__/page-helper.ts";
import {
  mockChatLifecycle,
  sendMessageInUI,
  PLACEHOLDER,
} from "./chat-test-helpers.ts";

const context = testContext();

const THREAD_ID = "thread-test-1";
const CHAT_PATH = `/chats/${THREAD_ID}`;

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

describe("composer Stop button + draft recall on cancel", () => {
  it("shows Send (not Stop) when draft has content during an active run", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle();

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
    });

    const textarea = await startActiveRun(user);

    // Empty composer during the active run → Stop button.
    expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    expect(screen.queryByLabelText("Send")).toBeNull();

    await fill(textarea, "draft while running");

    // Typing draft content swaps Stop → Send (still during the active run).
    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).toBeNull();
    });
  });

  it("queues the message when Send is clicked during an active run", async () => {
    const user = userEvent.setup({ delay: null });
    const appendedContents: (string | undefined)[] = [];
    mockChatLifecycle({
      onPendingMessageAppend: (body) => {
        appendedContents.push(body.content);
      },
    });

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
    });

    const textarea = await startActiveRun(user);
    await fill(textarea, "queued via send click");

    // Click — not Enter — to make sure the button click path also queues.
    const sendButton = await waitFor(() => {
      return screen.getByLabelText("Send");
    });
    click(sendButton);

    await waitFor(() => {
      expect(screen.getByLabelText("Queued message")).toBeInTheDocument();
      expect(screen.getByText("queued via send click")).toBeInTheDocument();
    });
    expect(appendedContents).toStrictEqual(["queued via send click"]);
    expect(textarea.value).toBe("");

    // Composer empty again → Stop button comes back.
    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
  });

  it("stop click recalls the queued message back into the draft and cancels the run", async () => {
    const user = userEvent.setup({ delay: null });
    let recallRequestSeen = false;
    const ctrl = mockChatLifecycle({
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
    await fill(textarea, "queued before stop");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "queued before stop",
      );
    });

    // Composer is empty after the queue — Stop button is visible.
    const stopButton = await waitFor(() => {
      return screen.getByLabelText("Stop");
    });
    click(stopButton);

    // Server-confirmed cancel — the run flips to cancelled, sending ends.
    ctrl.cancelRun();

    // Queued bubble disappears and the draft is repopulated with the
    // recalled content. The cancel completes and Send button is back.
    await waitFor(() => {
      expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).toBeNull();
    });

    textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    expect(textarea.value).toBe("queued before stop");

    await waitFor(() => {
      expect(recallRequestSeen).toBeTruthy();
    });
  });

  it("stop click recalls a server-side queued message even when nothing was just queued client-side", async () => {
    // Resume scenario: thread already has a pending message from a previous
    // session. The user clicks Stop while the run is active — recall should
    // still pull the persisted queue back into the draft.
    const user = userEvent.setup({ delay: null });
    const pendingMessage: PendingMessage = {
      content: "queued from earlier session",
      attachments: null,
      createdAt: "2026-03-10T00:01:00Z",
      updatedAt: "2026-03-10T00:01:00Z",
      clientMessageId: null,
    };
    let recallRequestSeen = false;
    const ctrl = mockChatLifecycle({
      pendingMessage,
      onPendingMessageRecall: () => {
        recallRequestSeen = true;
      },
    });

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
    });

    await startActiveRun(user);

    await waitFor(() => {
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "queued from earlier session",
      );
    });

    const stopButton = await waitFor(() => {
      return screen.getByLabelText("Stop");
    });
    click(stopButton);
    ctrl.cancelRun();

    await waitFor(() => {
      expect(recallRequestSeen).toBeTruthy();
      expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    expect(textarea.value).toBe("queued from earlier session");
  });

  it("stop click without a queued message just cancels the run", async () => {
    const user = userEvent.setup({ delay: null });
    let recallRequestSeen = false;
    const ctrl = mockChatLifecycle({
      onPendingMessageRecall: () => {
        recallRequestSeen = true;
      },
    });

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
    });

    await startActiveRun(user);

    const stopButton = await waitFor(() => {
      return screen.getByLabelText("Stop");
    });
    click(stopButton);
    ctrl.cancelRun();

    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).toBeNull();
    });

    // Recall route never fires when there is nothing to recall — the
    // platform command short-circuits before hitting the network.
    expect(recallRequestSeen).toBeFalsy();
  });
});
