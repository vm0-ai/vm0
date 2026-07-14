import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GenerationTemplateRequest } from "@vm0/api-contracts/contracts/chat-threads";
import type { OrgModelPolicy } from "@vm0/api-contracts/contracts/model-providers";
import { zeroModelPoliciesMainContract } from "@vm0/api-contracts/contracts/zero-model-policies";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@vm0/core";
import { toast } from "@vm0/ui/components/ui/sonner";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

const FEEDBACK_THREAD_ID = "b0000000-0000-4000-a000-000000000703";

interface ModelSelectionRequest {
  readonly modelProviderId: string;
  readonly selectedModel: string;
}

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

function selectTextRangeForInlineFeedback(element: HTMLElement): void {
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
}

function selectTextForInlineFeedback(element: HTMLElement): void {
  selectTextRangeForInlineFeedback(element);
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
}

function waitForDeferredSelectionCapture(): Promise<void> {
  const deferred = createDeferredPromise<void>(context.signal);
  window.setTimeout(() => {
    if (!deferred.settled()) {
      deferred.resolve(undefined);
    }
  });
  return deferred.promise;
}

function selectTextAcrossElementsForInlineFeedback(
  startElement: HTMLElement,
  endElement: HTMLElement,
): void {
  const startNode = startElement.firstChild;
  const endNode = endElement.firstChild;
  if (!(startNode instanceof Text) || !(endNode instanceof Text)) {
    throw new Error("Selection endpoints must be text nodes");
  }
  const range = document.createRange();
  range.setStart(startNode, 0);
  range.setEnd(endNode, endNode.textContent?.length ?? 0);
  const assistantGroup = startElement.closest('[data-role="assistant"]');
  if (!assistantGroup) {
    throw new Error("Assistant group not found");
  }
  // Browser multi-line selections can report a message group rather than the
  // assistant bubble as the range's common ancestor.
  Object.defineProperty(range, "commonAncestorContainer", {
    configurable: true,
    value: assistantGroup,
  });
  Object.defineProperty(range, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      return new DOMRect(24, 32, 180, 44);
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
    const label = candidate.textContent?.replace(/\s+/g, " ").trim();
    return (
      label === text ||
      label === `${text}C` ||
      label === `${text} C` ||
      label === `${text}F` ||
      label === `${text} F`
    );
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

async function findComposerEditor(): Promise<HTMLElement> {
  return await waitFor(() => {
    const editor = document.querySelector(
      '.zero-composer [contenteditable="true"]',
    );
    if (!(editor instanceof HTMLElement)) {
      throw new Error("Composer editor not found");
    }
    return editor;
  });
}

function dispatchDocumentShortcut(key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
  });
  document.dispatchEvent(event);
  return event;
}

