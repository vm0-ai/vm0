import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { PersistedAttachment } from "@vm0/api-contracts/contracts/chat-threads";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  click,
  detachedSetupPage,
  fill,
} from "../../../__tests__/page-helper.ts";
import {
  activeRunTextarea,
  expectQueuedMessages,
  mockChatLifecycle,
  PLACEHOLDER,
  sendQueuedMessage,
  sendMessageInUI,
} from "./chat-test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "b0000000-0000-4000-a000-000000000901";
const CHAT_PATH = `/chats/${THREAD_ID}`;
const AGENT_CHAT_PATH = `/agents/${AGENT_ID}/chat`;

interface QueuedMessageCapture {
  content?: string;
  hasTextContent?: boolean;
  attachments?: PersistedAttachment[];
  clientMessageId: string;
}

async function startActiveRun(
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLTextAreaElement> {
  const textarea = await waitFor(() => {
    return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
  });
  await sendMessageInUI(user, textarea, "Start the active run");

  await waitFor(() => {
    expect(screen.getByLabelText("Stop")).toBeInTheDocument();
  });

  return activeRunTextarea();
}

function mockActiveRunThread(threadId: string): void {
  mockChatLifecycle(context, {
    threadId,
    chatMessages: [
      {
        id: `${threadId}-active-user`,
        role: "user",
        content: "Start the active run",
        runId: "run-active",
        createdAt: "2026-06-09T10:00:00Z",
      },
      {
        id: `${threadId}-active-assistant`,
        role: "assistant",
        content: null,
        runId: "run-active",
        createdAt: "2026-06-09T10:00:01Z",
      },
    ],
    activeRunIds: ["run-active"],
  });
}

describe("chat run queue", () => {
  it("shows a sent message and stop control while a new chat run is active", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context);

    detachedSetupPage({ context, path: AGENT_CHAT_PATH });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, textarea, "Summarize the launch plan");

    await waitFor(() => {
      expect(screen.getByText("Summarize the launch plan")).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
  });

  it("does not queue follow-ups while an optimistic new thread create is unsettled", async () => {
    const user = userEvent.setup({ delay: null });
    const sendGate = context.mocks.deferred<void>();
    const queuedBodies: QueuedMessageCapture[] = [];
    mockChatLifecycle(context, {
      sendGate: sendGate.promise,
      onQueuedMessageAppend: (body) => {
        queuedBodies.push(body);
      },
    });

    detachedSetupPage({ context, path: AGENT_CHAT_PATH });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, textarea, "First new-thread message");

    await waitFor(() => {
      expect(screen.getByText("First new-thread message")).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    await sendQueuedMessage(user, "Blocked follow-up");

    await waitFor(() => {
      expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
      expect(queuedBodies).toHaveLength(0);
    });

    sendGate.resolve();

    await waitFor(() => {
      expect(screen.getByText("First new-thread message")).toBeInTheDocument();
    });
  });

  it("replays recalled queued content during an active run", async () => {
    const user = userEvent.setup({ delay: null });
    mockActiveRunThread(THREAD_ID);

    detachedSetupPage({ context, path: CHAT_PATH });

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    await sendQueuedMessage(user, "First queued follow-up");
    await sendQueuedMessage(user, "Second queued follow-up");
    await expectQueuedMessages([
      "First queued follow-up",
      "Second queued follow-up",
    ]);

    click(screen.getAllByLabelText("Remove queued message")[0]!);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Type your next message/)).toHaveValue(
        "First queued follow-up",
      );
    });

    await fill(
      screen.getByPlaceholderText(/Type your next message/),
      "Replayed follow-up",
    );
    await user.keyboard("{Enter}");

    await expectQueuedMessages([
      "Second queued follow-up",
      "Replayed follow-up",
    ]);
  });

  it("queues an attachment-only follow-up during an active run", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "b0000000-0000-4000-a000-000000000902";
    let queuedBody: QueuedMessageCapture | null = null;

    mockChatLifecycle(context, {
      threadId,
      chatMessages: [
        {
          id: "msg-active-attachment-user",
          role: "user",
          content: "Start the active run",
          runId: "run-active",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-active-attachment-assistant",
          role: "assistant",
          content: null,
          runId: "run-active",
          createdAt: "2026-06-09T10:00:01Z",
        },
      ],
      activeRunIds: ["run-active"],
      onQueuedMessageAppend: (body) => {
        queuedBody = body;
      },
    });
    context.mocks.upload.success({
      id: "upload-notes",
      filename: "notes.txt",
      contentType: "text/plain",
      size: 12,
      url: "https://cdn.vm7.io/artifacts/test/upload-notes/notes.txt",
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) {
      throw new Error("file input not found");
    }
    await user.upload(
      fileInput,
      new File(["release note"], "notes.txt", { type: "text/plain" }),
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Remove notes.txt")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Send"));

    await waitFor(() => {
      expect(screen.getByText("1 message waiting to send")).toBeInTheDocument();
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "(see attached files)",
      );
      expect(queuedBody).toMatchObject({
        content: "(see attached files)",
        hasTextContent: false,
        attachments: [
          {
            id: "upload-notes",
            filename: "notes.txt",
            contentType: "text/plain",
            size: 12,
            url: "https://cdn.vm7.io/artifacts/test/upload-notes/notes.txt",
          },
        ],
      });
    });
  });

  it("recalls queued content and clears the thinking indicator when the active run is stopped", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({ context, path: CHAT_PATH });

    await startActiveRun(user);
    await sendQueuedMessage(user, "First queued");
    await sendQueuedMessage(user, "Second queued");
    await expectQueuedMessages(["First queued", "Second queued"]);

    click(screen.getByLabelText("Stop"));

    await waitFor(() => {
      expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
      expect(
        document.querySelector("[data-thinking-indicator]"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText("Paused mid-thought — pick it back up whenever."),
      ).toBeInTheDocument();
    });
  });
});
