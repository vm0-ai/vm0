import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type {
  GenerationTemplateRequest,
  ModelSelectionRequest,
} from "@vm0/api-contracts/contracts/chat-threads";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@vm0/core";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

const FEEDBACK_THREAD_ID = "b0000000-0000-4000-a000-000000000703";

interface RunCreateCapture {
  prompt?: string;
  attachFiles?: {
    id: string;
    filename: string;
    contentType: string;
    size: number;
  }[];
  hasTextContent?: boolean;
  generationTemplate?: GenerationTemplateRequest;
  modelSelection?: ModelSelectionRequest | null;
  computerUseHostId?: string | null;
  clientMessageId?: string;
}

function selectTextForInlineFeedback(element: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  Object.defineProperty(range, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      return new DOMRect(24, 32, 180, 20);
    },
  });

  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Selection API is not available");
  }
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
}

function buttonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

describe("chat inline feedback", () => {
  it("turns selected assistant text into an inline feedback follow-up", async () => {
    const user = userEvent.setup({ delay: null });
    const assistantReply = "The rollout dates are unclear in this summary.";
    const sentPrompts: string[] = [];
    context.mocks.browser.clipboardWriteText();

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      chatMessages: [
        {
          id: "msg-feedback-user",
          role: "user",
          content: "Review this launch summary",
          runId: "run-feedback",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-feedback-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-feedback",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
      onRunCreate: (body) => {
        if (body.prompt !== undefined) {
          sentPrompts.push(body.prompt);
        }
      },
    });

    detachedSetupPage({
      context,
      path: `/chats/${FEEDBACK_THREAD_ID}`,
    });

    const assistantReplyElement = await screen.findByText(assistantReply);
    selectTextForInlineFeedback(assistantReplyElement);

    await waitFor(() => {
      expect(screen.getByText("Provide feedback")).toBeInTheDocument();
    });

    await user.click(buttonByText("Copy"));

    await waitFor(() => {
      expect(screen.getByText("Copied")).toBeInTheDocument();
    });

    selectTextForInlineFeedback(assistantReplyElement);
    await user.click(buttonByText("Provide feedback"));

    const feedbackComment = await screen.findByPlaceholderText(
      "What should change about this?",
    );
    await fill(feedbackComment, "Mention the dates before the risk summary.");
    expect(feedbackComment).toHaveValue(
      "Mention the dates before the risk summary.",
    );

    await user.click(screen.getByLabelText("Send feedback"));

    await waitFor(() => {
      expect(sentPrompts).toHaveLength(1);
    });
    expect(sentPrompts[0]).toContain("Feedback on this part of your reply:");
    expect(sentPrompts[0]).toContain(
      "> The rollout dates are unclear in this summary.",
    );
    expect(sentPrompts[0]).toContain(
      "Mention the dates before the risk summary.",
    );

    expect(
      screen.queryByPlaceholderText("What should change about this?"),
    ).not.toBeInTheDocument();
  });

  it("dismisses the inline feedback toolbar when a click clears the selection", async () => {
    const assistantReply = "The rollout dates are unclear in this summary.";

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      chatMessages: [
        {
          id: "msg-feedback-dismiss-user",
          role: "user",
          content: "Review this launch summary",
          runId: "run-feedback-dismiss",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-feedback-dismiss-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-feedback-dismiss",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${FEEDBACK_THREAD_ID}`,
    });

    const assistantReplyElement = await screen.findByText(assistantReply);
    selectTextForInlineFeedback(assistantReplyElement);
    await waitFor(() => {
      expect(screen.getByText("Provide feedback")).toBeInTheDocument();
    });

    // Click inside the selection: in a real browser mouseup fires first and the
    // selection collapses right after. Mirror that order so the deferred read
    // sees the cleared selection and dismisses the toolbar.
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    window.getSelection()?.removeAllRanges();

    await waitFor(() => {
      expect(screen.queryByText("Provide feedback")).not.toBeInTheDocument();
    });
  });

  it("sends inline feedback with selected template and draft attachments", async () => {
    const user = userEvent.setup({ delay: null });
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    const templateChipLabel = template.title;
    const assistantReply = "The launch summary needs more source context.";
    const sentBodies: RunCreateCapture[] = [];

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      selectedModel: "claude-sonnet-4-6",
      chatMessages: [
        {
          id: "msg-feedback-attachment-user",
          role: "user",
          content: "Review this launch summary",
          runId: "run-feedback-attachment",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-feedback-attachment-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-feedback-attachment",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
      onRunCreate: (body) => {
        sentBodies.push(body);
      },
    });
    context.mocks.upload.success({
      id: "upload-feedback-brief",
      filename: "feedback-brief.txt",
      contentType: "text/plain",
      size: 14,
      url: "https://cdn.vm7.io/artifacts/test/upload-feedback-brief/feedback-brief.txt",
    });

    detachedSetupPage({
      context,
      path: `/chats/${FEEDBACK_THREAD_ID}`,
    });

    const assistantReplyElement = await screen.findByText(assistantReply);

    await user.click(await screen.findByLabelText("Template"));
    await user.click(
      await screen.findByLabelText(
        `Preview ${template.title} at current slide`,
      ),
    );
    await user.click(await screen.findByLabelText("Select style Gold Luxe"));
    await user.click(
      await screen.findByLabelText(`Select template ${template.title}`),
    );
    await waitFor(() => {
      expect(
        screen.getByLabelText(`Remove template ${templateChipLabel}`),
      ).toBeInTheDocument();
    });

    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) {
      throw new Error("file input not found");
    }
    await user.upload(
      fileInput,
      new File(["feedback notes"], "feedback-brief.txt", {
        type: "text/plain",
      }),
    );
    await waitFor(() => {
      expect(
        screen.getByLabelText("Remove feedback-brief.txt"),
      ).toBeInTheDocument();
    });

    selectTextForInlineFeedback(assistantReplyElement);
    await waitFor(() => {
      expect(screen.getByText("Provide feedback")).toBeInTheDocument();
    });
    await user.click(buttonByText("Provide feedback"));
    window.getSelection()?.removeAllRanges();

    await fill(
      await screen.findByPlaceholderText("What should change about this?"),
      "Use the attached brief as supporting context.",
    );
    expect(
      screen.getByLabelText(`Remove template ${templateChipLabel}`),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Remove feedback-brief.txt"),
    ).toBeInTheDocument();

    await user.click(screen.getByLabelText("Send feedback"));

    await waitFor(() => {
      expect(sentBodies[0]).toMatchObject({
        attachFiles: [
          {
            id: "upload-feedback-brief",
            filename: "feedback-brief.txt",
            contentType: "text/plain",
            size: 14,
          },
        ],
        generationTemplate: {
          type: "presentation",
          selection: {
            colorSystemId: "color-system:gold-luxe",
            designSystemId: template.designSystemId,
            templateId: template.templateId,
            previewUrl: template.embedUrl,
          },
        },
        modelSelection: {
          modelProviderId: "00000000-0000-4000-8000-000000000000",
          selectedModel: "claude-sonnet-4-6",
        },
      });
    });
    const sentBody = sentBodies[0];
    if (!sentBody) {
      throw new Error("feedback send body not captured");
    }
    expect(sentBody?.prompt).toContain(
      "Use the attached brief as supporting context.",
    );
  });

  it("keeps committed inline feedback while drafting another selected comment", async () => {
    const user = userEvent.setup({ delay: null });
    const assistantReply = "The launch summary needs clearer risk ownership.";

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      chatMessages: [
        {
          id: "msg-feedback-summary-user",
          role: "user",
          content: "Review this launch summary",
          runId: "run-feedback-summary",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-feedback-summary-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-feedback-summary",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${FEEDBACK_THREAD_ID}`,
    });

    const assistantReplyElement = await screen.findByText(assistantReply);
    selectTextForInlineFeedback(assistantReplyElement);
    await waitFor(() => {
      expect(screen.getByText("Provide feedback")).toBeInTheDocument();
    });
    await user.click(buttonByText("Provide feedback"));
    // Clicking into a note collapses the text selection in a real browser;
    // mirror that so later clicks do not re-open the selection toolbar.
    window.getSelection()?.removeAllRanges();

    const firstComment = await screen.findByPlaceholderText(
      "What should change about this?",
    );
    await fill(firstComment, "Assign each risk to an owner.");

    selectTextForInlineFeedback(assistantReplyElement);
    await waitFor(() => {
      expect(screen.getByText("Provide feedback")).toBeInTheDocument();
    });
    await user.click(buttonByText("Provide feedback"));
    window.getSelection()?.removeAllRanges();

    const comments = screen.getAllByPlaceholderText(
      "What should change about this?",
    );
    expect(comments).toHaveLength(2);
    // The first note persists on top; the newest fragment sits below it with
    // an empty note, taking the composer position nearest Send.
    expect(comments[0]).toHaveValue("Assign each risk to an owner.");
    expect(comments[1]).toHaveValue("");

    // Removing the empty draft row leaves the noted fragment intact.
    await user.click(screen.getAllByLabelText("Remove feedback")[1]);

    await waitFor(() => {
      expect(
        screen.getAllByPlaceholderText("What should change about this?"),
      ).toHaveLength(1);
    });
    expect(
      screen.getByPlaceholderText("What should change about this?"),
    ).toHaveValue("Assign each risk to an owner.");
  });

  it("edits and sends multiple inline feedback comments", async () => {
    const user = userEvent.setup({ delay: null });
    const assistantReply = "The launch summary needs clearer risk ownership.";
    const sentPrompts: string[] = [];

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      chatMessages: [
        {
          id: "msg-feedback-edit-user",
          role: "user",
          content: "Review this launch summary",
          runId: "run-feedback-edit",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-feedback-edit-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-feedback-edit",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
      onRunCreate: (body) => {
        if (body.prompt !== undefined) {
          sentPrompts.push(body.prompt);
        }
      },
    });

    detachedSetupPage({
      context,
      path: `/chats/${FEEDBACK_THREAD_ID}`,
    });

    const assistantReplyElement = await screen.findByText(assistantReply);

    selectTextForInlineFeedback(assistantReplyElement);
    await waitFor(() => {
      expect(screen.getByText("Provide feedback")).toBeInTheDocument();
    });
    await user.click(buttonByText("Provide feedback"));
    // Clicking into a note collapses the text selection in a real browser;
    // mirror that so later clicks do not re-open the selection toolbar.
    window.getSelection()?.removeAllRanges();

    await fill(
      await screen.findByPlaceholderText("What should change about this?"),
      "Assign each risk to an owner.",
    );

    selectTextForInlineFeedback(assistantReplyElement);
    await waitFor(() => {
      expect(screen.getByText("Provide feedback")).toBeInTheDocument();
    });
    await user.click(buttonByText("Provide feedback"));
    window.getSelection()?.removeAllRanges();

    await fill(
      screen.getAllByPlaceholderText("What should change about this?")[1],
      "Mention launch dates before the risk summary.",
    );

    // Edit the first fragment's note in place — the oldest sits on top.
    const editingComment = screen.getAllByPlaceholderText(
      "What should change about this?",
    )[0];
    expect(editingComment).toHaveValue("Assign each risk to an owner.");
    await fill(editingComment, "Assign named owners to each launch risk.");
    expect(editingComment).toHaveFocus();
    expect(editingComment).toHaveValue(
      "Assign named owners to each launch risk.",
    );
    expect(
      screen.getAllByPlaceholderText("What should change about this?")[1],
    ).toHaveValue("Mention launch dates before the risk summary.");

    await user.click(screen.getByLabelText("Send feedback"));

    await waitFor(() => {
      expect(sentPrompts).toHaveLength(1);
    });

    expect(sentPrompts[0]).toContain("Feedback on 2 parts of your reply:");
    expect(sentPrompts[0]).toContain(
      "> The launch summary needs clearer risk ownership.",
    );
    expect(sentPrompts[0]).toContain(
      "Assign named owners to each launch risk.",
    );
    expect(sentPrompts[0]).toContain(
      "Mention launch dates before the risk summary.",
    );
  });
});
