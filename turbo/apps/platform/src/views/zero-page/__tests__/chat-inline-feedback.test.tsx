import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  chatThreadByIdContract,
  type GenerationTemplateRequest,
  type UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { OrgModelPolicy } from "@vm0/api-contracts/contracts/model-providers";
import { zeroModelPoliciesMainContract } from "@vm0/api-contracts/contracts/zero-model-policies";
import { zeroWorkflowsCollectionContract } from "@vm0/api-contracts/contracts/zero-workflows";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@vm0/core";
import { toast } from "@vm0/ui/components/ui/sonner";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  click,
  detachedSetupPage,
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
  userMessage?: UserMessageDocument;
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
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  selectTextRangeForInlineFeedback(element);
  document.dispatchEvent(new Event("selectionchange"));
  element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
}

// The selection toolbar reads the completed selection in a deferred macrotask
// (delay(0)), and the composer applies its own deferred
// DOM/selection sync after paste. vi.waitFor drives its retries from
// macrotask timers, so requiring one failed check lets those earlier-queued
// product tasks settle without the test owning a timer of its own.
async function waitForDeferredSelectionCapture(): Promise<void> {
  let elapsedMacrotask = false;
  await vi.waitFor(() => {
    if (!elapsedMacrotask) {
      elapsedMacrotask = true;
      throw new Error("deferred selection tasks have not run yet");
    }
  });
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
  startElement.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
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
  document.dispatchEvent(new Event("selectionchange"));
  endElement.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
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

function feedbackNotes(): HTMLElement[] {
  return Array.from(document.querySelectorAll("[data-feedback-note]")).filter(
    (element): element is HTMLElement => {
      return element instanceof HTMLElement;
    },
  );
}

function pastePlainText(element: HTMLElement, value: string): void {
  fireEvent.paste(element, {
    clipboardData: {
      getData: (type: string) => {
        return type === "text/plain" ? value : "";
      },
      items: [],
    },
  });
}

async function findFeedbackNotes(count = 1): Promise<HTMLElement[]> {
  return await waitFor(() => {
    const notes = feedbackNotes();
    expect(notes).toHaveLength(count);
    return notes;
  });
}

async function findFeedbackNote(): Promise<HTMLElement> {
  const [note] = await findFeedbackNotes();
  if (!note) {
    throw new Error("Feedback note not found");
  }
  return note;
}

async function replaceFeedbackNote(
  note: HTMLElement,
  value: string,
): Promise<void> {
  const fastUser = userEvent.setup({ delay: null });
  await fastUser.click(note);
  const range = document.createRange();
  range.selectNodeContents(note);
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Selection API is not available");
  }
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  await fastUser.keyboard(value);
}

function dispatchDocumentShortcut(
  key: string,
  init?: Omit<KeyboardEventInit, "key">,
  type: "keydown" | "keyup" = "keydown",
): KeyboardEvent {
  const event = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    ...init,
    key,
  });
  document.dispatchEvent(event);
  return event;
}

