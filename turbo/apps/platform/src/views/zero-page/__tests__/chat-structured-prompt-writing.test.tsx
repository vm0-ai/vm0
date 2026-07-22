import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type {
  PersistedAttachment,
  UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  activeRunComposer,
  mockChatLifecycle,
  PLACEHOLDER,
  sendMessageInUI,
} from "./chat-test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "b0000000-0000-4000-a000-000000000951";

interface SentMessageCapture {
  readonly prompt?: string;
  readonly structuredPrompt?: UserMessageDocument;
  readonly attachFiles?: readonly {
    readonly id: string;
    readonly filename: string;
    readonly contentType: string;
    readonly size: number;
  }[];
}

interface QueuedMessageCapture {
  readonly content?: string;
  readonly structuredPrompt?: UserMessageDocument;
  readonly attachments?: readonly PersistedAttachment[];
}

describe("structured prompt writes", () => {
  it("writes one ordered snapshot for a new-thread message", async () => {
    const user = userEvent.setup({ delay: null });
    let sent: SentMessageCapture | null = null;
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        sent = body;
      },
    });
    context.mocks.upload.success({
      id: "upload-brief",
      filename: "brief.txt",
      contentType: "text/plain",
      size: 12,
      url: "https://cdn.vm7.io/artifacts/test/upload-brief/brief.txt",
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.StructuredPrompt]: true },
    });

    const composer = await screen.findByPlaceholderText(PLACEHOLDER);
    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) {
      throw new Error("File input not found");
    }
    await user.upload(
      fileInput,
      new File(["launch brief"], "brief.txt", { type: "text/plain" }),
    );
    await screen.findByLabelText("Remove brief.txt");
    await sendMessageInUI(user, composer, "Review the launch brief");

    await waitFor(() => {
      expect(sent).toMatchObject({
        prompt: "Review the launch brief",
        structuredPrompt: {
          version: 1,
          parts: [
            {
              type: "file",
              fileId: "upload-brief",
              filenameSnapshot: "brief.txt",
              contentType: "text/plain",
            },
            { type: "text", text: "Review the launch brief" },
          ],
        },
      });
    });
  });

  it.each([
    { enabled: true, label: "enabled" },
    { enabled: false, label: "disabled" },
  ])(
    "applies the $label switch state to existing-thread writes",
    async ({ enabled }) => {
      const user = userEvent.setup({ delay: null });
      let sent: SentMessageCapture | null = null;
      mockChatLifecycle(context, {
        threadId: THREAD_ID,
        onRunCreate: (body) => {
          sent = body;
        },
      });

      detachedSetupPage({
        context,
        path: `/chats/${THREAD_ID}`,
        featureSwitches: { [FeatureSwitchKey.StructuredPrompt]: enabled },
      });

      const composer = await screen.findByRole("textbox", {
        name: "Message",
      });
      await sendMessageInUI(user, composer, "Keep the legacy prompt too");

      await waitFor(() => {
        expect(sent).not.toBeNull();
      });
      if (enabled) {
        expect(sent).toMatchObject({
          prompt: "Keep the legacy prompt too",
          structuredPrompt: {
            version: 1,
            parts: [{ type: "text", text: "Keep the legacy prompt too" }],
          },
        });
      } else {
        expect(sent).not.toHaveProperty("structuredPrompt");
      }
    },
  );

  it("queues the committed IME snapshot with the enabled switch", async () => {
    let queued: QueuedMessageCapture | null = null;
    const appendGate = context.mocks.deferred<void>();
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      appendGate: appendGate.promise,
      chatMessages: [
        {
          id: "msg-active-user",
          role: "user",
          content: "Start the active run",
          runId: "run-active",
          createdAt: "2026-07-21T10:00:00Z",
        },
        {
          id: "msg-active-assistant",
          role: "assistant",
          content: null,
          runId: "run-active",
          createdAt: "2026-07-21T10:00:01Z",
        },
      ],
      activeRunIds: ["run-active"],
      onQueuedMessageAppend: (body) => {
        queued = body;
      },
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.StructuredPrompt]: true },
    });

    await screen.findByLabelText("Stop");
    const composer = await activeRunComposer();
    await fill(composer, "排");
    fireEvent.compositionStart(composer, { data: "排" });
    const paragraph = composer.querySelector("p");
    if (!paragraph) {
      throw new Error("Composer paragraph not found");
    }
    paragraph.textContent = "排队完整内容";

    fireEvent.click(screen.getByLabelText("Send"));
    expect(queued).toBeNull();

    fireEvent.compositionEnd(composer, { data: "排队完整内容" });
    fireEvent.input(composer, {
      data: "排队完整内容",
      inputType: "insertCompositionText",
      isComposing: false,
    });

    await waitFor(() => {
      expect(queued).toMatchObject({
        content: "排队完整内容",
        structuredPrompt: {
          version: 1,
          parts: [{ type: "text", text: "排队完整内容" }],
        },
      });
    });
    expect(screen.getByLabelText("Queued message")).toHaveTextContent(
      "排队完整内容",
    );
    expect(composer).toHaveTextContent("");
    appendGate.resolve();
  });
});