describe("chat inline feedback", () => {
  it("turns selected assistant text into an inline feedback follow-up", async () => {
    const user = userEvent.setup({ delay: null });
    const assistantReply = "The rollout dates are unclear in this summary.";
    const sentPrompts: string[] = [];
    const successToast = vi.spyOn(toast, "success");
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
      expect(screen.queryByText("Provide feedback")).not.toBeInTheDocument();
    });
    expect(successToast).toHaveBeenCalledWith("Copied");
    successToast.mockRestore();

    selectTextForInlineFeedback(assistantReplyElement);
    await waitFor(() => {
      expect(screen.getByText("Provide feedback")).toBeInTheDocument();
    });
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

  it("keeps inline feedback editable when the current model is unavailable", async () => {
    const user = userEvent.setup({ delay: null });
    const assistantReply = "The rollout dates are unclear in this summary.";
    let runCreateCount = 0;

    context.mocks.data.orgModelPolicies([]);
    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      selectedModel: "claude-sonnet-4-6",
      chatMessages: [
        {
          id: "msg-feedback-unavailable-model-user",
          role: "user",
          content: "Review this launch summary",
          runId: "run-feedback-unavailable-model",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-feedback-unavailable-model-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-feedback-unavailable-model",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
      onRunCreate: () => {
        runCreateCount++;
      },
    });

    detachedSetupPage({
      context,
      path: `/chats/${FEEDBACK_THREAD_ID}`,
    });

    selectTextForInlineFeedback(await screen.findByText(assistantReply));
    await user.click(await screen.findByText("Provide feedback"));

    const feedbackComment = await screen.findByPlaceholderText(
      "What should change about this?",
    );
    await fill(feedbackComment, "Mention the dates before the risk summary.");
    await user.click(screen.getByLabelText("Send feedback"));

    await expect(
      screen.findByText("The selected model is not available"),
    ).resolves.toBeInTheDocument();
    expect(runCreateCount).toBe(0);

    const preservedFeedbackComment = screen.getByPlaceholderText(
      "What should change about this?",
    );
    expect(preservedFeedbackComment).toBeEnabled();
    expect(preservedFeedbackComment).toHaveValue(
      "Mention the dates before the risk summary.",
    );
    await fill(
      preservedFeedbackComment,
      "Mention exact dates before the risk summary.",
    );
    expect(preservedFeedbackComment).toHaveValue(
      "Mention exact dates before the risk summary.",
    );
  });

  it("submits inline feedback once while model validation is loading", async () => {
    const user = userEvent.setup({ delay: null });
    const policyGate = context.mocks.deferred<void>();
    const assistantReply = "The rollout dates are unclear in this summary.";
    const policy: OrgModelPolicy = {
      id: "00000000-0000-4000-a000-000000000704",
      model: "claude-sonnet-4-6",
      modelLabel: "Claude Sonnet 4.6",
      isDefault: true,
      defaultProviderType: "vm0",
      credentialScope: "org",
      modelProviderId: null,
      routeStatus: "valid",
      routeStatusReason: null,
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    let runCreateCount = 0;

    context.mocks.api(
      zeroModelPoliciesMainContract.list,
      async ({ respond, withSignal }) => {
        await withSignal(policyGate.promise);
        return respond(200, {
          policies: [policy],
          workspaceDefaultModel: policy.model,
          workspaceDefaultPolicyId: policy.id,
        });
      },
    );
    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      selectedModel: policy.model,
      chatMessages: [
        {
          id: "msg-feedback-loading-user",
          role: "user",
          content: "Review this launch summary",
          runId: "run-feedback-loading",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-feedback-loading-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-feedback-loading",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
      onRunCreate: () => {
        runCreateCount++;
      },
    });

    detachedSetupPage({
      context,
      path: `/chats/${FEEDBACK_THREAD_ID}`,
    });

    selectTextForInlineFeedback(await screen.findByText(assistantReply));
    await user.click(await screen.findByText("Provide feedback"));

    const feedbackComment = await screen.findByPlaceholderText(
      "What should change about this?",
    );
    await fill(feedbackComment, "Mention the dates before the risk summary.");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.getByLabelText("Send feedback")).toBeDisabled();
    });
    await user.keyboard("{Enter}");

    policyGate.resolve();

    await waitFor(() => {
      expect(runCreateCount).toBe(1);
    });
    expect(
      screen.queryByPlaceholderText("What should change about this?"),
    ).not.toBeInTheDocument();
  });

  it("shows the inline feedback toolbar when double-click selection settles after mouseup", async () => {
    const assistantReply = "The rollout dates are unclear in this summary.";

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      chatMessages: [
        {
          id: "msg-feedback-late-selection-user",
          role: "user",
          content: "Review this launch summary",
          runId: "run-feedback-late-selection",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-feedback-late-selection-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-feedback-late-selection",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${FEEDBACK_THREAD_ID}`,
    });

    const assistantReplyElement = await screen.findByText(assistantReply);

    document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await waitForDeferredSelectionCapture();

    selectTextRangeForInlineFeedback(assistantReplyElement);
    document.dispatchEvent(new Event("selectionchange"));

    await waitFor(() => {
      expect(screen.getByText("Provide feedback")).toBeInTheDocument();
    });
  });

  it("keeps composer focus after the inline feedback toolbar closes", async () => {
    const user = userEvent.setup({ delay: null });
    const assistantReply = "The composer should keep focus after feedback.";

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      chatMessages: [
        {
          id: "msg-feedback-composer-focus-user",
          role: "user",
          content: "Review this launch summary",
          runId: "run-feedback-composer-focus",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-feedback-composer-focus-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-feedback-composer-focus",
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

    const composerEditor = await findComposerEditor();
    await user.click(composerEditor);
    expect(composerEditor).toHaveFocus();

    await waitFor(() => {
      expect(screen.queryByText("Provide feedback")).not.toBeInTheDocument();
    });
    await waitForDeferredSelectionCapture();

    expect(composerEditor).toHaveFocus();
  });

  it("focuses the inline feedback composer when started from the keyboard shortcut", async () => {
    const assistantReply = "The launch summary needs more source context.";

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      chatMessages: [
        {
          id: "msg-feedback-shortcut-user",
          role: "user",
          content: "Review this launch summary",
          runId: "run-feedback-shortcut",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-feedback-shortcut-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-feedback-shortcut",
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

    const event = dispatchDocumentShortcut("f");
    expect(event.defaultPrevented).toBeTruthy();

    const feedbackComment = await screen.findByPlaceholderText(
      "What should change about this?",
    );
    await waitFor(() => {
      expect(feedbackComment).toHaveFocus();
    });
  });

  it("shows the inline feedback toolbar for a multi-line selection", async () => {
    const firstReply = "The rollout dates are unclear in this summary.";
    const secondReply = "The risk owners are missing from the plan.";
    const assistantReply = `${firstReply}\n\n${secondReply}`;

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      chatMessages: [
        {
          id: "msg-feedback-multiline-user",
          role: "user",
          content: "Review this launch summary",
          runId: "run-feedback-multiline",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-feedback-multiline-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-feedback-multiline",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${FEEDBACK_THREAD_ID}`,
      featureSwitches: {},
    });

    const firstReplyElement = await screen.findByText(firstReply);
    const secondReplyElement = await screen.findByText(secondReply);
    selectTextAcrossElementsForInlineFeedback(
      firstReplyElement,
      secondReplyElement,
    );

    await waitFor(() => {
      expect(screen.getByText("Provide feedback")).toBeInTheDocument();
    });
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

    context.mocks.data.orgModelPolicies([
      {
        id: "00000000-0000-4000-a000-000000000703",
        model: "claude-sonnet-4-6",
        modelLabel: "Claude Sonnet 4.6",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
        modelProviderId: null,
        routeStatus: "valid",
        routeStatusReason: null,
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:00:00.000Z",
      },
    ]);
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
            templateId: template.templateId,
            previewUrl: template.embedUrl,
          },
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