describe("chat inline feedback", () => {
  it("inserts a template node inside a feedback note", async () => {
    const user = userEvent.setup({ delay: null });
    const assistantReply = "The illustration direction is too generic.";
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    const sentMessages: RunCreateCapture[] = [];
    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Template feedback",
      chatMessages: [
        {
          id: "msg-template-feedback-user",
          role: "user",
          content: "Review the direction",
          runId: "run-template-feedback",
          createdAt: "2026-07-27T10:00:00Z",
        },
        {
          id: "msg-template-feedback-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-template-feedback",
          createdAt: "2026-07-27T10:00:01Z",
        },
      ],
      onRunCreate(body) {
        sentMessages.push(body);
      },
    });

    detachedSetupPage({
      context,
      path: `/chats/${FEEDBACK_THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.StructuredPrompt]: true,
        [FeatureSwitchKey.StructuredPromptInlineTemplates]: true,
      },
    });

    const assistantReplyElement = await screen.findByText(assistantReply);
    selectTextForInlineFeedback(assistantReplyElement);
    await user.click(await screen.findByText("Provide feedback"));
    const feedbackNote = await findFeedbackNote();
    await user.click(feedbackNote);

    click(screen.getByLabelText("Template"));
    await user.click(
      await screen.findByLabelText(`Select template ${template.title}`),
    );
    await waitFor(() => {
      expect(
        feedbackNote.querySelector("[data-composer-inline-template]"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Send")).toBeEnabled();
    });
    await user.click(screen.getByLabelText("Send"));

    await waitFor(() => {
      expect(sentMessages).toHaveLength(1);
    });
    expect(sentMessages[0]?.generationTemplate).toBeUndefined();
    expect(sentMessages[0]?.userMessage?.parts).toHaveLength(1);
    expect(sentMessages[0]?.userMessage?.parts[0]).toMatchObject({
      type: "feedback",
      quote: assistantReply,
      note: [
        {
          type: "template",
          titleSnapshot: template.title,
          template: {
            type: "presentation",
            selection: { templateId: template.templateId },
          },
        },
      ],
    });
    expect(sentMessages[0]?.prompt).toContain(
      `Select ${template.title} presentation template`,
    );
    await waitFor(() => {
      expect(feedbackNotes()).toHaveLength(0);
    });
  });

  it("keeps ordinary text and inline feedback in one composer document", async () => {
    const user = userEvent.setup({ delay: null });
    const assistantReply = "The rollout dates are unclear in this summary.";
    const sentMessages: RunCreateCapture[] = [];
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
        sentMessages.push(body);
      },
    });

    detachedSetupPage({
      context,
      path: `/chats/${FEEDBACK_THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.StructuredPrompt]: true },
    });

    const composerEditor = await findComposerEditor();
    await user.click(composerEditor);
    pastePlainText(
      composerEditor,
      "Mention the dates before the risk summary.",
    );
    // The composer restores its own selection in a deferred task after paste;
    // selecting the assistant reply before that settles races the toolbar's
    // deferred selection capture against the composer's selection restore.
    await waitForDeferredSelectionCapture();
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

    const feedbackComment = await findFeedbackNote();
    await expect(findComposerEditor()).resolves.toBe(composerEditor);
    expect(feedbackComment).toHaveTextContent("");
    expect(composerEditor).toHaveTextContent(
      "Mention the dates before the risk summary.",
    );
    await user.click(feedbackComment);
    pastePlainText(feedbackComment, "Make the dates explicit.");

    await user.click(screen.getByLabelText("Send"));

    await waitFor(() => {
      expect(sentMessages).toHaveLength(1);
    });
    const sentPrompt = sentMessages[0]?.prompt;
    expect(sentPrompt).toContain("Feedback on this part of your reply:");
    expect(sentPrompt).toContain(
      "> The rollout dates are unclear in this summary.",
    );
    expect(sentPrompt).toContain("Mention the dates before the risk summary.");
    expect(sentPrompt).toContain("Make the dates explicit.");
    expect(sentMessages[0]?.userMessage).toStrictEqual({
      version: 1,
      parts: [
        {
          type: "text",
          text: "Mention the dates before the risk summary.",
        },
        {
          type: "feedback",
          quote: assistantReply,
          note: [{ type: "text", text: "Make the dates explicit." }],
        },
      ],
    });

    expect(feedbackNotes()).toHaveLength(0);
    await expect(findComposerEditor()).resolves.toBe(composerEditor);
  });

  it("uses the legacy send path for feedback when structured prompts are disabled", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "b0000000-0000-4000-a000-000000000707";
    const assistantReply = "The release summary needs a clearer owner.";
    const sentMessages: RunCreateCapture[] = [];

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Legacy feedback",
      chatMessages: [
        {
          id: "msg-legacy-feedback-user",
          role: "user",
          content: "Review this release summary",
          runId: "run-legacy-feedback",
          createdAt: "2026-07-26T10:00:00Z",
        },
        {
          id: "msg-legacy-feedback-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-legacy-feedback",
          createdAt: "2026-07-26T10:00:01Z",
        },
      ],
      onRunCreate: (body) => {
        sentMessages.push(body);
      },
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.StructuredPrompt]: false },
    });

    selectTextForInlineFeedback(await screen.findByText(assistantReply));
    await user.click(await screen.findByText("Provide feedback"));
    pastePlainText(await findFeedbackNote(), "Name the owner.");
    await user.click(screen.getByLabelText("Send"));

    await waitFor(() => {
      expect(sentMessages).toHaveLength(1);
    });
    expect(sentMessages[0]?.prompt).toContain(
      "Feedback on this part of your reply:",
    );
    expect(sentMessages[0]?.prompt).toContain(`> ${assistantReply}`);
    expect(sentMessages[0]?.prompt).toContain("Name the owner.");
    expect(sentMessages[0]).not.toHaveProperty("userMessage");
  });

  it("restores queued inline feedback with the structured prompt rollout", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "b0000000-0000-4000-a000-000000000706";
    const assistantReply = "The rollout plan needs a clearer owner.";
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    const queuedMessages: RunCreateCapture[] = [];
    const draftPatches: Record<string, unknown>[] = [];

    context.mocks.data.orgModelPolicies([
      {
        id: "00000000-0000-4000-a000-000000000706",
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
      threadId,
      threadTitle: "Queued feedback",
      selectedModel: "claude-sonnet-4-6",
      chatMessages: [
        {
          id: "msg-queued-feedback-user",
          role: "user",
          content: "Review this rollout plan",
          runId: "run-queued-feedback",
          createdAt: "2026-07-26T10:00:00Z",
        },
        {
          id: "msg-queued-feedback-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-queued-feedback",
          createdAt: "2026-07-26T10:00:01Z",
        },
      ],
      activeRunIds: ["run-queued-feedback"],
      onQueuedMessageAppend: (body) => {
        queuedMessages.push(body);
      },
    });
    context.mocks.api(chatThreadByIdContract.patch, ({ body, respond }) => {
      draftPatches.push(body as Record<string, unknown>);
      return respond(204);
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.StructuredPrompt]: true },
    });

    click(await screen.findByLabelText("Template"));
    click(
      await screen.findByLabelText(
        `Preview ${template.title} at current slide`,
      ),
    );
    click(await screen.findByLabelText("Select style Gold Luxe"));
    click(await screen.findByLabelText(`Select template ${template.title}`));
    await waitFor(() => {
      expect(
        screen.getByLabelText(`Remove template ${template.title}`),
      ).toBeInTheDocument();
    });

    selectTextForInlineFeedback(await screen.findByText(assistantReply));
    await user.click(await screen.findByText("Provide feedback"));
    pastePlainText(
      await findFeedbackNote(),
      "Name the owner and explain the complete result.",
    );
    await user.click(screen.getByLabelText("Send"));

    await waitFor(() => {
      expect(queuedMessages).toHaveLength(1);
    });
    expect(queuedMessages[0]?.userMessage).toStrictEqual({
      version: 1,
      parts: [
        {
          type: "template",
          titleSnapshot: template.title,
          template: {
            type: "presentation",
            selection: {
              colorSystemId: "color-system:gold-luxe",
              templateId: template.templateId,
              previewUrl: template.embedUrl,
            },
          },
        },
        {
          type: "feedback",
          quote: assistantReply,
          note: [
            {
              type: "text",
              text: "Name the owner and explain the complete result.",
            },
          ],
        },
      ],
    });

    await user.click(await screen.findByLabelText("Remove queued message"));

    const composer = await findComposerEditor();
    expect(
      screen.getByLabelText(`Remove template ${template.title}`),
    ).toBeInTheDocument();
    await waitFor(() => {
      const feedbackItem = composer.querySelector("[data-feedback-item]");
      expect(feedbackItem).toHaveTextContent(assistantReply);
      expect(feedbackItem).toHaveTextContent(
        "Name the owner and explain the complete result.",
      );
    });
    expect(composer).not.toHaveTextContent(
      "Feedback on this part of your reply:",
    );
    expect(composer).not.toHaveTextContent(`> ${assistantReply}`);
    await waitFor(() => {
      expect(draftPatches).toContainEqual({
        draftContent:
          "Feedback on this part of your reply:\n\n" +
          `> ${assistantReply}\n\n` +
          "Name the owner and explain the complete result.",
        draftUserMessage: queuedMessages[0]?.userMessage,
        draftAttachments: null,
      });
    });
  });

  it.each([
    {
      status: "draft" as const,
      sourceDescription: "an email draft",
      idLabel: "mail draft ID",
      sentId: null,
    },
    {
      status: "sent" as const,
      sourceDescription: "a sent email",
      idLabel: "mail ID",
      sentId: "gmail-sent-message-id",
    },
  ])(
    "includes $status email context when submitting mail feedback",
    async ({ status, sourceDescription, idLabel, sentId }) => {
      const user = userEvent.setup({ delay: null });
      const assistantReply = "Mail body after";
      const mailDraftId = "c0000000-0000-4000-a000-000000000012";
      const threadId =
        status === "draft"
          ? "b0000000-0000-4000-a000-000000000704"
          : "b0000000-0000-4000-a000-000000000705";
      const sentMessages: RunCreateCapture[] = [];

      mockChatLifecycle(context, {
        threadId,
        threadTitle: "Mail feedback",
        chatMessages: [
          {
            id: "msg-mail-feedback-assistant",
            role: "assistant",
            content: assistantReply,
            runId: "run-mail-feedback",
            createdAt: "2026-07-24T02:00:00Z",
          },
        ],
        onRunCreate: (body) => {
          sentMessages.push(body);
        },
      });

      detachedSetupPage({
        context,
        path: `/chats/${threadId}`,
        featureSwitches: { [FeatureSwitchKey.StructuredPrompt]: true },
      });

      const assistantReplyElement = await screen.findByText(assistantReply);
      const feedbackSource = assistantReplyElement.closest(
        ".zero-chat-bubble-assistant",
      );
      if (!(feedbackSource instanceof HTMLElement)) {
        throw new Error("Feedback source not found");
      }
      feedbackSource.dataset.feedbackSourceType = "mail";
      feedbackSource.dataset.feedbackSourceId = mailDraftId;
      feedbackSource.dataset.feedbackSourceStatus = status;
      if (sentId) {
        feedbackSource.dataset.feedbackSourceSentId = sentId;
      }

      selectTextForInlineFeedback(assistantReplyElement);
      await user.click(await screen.findByText("Provide feedback"));
      const feedbackNote = await findFeedbackNote();
      pastePlainText(feedbackNote, "Rewrite this paragraph.");
      await user.click(screen.getByLabelText("Send"));

      await waitFor(() => {
        expect(sentMessages).toHaveLength(1);
      });
      const sentIdSuffix = sentId ? `, sent ID: ${sentId}` : "";
      expect(sentMessages[0]?.prompt).toContain(
        `Feedback on this part of ${sourceDescription} (${idLabel}: ${mailDraftId}${sentIdSuffix}):`,
      );
      expect(sentMessages[0]?.prompt).toContain("> Mail body after");
      expect(sentMessages[0]?.prompt).toContain("Rewrite this paragraph.");
      expect(sentMessages[0]?.userMessage).toStrictEqual({
        version: 1,
        parts: [
          {
            type: "feedback",
            quote: assistantReply,
            note: [{ type: "text", text: "Rewrite this paragraph." }],
            source: {
              type: "mail",
              id: mailDraftId,
              status,
              ...(sentId ? { sentId } : {}),
            },
          },
        ],
      });
      await waitFor(() => {
        expect(feedbackNotes()).toHaveLength(0);
      });
    },
  );

  it("uses slash workflow suggestions inside an inline feedback note", async () => {
    const user = userEvent.setup({ delay: null });
    const assistantReply = "The launch plan needs a concrete owner.";
    context.mocks.api(zeroWorkflowsCollectionContract.list, ({ respond }) => {
      return respond(200, [
        {
          id: "a0000000-0000-4000-a000-000000000705",
          agentId: "c0000000-0000-4000-a000-000000000001",
          agentName: null,
          agentDisplayName: "Zero",
          name: "assign-owner",
          displayName: "Assign owner",
          description: "Assign a concrete owner",
          visibility: "public",
          ownerUserId: "user-1",
          createdAt: "2026-07-17T00:00:00.000Z",
          canManage: true,
          canPublish: false,
        },
      ]);
    });
    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      chatMessages: [
        {
          id: "msg-feedback-slash-user",
          role: "user",
          content: "Review this launch plan",
          runId: "run-feedback-slash",
          createdAt: "2026-07-17T10:00:00Z",
        },
        {
          id: "msg-feedback-slash-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-feedback-slash",
          createdAt: "2026-07-17T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${FEEDBACK_THREAD_ID}`,
    });

    selectTextForInlineFeedback(await screen.findByText(assistantReply));
    await user.click(await screen.findByText("Provide feedback"));
    const feedbackNote = await findFeedbackNote();
    await user.click(feedbackNote);
    await user.keyboard("/");

    await expect(
      screen.findByText("assign-owner"),
    ).resolves.toBeInTheDocument();
    await user.keyboard("assign{Enter}");

    await waitFor(() => {
      expect(feedbackNote).toHaveTextContent("/assign-owner");
    });
  });

  it("lets the server reconcile an unavailable model for inline feedback", async () => {
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

    await findFeedbackNote();
    await user.keyboard("Mention the dates before the risk summary.");
    await user.click(screen.getByLabelText("Send"));

    await waitFor(() => {
      expect(runCreateCount).toBe(1);
      expect(feedbackNotes()).toHaveLength(0);
    });
    expect(
      screen.queryByText("The selected model is not available"),
    ).not.toBeInTheDocument();
  });

  it("submits inline feedback once while model policy is loading", async () => {
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

    await findFeedbackNote();
    await user.keyboard("Mention the dates before the risk summary.");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(runCreateCount).toBe(1);
      expect(feedbackNotes()).toHaveLength(0);
    });
    await user.keyboard("{Enter}");
    expect(runCreateCount).toBe(1);

    policyGate.resolve();
  });

  it("does not submit inline feedback while IME composition is active", async () => {
    const user = userEvent.setup({ delay: null });
    const assistantReply = "The rollout dates are unclear in this summary.";
    let runCreateCount = 0;

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      chatMessages: [
        {
          id: "msg-feedback-composition-user",
          role: "user",
          content: "Review this launch summary",
          runId: "run-feedback-composition",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-feedback-composition-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-feedback-composition",
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

    const composerEditor = await findComposerEditor();
    selectTextForInlineFeedback(await screen.findByText(assistantReply));
    await user.click(await screen.findByText("Provide feedback"));

    const feedbackComment = await findFeedbackNote();
    await user.keyboard("补充具体日期");
    const compositionEnter = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      isComposing: true,
      key: "Enter",
    });
    composerEditor.dispatchEvent(compositionEnter);

    expect(runCreateCount).toBe(0);
    expect(feedbackNotes()).toHaveLength(1);
    expect(feedbackComment).toHaveTextContent("补充具体日期");
    await expect(findComposerEditor()).resolves.toBe(composerEditor);
  });

  it("submits the committed inline feedback after IME composition ends", async () => {
    const user = userEvent.setup({ delay: null });
    const assistantReply = "The rollout dates are unclear in this summary.";
    const sentPrompts: string[] = [];

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      chatMessages: [
        {
          id: "msg-feedback-ime-send-user",
          role: "user",
          content: "Review this launch summary",
          runId: "run-feedback-ime-send",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-feedback-ime-send-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-feedback-ime-send",
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

    selectTextForInlineFeedback(await screen.findByText(assistantReply));
    await user.click(await screen.findByText("Provide feedback"));

    const feedbackComment = await findFeedbackNote();
    await user.click(feedbackComment);
    await user.keyboard("补");
    await waitFor(() => {
      expect(feedbackComment).toHaveTextContent("补");
    });

    fireEvent.compositionStart(feedbackComment, { data: "补" });
    const paragraph = feedbackComment.querySelector("p");
    if (!paragraph) {
      throw new Error("Feedback paragraph not found");
    }
    paragraph.textContent = "补充具体日期";

    fireEvent.click(screen.getByLabelText("Send"));
    expect(sentPrompts).toHaveLength(0);

    fireEvent.compositionEnd(feedbackComment, { data: "补充具体日期" });
    fireEvent.input(feedbackComment, {
      data: "补充具体日期",
      inputType: "insertCompositionText",
      isComposing: false,
    });

    await waitFor(() => {
      expect(sentPrompts).toHaveLength(1);
    });
    expect(sentPrompts[0]).toContain("补充具体日期");
  });

  it("waits until mouseup before showing the inline feedback toolbar", async () => {
    const assistantReply = "The rollout dates are unclear in this summary.";

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      chatMessages: [
        {
          id: "msg-feedback-mouse-selection-user",
          role: "user",
          content: "Review this launch summary",
          runId: "run-feedback-mouse-selection",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-feedback-mouse-selection-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-feedback-mouse-selection",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${FEEDBACK_THREAD_ID}`,
    });

    const assistantReplyElement = await screen.findByText(assistantReply);
    assistantReplyElement.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true }),
    );
    selectTextRangeForInlineFeedback(assistantReplyElement);
    document.dispatchEvent(new Event("selectionchange"));
    await waitForDeferredSelectionCapture();

    expect(screen.queryByText("Provide feedback")).not.toBeInTheDocument();

    assistantReplyElement.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true }),
    );

    await waitFor(() => {
      expect(screen.getByText("Provide feedback")).toBeInTheDocument();
    });
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

    assistantReplyElement.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true }),
    );
    assistantReplyElement.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true }),
    );
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

  it("dismisses the inline feedback toolbar after the system copy shortcut", async () => {
    const assistantReply = "Copy this passage with the system shortcut.";

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      chatMessages: [
        {
          id: "msg-feedback-copy-shortcut-user",
          role: "user",
          content: "Review this passage",
          runId: "run-feedback-copy-shortcut",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-feedback-copy-shortcut-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-feedback-copy-shortcut",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${FEEDBACK_THREAD_ID}`,
    });

    selectTextForInlineFeedback(await screen.findByText(assistantReply));
    await waitFor(() => {
      expect(screen.getByText("Provide feedback")).toBeInTheDocument();
    });
    expect(window.getSelection()?.toString()).toBe(assistantReply);

    const event = dispatchDocumentShortcut("c", { ctrlKey: true });
    expect(event.defaultPrevented).toBeFalsy();

    await waitFor(() => {
      expect(screen.queryByText("Provide feedback")).not.toBeInTheDocument();
    });
    expect(window.getSelection()?.toString()).toBe(assistantReply);

    dispatchDocumentShortcut("c", { ctrlKey: true }, "keyup");
    await waitForDeferredSelectionCapture();

    expect(screen.queryByText("Provide feedback")).not.toBeInTheDocument();
    expect(window.getSelection()?.toString()).toBe(assistantReply);
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

    await findFeedbackNote();
    await waitFor(() => {
      expect(
        document.querySelector('.zero-composer [contenteditable="true"]'),
      ).toHaveFocus();
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

    // A real browser emits selectionchange after the selection collapses.
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));

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

    click(await screen.findByLabelText("Template"));
    click(
      await screen.findByLabelText(
        `Preview ${template.title} at current slide`,
      ),
    );
    click(await screen.findByLabelText("Select style Gold Luxe"));
    click(await screen.findByLabelText(`Select template ${template.title}`));
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
    click(buttonByText("Provide feedback"));

    pastePlainText(
      await findFeedbackNote(),
      "Use the attached brief as supporting context.",
    );
    expect(
      screen.getByLabelText(`Remove template ${templateChipLabel}`),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Remove feedback-brief.txt"),
    ).toBeInTheDocument();

    click(screen.getByLabelText("Send"));

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

    const firstComment = await findFeedbackNote();
    await user.keyboard("Assign each risk to an owner.");
    await waitFor(() => {
      expect(firstComment).toHaveTextContent("Assign each risk to an owner.");
    });

    selectTextForInlineFeedback(assistantReplyElement);
    await waitFor(() => {
      expect(screen.getByText("Provide feedback")).toBeInTheDocument();
    });
    await user.click(buttonByText("Provide feedback"));

    const comments = await findFeedbackNotes(2);
    expect(comments).toHaveLength(2);
    // The first note persists on top; the newest fragment sits below it with
    // an empty note, taking the composer position nearest Send.
    expect(comments[0]).toHaveTextContent("Assign each risk to an owner.");
    expect(comments[1]).toHaveTextContent("");

    // Removing the empty draft row leaves the noted fragment intact.
    await user.click(screen.getAllByLabelText("Remove feedback")[1]);

    await waitFor(() => {
      expect(feedbackNotes()).toHaveLength(1);
    });
    expect(feedbackNotes()[0]).toHaveTextContent(
      "Assign each risk to an owner.",
    );
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

    const firstComment = await findFeedbackNote();
    await user.keyboard("Add owners.");
    await waitFor(() => {
      expect(firstComment).toHaveTextContent("Add owners.");
    });

    selectTextForInlineFeedback(assistantReplyElement);
    await waitFor(() => {
      expect(screen.getByText("Provide feedback")).toBeInTheDocument();
    });
    await user.click(buttonByText("Provide feedback"));

    const comments = await findFeedbackNotes(2);
    await user.keyboard("Add dates.");
    await waitFor(() => {
      expect(comments[1]).toHaveTextContent("Add dates.");
    });

    // Edit the first fragment's note in place — the oldest sits on top.
    const editingComment = feedbackNotes()[0]!;
    expect(editingComment).toHaveTextContent("Add owners.");
    await replaceFeedbackNote(editingComment, "Name owners.");
    await expect(findComposerEditor()).resolves.toHaveFocus();
    expect(editingComment).toHaveTextContent("Name owners.");
    expect(feedbackNotes()[1]).toHaveTextContent("Add dates.");

    await user.click(screen.getByLabelText("Send"));

    await waitFor(() => {
      expect(sentPrompts).toHaveLength(1);
    });

    expect(sentPrompts[0]).toContain("Feedback on 2 parts of your reply:");
    expect(sentPrompts[0]).toContain(
      "> The launch summary needs clearer risk ownership.",
    );
    expect(sentPrompts[0]).toContain("Name owners.");
    expect(sentPrompts[0]).toContain("Add dates.");
  });
});
