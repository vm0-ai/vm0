import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { chatTranslationContract } from "@okouai/api-contracts/contracts/chat-translation";
import type { OrgModelPolicy } from "@okouai/api-contracts/contracts/model-providers";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import { workflowsCollectionContract } from "@okouai/api-contracts/contracts/workflows";
import {
  SUPPORTED_USER_LOCALES,
  type UserPreferencesResponse,
  userPreferencesContract,
} from "@okouai/api-contracts/contracts/user-preferences";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { toast } from "@okouai/ui/components/ui/sonner";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
  setupPageAndWaitForContent,
} from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

const FEEDBACK_THREAD_ID = "b0000000-0000-4000-a000-000000000703";
const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
interface ModelSelectionRequest {
  readonly modelProviderId: string;
  readonly selectedModel: string;
}

interface RunCreateCapture {
  prompt?: string;
  threadId?: string;
  clientThreadId?: string;
  userMessage?: UserMessageDocument;
  hasTextContent?: boolean;
  modelSelection?: ModelSelectionRequest | null;
  computerUseHostId?: string | null;
  clientEventId?: string;
  sourceRunId?: string;
}

function findInlineTemplate(): HTMLElement {
  const inlineTemplate = document.querySelector(
    "[data-composer-inline-template]",
  );
  if (!(inlineTemplate instanceof HTMLElement)) {
    throw new Error("Inline template not found in the composer");
  }
  return inlineTemplate;
}

function selectTextRangeForInlineFeedback(
  element: HTMLElement,
  offsets?: { readonly start: number; readonly end: number },
): void {
  const range = document.createRange();
  if (offsets) {
    const textNode = element.firstChild;
    if (!(textNode instanceof Text)) {
      throw new Error("Selection source must start with a text node");
    }
    range.setStart(textNode, offsets.start);
    range.setEnd(textNode, offsets.end);
  } else {
    range.selectNodeContents(element);
  }
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

function selectTextForInlineFeedback(
  element: HTMLElement,
  offsets?: { readonly start: number; readonly end: number },
): void {
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  selectTextRangeForInlineFeedback(element, offsets);
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

function assistantActionArea(element: HTMLElement): HTMLElement {
  const assistantGroup = element.closest('[data-role="assistant"]');
  if (!(assistantGroup instanceof HTMLElement)) {
    throw new Error("Assistant group not found");
  }
  const primaryActions = assistantGroup.querySelector(
    '[data-testid="chat-event-actions"]',
  );
  const actionArea = primaryActions?.parentElement?.parentElement;
  if (
    !(actionArea instanceof HTMLElement) ||
    actionArea.parentElement !== assistantGroup
  ) {
    throw new Error("Assistant action area not found");
  }
  return actionArea;
}

function selectTextToAssistantActionBoundaryForInlineFeedback(
  startElement: HTMLElement,
  endAssistantElement = startElement,
): Range {
  const startNode = startElement.firstChild;
  if (!(startNode instanceof Text)) {
    throw new Error("Selection source must start with a text node");
  }
  const actionArea = assistantActionArea(endAssistantElement);
  startElement.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  const range = document.createRange();
  range.setStart(startNode, 0);
  range.setEnd(actionArea, 0);
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
  document.dispatchEvent(new Event("selectionchange"));
  actionArea.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  return range;
}

function buttonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    const label = candidate.textContent?.replace(/\s+/g, " ").trim();
    return (
      label === text ||
      label === `${text}C` ||
      label === `${text} C` ||
      label === `${text}F` ||
      label === `${text} F` ||
      label === `${text}Q` ||
      label === `${text} Q` ||
      label === `${text}T` ||
      label === `${text} T`
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

async function findForwardFeedbackNote(
  dialog: HTMLElement,
): Promise<HTMLElement> {
  return await waitFor((): HTMLElement => {
    const note = dialog.querySelector(
      "[data-chat-composer] [data-feedback-item][data-feedback-note]",
    );
    if (!(note instanceof HTMLElement)) {
      throw new Error("Forward feedback note not found");
    }
    return note;
  });
}

function feedbackNotes(): HTMLElement[] {
  return Array.from(document.querySelectorAll("[data-feedback-note]")).filter(
    (element): element is HTMLElement => {
      return element instanceof HTMLElement;
    },
  );
}

async function findFeedbackItems(count: number): Promise<HTMLElement[]> {
  return await waitFor(() => {
    const items = Array.from(
      document.querySelectorAll("[data-feedback-item]"),
    ).filter((element): element is HTMLElement => {
      return element instanceof HTMLElement;
    });
    expect(items).toHaveLength(count);
    return items;
  });
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
  it("leaves the source passage out of the browser highlight registry", async () => {
    const user = userEvent.setup({ delay: null });
    const assistantReply =
      "This passage should stop repainting after feedback starts.";
    const browserHighlights = new Map<string, object>();
    vi.stubGlobal("CSS", { highlights: browserHighlights });
    vi.stubGlobal("Highlight", class BrowserHighlight {});

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback repaint regression",
      chatEvents: [
        {
          id: "msg-feedback-highlight-user",
          role: "user",
          content: "Review the passage",
          runId: "run-feedback-highlight",
          createdAt: "2026-08-12T10:00:00Z",
        },
        {
          id: "msg-feedback-highlight-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-feedback-highlight",
          createdAt: "2026-08-12T10:00:01Z",
        },
      ],
    });

    await setupPageAndWaitForContent({
      context,
      path: `/chats/${FEEDBACK_THREAD_ID}`,
    });

    const assistantReplyElement = await screen.findByText(assistantReply);
    selectTextForInlineFeedback(assistantReplyElement);
    await user.click(await screen.findByText("Quote"));
    await findFeedbackNote();
    await waitForDeferredSelectionCapture();

    expect(browserHighlights.has("zero-feedback")).toBeFalsy();
    expect(browserHighlights.size).toBe(0);
  });

  it("forwards selected assistant content to a new agent chat without navigating", async () => {
    const user = userEvent.setup({ delay: null });
    const sourceRunId = "d0000000-0000-4000-a000-000000000703";
    const selectedContent = "Keep the migration window below fifteen minutes.";
    const additionalContext = "Turn this into an operator checklist.";
    const sentRequests: RunCreateCapture[] = [];
    const successToast = vi.spyOn(toast, "success");

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Forward source",
      chatEvents: [
        {
          id: "msg-forward-agent-user",
          role: "user",
          content: "Review the migration plan",
          runId: sourceRunId,
          createdAt: "2026-08-12T09:00:00Z",
        },
        {
          id: "msg-forward-agent-assistant",
          role: "assistant",
          content: selectedContent,
          runId: sourceRunId,
          createdAt: "2026-08-12T09:00:01Z",
        },
      ],
      onSendRequest(body) {
        sentRequests.push(body);
      },
    });

    detachedSetupPage({
      context,
      path: `/chats/${FEEDBACK_THREAD_ID}`,
    });

    selectTextForInlineFeedback(await screen.findByText(selectedContent));
    await user.click(await screen.findByText("Forward"));

    const dialog = await screen.findByRole("dialog", { name: "Forward to" });
    expect(within(dialog).getByText(selectedContent)).toBeInTheDocument();
    expect(within(dialog).getByText("Content")).toBeInTheDocument();
    expect(dialog).toHaveAccessibleDescription(
      "Send selected content to an agent or chat to continue working on it.",
    );
    const search = within(dialog).getByPlaceholderText(
      "Search agents and chats...",
    );
    await fill(search, "Zero");
    await user.keyboard("{ArrowDown}{Enter}");

    const feedbackNote = await findForwardFeedbackNote(dialog);
    expect(dialog).toHaveAccessibleName("Zero");
    expect(within(dialog).queryByText("Content")).toBeNull();
    expect(within(dialog).getAllByText(selectedContent)).toHaveLength(1);
    pastePlainText(feedbackNote, additionalContext);
    await user.click(within(dialog).getByLabelText("Send"));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Zero" }),
      ).not.toBeInTheDocument();
      expect(sentRequests).toHaveLength(1);
    });
    expect(pathname()).toBe(`/chats/${FEEDBACK_THREAD_ID}`);
    expect(sentRequests[0]).toMatchObject({
      threadId: expect.any(String),
      sourceRunId,
      prompt: `Feedback on this part of your reply:\n\n> ${selectedContent}\n\n${additionalContext}`,
    });
    expect(sentRequests[0]?.threadId).not.toBe(FEEDBACK_THREAD_ID);
    expect(sentRequests[0]?.userMessage?.parts).toStrictEqual(
      expect.arrayContaining([
        {
          type: "feedback",
          quote: selectedContent,
          eventId: "msg-forward-agent-assistant",
          range: { start: 0, end: selectedContent.length },
          note: [{ type: "text", text: additionalContext }],
        },
      ]),
    );
    expect(successToast).toHaveBeenCalledWith("Forwarded successfully");
    successToast.mockRestore();
  });

  it("forwards selected assistant content to an existing chat with keyboard selection", async () => {
    const user = userEvent.setup({ delay: null });
    const sourceRunId = "d0000000-0000-4000-a000-000000000704";
    const targetThreadId = "b0000000-0000-4000-a000-000000000704";
    const selectedContent = "The launch owner is still unresolved.";
    const additionalContext = "Assign a launch owner.";
    const sentRequests: RunCreateCapture[] = [];
    let threadCreateCount = 0;
    const successToast = vi.spyOn(toast, "success");

    const lifecycle = mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Forward source",
      chatEvents: [
        {
          id: "msg-forward-thread-user",
          role: "user",
          content: "Review launch readiness",
          runId: sourceRunId,
          createdAt: "2026-08-12T10:00:00Z",
        },
        {
          id: "msg-forward-thread-assistant",
          role: "assistant",
          content: selectedContent,
          runId: sourceRunId,
          createdAt: "2026-08-12T10:00:01Z",
        },
      ],
      onSendRequest(body) {
        sentRequests.push(body);
      },
      onThreadCreate() {
        threadCreateCount += 1;
      },
    });
    lifecycle.setThreadList([
      {
        id: FEEDBACK_THREAD_ID,
        title: "Forward source",
        agent: { id: DEFAULT_AGENT_ID, avatarUrl: null },
        createdAt: "2026-08-12T09:00:00Z",
        updatedAt: "2026-08-12T10:00:00Z",
      },
      {
        id: targetThreadId,
        title: "Launch ownership",
        agent: { id: DEFAULT_AGENT_ID, avatarUrl: null },
        createdAt: "2026-08-12T08:00:00Z",
        updatedAt: "2026-08-12T09:00:00Z",
      },
    ]);

    detachedSetupPage({
      context,
      path: `/chats/${FEEDBACK_THREAD_ID}`,
    });

    selectTextForInlineFeedback(await screen.findByText(selectedContent));
    await user.click(await screen.findByText("Forward"));

    const dialog = await screen.findByRole("dialog", { name: "Forward to" });
    const search = within(dialog).getByPlaceholderText(
      "Search agents and chats...",
    );
    await fill(search, "Launch ownership");
    await user.keyboard("{ArrowDown}{Enter}");

    const feedbackNote = await findForwardFeedbackNote(dialog);
    expect(dialog).toHaveAccessibleName("Launch ownership");
    expect(within(dialog).queryByText("Content")).toBeNull();
    expect(within(dialog).getAllByText(selectedContent)).toHaveLength(1);
    pastePlainText(feedbackNote, additionalContext);
    await user.click(within(dialog).getByLabelText("Send"));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Launch ownership" }),
      ).not.toBeInTheDocument();
      expect(sentRequests).toHaveLength(1);
    });
    expect(pathname()).toBe(`/chats/${FEEDBACK_THREAD_ID}`);
    expect(threadCreateCount).toBe(0);
    expect(sentRequests[0]).toMatchObject({
      threadId: targetThreadId,
      sourceRunId,
      prompt: `Feedback on this part of your reply:\n\n> ${selectedContent}\n\n${additionalContext}`,
    });
    expect(sentRequests[0]?.userMessage?.parts).toStrictEqual(
      expect.arrayContaining([
        {
          type: "feedback",
          quote: selectedContent,
          eventId: "msg-forward-thread-assistant",
          range: { start: 0, end: selectedContent.length },
          note: [{ type: "text", text: additionalContext }],
        },
      ]),
    );
    expect(successToast).toHaveBeenCalledWith("Forwarded successfully");
    successToast.mockRestore();
  });

  it("hides target pending items from the forward composer", async () => {
    const user = userEvent.setup({ delay: null });
    const sourceRunId = "d0000000-0000-4000-a000-000000000706";
    const targetThreadId = "b0000000-0000-4000-a000-000000000706";
    const selectedContent = "Summarize the rollout blockers.";
    const queuedContent = "Review the queued rollout update";
    const automationContent = "Process the pending rollout automation";
    const goalContent = "Keep the rollout on schedule";

    const lifecycle = mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Forward pending items source",
      chatEvents: [
        {
          id: "msg-forward-pending-user",
          role: "user",
          content: "Review the rollout",
          runId: sourceRunId,
          createdAt: "2026-08-12T12:00:00Z",
        },
        {
          id: "msg-forward-pending-assistant",
          role: "assistant",
          content: selectedContent,
          runId: sourceRunId,
          createdAt: "2026-08-12T12:00:01Z",
        },
        {
          id: "msg-forward-pending-queued",
          role: "user",
          content: queuedContent,
          runId: undefined,
          createdAt: "2026-08-12T12:00:02Z",
        },
        {
          id: "msg-forward-pending-automation",
          eventType: "input.automation",
          content: null,
          userMessage: {
            version: 1,
            parts: [
              {
                type: "automation",
                workflowName: "rollout-review",
                automationBrief: automationContent,
              },
            ],
          },
          runId: undefined,
          createdAt: "2026-08-12T12:00:03Z",
        },
        {
          id: "msg-forward-pending-goal",
          eventType: "goal.open",
          role: "assistant",
          content: goalContent,
          runId: undefined,
          createdAt: "2026-08-12T12:00:04Z",
        },
      ],
      activeRunIds: [sourceRunId],
    });
    lifecycle.setThreadList([
      {
        id: FEEDBACK_THREAD_ID,
        title: "Forward pending items source",
        agent: { id: DEFAULT_AGENT_ID, avatarUrl: null },
        createdAt: "2026-08-12T11:00:00Z",
        updatedAt: "2026-08-12T12:00:00Z",
      },
      {
        id: targetThreadId,
        title: "Rollout review",
        agent: { id: DEFAULT_AGENT_ID, avatarUrl: null },
        createdAt: "2026-08-12T10:00:00Z",
        updatedAt: "2026-08-12T11:00:00Z",
      },
    ]);

    detachedSetupPage({
      context,
      path: `/chats/${FEEDBACK_THREAD_ID}`,
    });

    const assistantReply = await screen.findByText(selectedContent);
    await screen.findByText(queuedContent);
    await screen.findByText(automationContent);
    expect(screen.getByLabelText("Active goal")).toHaveTextContent(goalContent);
    selectTextForInlineFeedback(assistantReply);
    await user.click(await screen.findByText("Forward"));

    const dialog = await screen.findByRole("dialog", { name: "Forward to" });
    await fill(
      within(dialog).getByPlaceholderText("Search agents and chats..."),
      "Rollout review",
    );
    await user.keyboard("{ArrowDown}{Enter}");
    await findForwardFeedbackNote(dialog);
    await waitForDeferredSelectionCapture();

    expect(dialog).toHaveAccessibleName("Rollout review");
    expect(within(dialog).queryByText(queuedContent)).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText(automationContent),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByText(goalContent)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Queued message")).toBeNull();
    expect(
      within(dialog).queryByLabelText("Pending automation event"),
    ).toBeNull();
    expect(within(dialog).queryByLabelText("Active goal")).toBeNull();
  });

  it("opens the forward dialog from the keyboard shortcut", async () => {
    const sourceRunId = "d0000000-0000-4000-a000-000000000705";
    const selectedContent = "Quote the approved launch checklist.";

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Forward shortcut source",
      chatEvents: [
        {
          id: "msg-forward-shortcut-user",
          role: "user",
          content: "Review launch readiness",
          runId: sourceRunId,
          createdAt: "2026-08-12T11:00:00Z",
        },
        {
          id: "msg-forward-shortcut-assistant",
          role: "assistant",
          content: selectedContent,
          runId: sourceRunId,
          createdAt: "2026-08-12T11:00:01Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${FEEDBACK_THREAD_ID}`,
    });

    selectTextForInlineFeedback(await screen.findByText(selectedContent));
    await screen.findByText("Forward");
    const copyButton = buttonByText("Copy");
    const quoteButton = buttonByText("Quote");
    const forwardButton = buttonByText("Forward");
    expect(forwardButton).toHaveAttribute("aria-keyshortcuts", "f");
    expect(quoteButton).toHaveAttribute("aria-keyshortcuts", "q");
    const toolbar = copyButton.parentElement;
    if (!(toolbar instanceof HTMLElement)) {
      throw new Error("Selection toolbar is not available");
    }
    expect(queryAllByRoleFast("button", toolbar)).toStrictEqual([
      copyButton,
      quoteButton,
      forwardButton,
    ]);

    const event = dispatchDocumentShortcut("f");
    expect(event.defaultPrevented).toBeTruthy();

    const dialog = await screen.findByRole("dialog", { name: "Forward to" });
    expect(within(dialog).getByText(selectedContent)).toBeInTheDocument();
  });

  it("translates selected text with a remembered language without changing existing shortcuts", async () => {
    const user = userEvent.setup({ delay: null });
    const selectedContent = "Keep the launch checklist short and actionable.";
    const translationRequests: unknown[] = [];
    const preferenceUpdates: unknown[] = [];
    const translationResponse = context.mocks.deferred<void>();
    let preferences: UserPreferencesResponse = {
      timezone: "UTC",
      locale: "en-US",
      translationLanguage: "fr",
      supportedLocales: [...SUPPORTED_USER_LOCALES],
      pinnedAgentIds: [],
      sendMode: "enter",
      theme: "system",
      colorTheme: "blue-horizon",
      captureNetworkBodiesRemaining: 0,
    };
    context.mocks.api(userPreferencesContract.get, ({ respond }) => {
      return respond(200, preferences);
    });
    context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
      preferenceUpdates.push(body);
      preferences = { ...preferences, ...body };
      return respond(200, preferences);
    });
    context.mocks.api(
      chatTranslationContract.translate,
      async ({ body, respond }) => {
        translationRequests.push(body);
        await translationResponse.promise;
        return respond(200, {
          text:
            body.targetLanguage === "fr"
              ? "Gardez la liste de lancement courte et exploitable."
              : "保持发布清单简短且可执行。",
          metadata: { creditsCharged: 1 },
        });
      },
    );
    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Translation source",
      chatEvents: [
        {
          id: "msg-translation-user",
          role: "user",
          content: "Review launch readiness",
          runId: "run-translation",
          createdAt: "2026-08-31T10:00:00Z",
        },
        {
          id: "msg-translation-assistant",
          role: "assistant",
          content: selectedContent,
          runId: "run-translation",
          createdAt: "2026-08-31T10:00:01Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${FEEDBACK_THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.ChatTranslation]: true },
    });

    selectTextForInlineFeedback(await screen.findByText(selectedContent));
    await screen.findByText("Translate");
    expect(buttonByText("Copy")).toHaveAttribute("aria-keyshortcuts", "c");
    expect(buttonByText("Quote")).toHaveAttribute("aria-keyshortcuts", "q");
    expect(buttonByText("Forward")).toHaveAttribute("aria-keyshortcuts", "f");
    expect(buttonByText("Translate")).toHaveAttribute("aria-keyshortcuts", "t");
    expect(
      buttonByText("Translate").querySelector(".lucide-languages"),
    ).not.toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "Translation language" }),
    ).not.toBeInTheDocument();

    const translateShortcut = dispatchDocumentShortcut("t");
    expect(translateShortcut.defaultPrevented).toBeTruthy();

    await waitFor(() => {
      expect(translationRequests).toStrictEqual([
        { text: selectedContent, targetLanguage: "fr" },
      ]);
      expect(buttonByText("Translate")).toBeDisabled();
    });
    translationResponse.resolve();
    await expect(
      screen.findByText("Gardez la liste de lancement courte et exploitable."),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Translation language" }),
    ).toHaveTextContent("Français");

    await user.click(
      screen.getByRole("combobox", { name: "Translation language" }),
    );
    const languageListbox = await screen.findByRole("listbox");
    const languageMenu = languageListbox.closest(
      "[data-chat-selection-interaction]",
    );
    if (!(languageMenu instanceof HTMLElement)) {
      throw new Error("Translation language menu is not available");
    }
    fireEvent.scroll(languageMenu);
    expect(
      screen.getByText("Gardez la liste de lancement courte et exploitable."),
    ).toBeInTheDocument();
    expect(languageListbox).toBeInTheDocument();

    await user.click(await screen.findByRole("option", { name: "简体中文" }));
    await waitFor(() => {
      expect(preferenceUpdates).toContainEqual({
        translationLanguage: "zh-CN",
      });
    });

    await waitFor(() => {
      expect(translationRequests).toStrictEqual([
        { text: selectedContent, targetLanguage: "fr" },
        { text: selectedContent, targetLanguage: "zh-CN" },
      ]);
    });
    await expect(
      screen.findByText("保持发布清单简短且可执行。"),
    ).resolves.toBeInTheDocument();
    selectTextRangeForInlineFeedback(screen.getByText(selectedContent));
    document.dispatchEvent(new Event("selectionchange"));
    await waitForDeferredSelectionCapture();
    expect(screen.getByText("保持发布清单简短且可执行。")).toBeInTheDocument();
    expect(
      queryAllByRoleFast("button").some((button) => {
        return button.getAttribute("aria-label") === "Copy translation";
      }),
    ).toBeTruthy();
  });

  it("inserts a template node inside a feedback note", async () => {
    const user = userEvent.setup({ delay: null });
    const assistantReply = "The illustration direction is too generic.";
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    const sentMessages: RunCreateCapture[] = [];
    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Template feedback",
      chatEvents: [
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
    });

    const assistantReplyElement = await screen.findByText(assistantReply);
    selectTextForInlineFeedback(assistantReplyElement);
    await user.click(await screen.findByText("Quote"));
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
      chatEvents: [
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
      expect(screen.getByText("Quote")).toBeInTheDocument();
    });

    await user.click(buttonByText("Copy"));

    await waitFor(() => {
      expect(screen.queryByText("Quote")).not.toBeInTheDocument();
    });
    expect(successToast).toHaveBeenCalledWith("Copied");

    selectTextForInlineFeedback(assistantReplyElement);
    await waitFor(() => {
      expect(screen.getByText("Quote")).toBeInTheDocument();
    });
    await user.click(buttonByText("Quote"));

    const feedbackComment = await findFeedbackNote();
    await expect(findComposerEditor()).resolves.toBe(composerEditor);
    expect(feedbackComment.querySelector(":scope > p")).toHaveTextContent(/^$/);
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
          eventId: "msg-feedback-assistant",
          range: { start: 0, end: assistantReply.length },
          note: [{ type: "text", text: "Make the dates explicit." }],
        },
      ],
    });

    expect(feedbackNotes()).toHaveLength(0);
    await expect(findComposerEditor()).resolves.toBe(composerEditor);
  });

  it("keeps legacy feedback runtime behavior while dual-writing user messages", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "b0000000-0000-4000-a000-000000000707";
    const assistantReply = "The release summary needs a clearer owner.";
    const selectedQuote = "release summary";
    const selectedRange = {
      start: assistantReply.indexOf(selectedQuote),
      end: assistantReply.indexOf(selectedQuote) + selectedQuote.length,
    };
    const sentMessages: RunCreateCapture[] = [];

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Legacy feedback",
      chatEvents: [
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
    });

    selectTextForInlineFeedback(
      await screen.findByText(assistantReply),
      selectedRange,
    );
    await user.click(await screen.findByText("Quote"));
    pastePlainText(await findFeedbackNote(), "Name the owner.");
    await user.click(screen.getByLabelText("Send"));

    await waitFor(() => {
      expect(sentMessages).toHaveLength(1);
    });
    expect(sentMessages[0]?.prompt).toContain(
      "Feedback on this part of your reply:",
    );
    expect(sentMessages[0]?.prompt).toContain(`> ${selectedQuote}`);
    expect(sentMessages[0]?.prompt).toContain("Name the owner.");
    expect(sentMessages[0]?.userMessage).toStrictEqual({
      version: 1,
      parts: [
        {
          type: "feedback",
          quote: selectedQuote,
          eventId: "msg-legacy-feedback-assistant",
          range: selectedRange,
          note: [{ type: "text", text: "Name the owner." }],
        },
      ],
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
        chatEvents: [
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
      await user.click(await screen.findByText("Quote"));
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
            eventId: "msg-mail-feedback-assistant",
            range: { start: 0, end: assistantReply.length },
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
    context.mocks.api(workflowsCollectionContract.list, ({ respond }) => {
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
          official: null,
        },
      ]);
    });
    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      chatEvents: [
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
    await user.click(await screen.findByText("Quote"));
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
      chatEvents: [
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
    await user.click(await screen.findByText("Quote"));

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
      defaultProviderType: "built-in",
      credentialScope: "org",
      modelProviderId: null,
      routeStatus: "valid",
      routeStatusReason: null,
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    let runCreateCount = 0;

    context.mocks.api(
      modelPoliciesMainContract.list,
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
      chatEvents: [
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
    await user.click(await screen.findByText("Quote"));

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
      chatEvents: [
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
    await user.click(await screen.findByText("Quote"));

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
      chatEvents: [
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
    await user.click(await screen.findByText("Quote"));

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

  async function setupFeedbackNoteThread(caseName: string): Promise<{
    readonly assistantReply: string;
    readonly sentMessages: RunCreateCapture[];
  }> {
    const assistantReply = "The rollout dates are unclear in this summary.";
    const sentMessages: RunCreateCapture[] = [];
    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      chatEvents: [
        {
          id: `msg-feedback-note-${caseName}-user`,
          role: "user",
          content: "Review this launch summary",
          runId: `run-feedback-note-${caseName}`,
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: `msg-feedback-note-${caseName}-assistant`,
          role: "assistant",
          content: assistantReply,
          runId: `run-feedback-note-${caseName}`,
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
    });
    await findComposerEditor();
    return { assistantReply, sentMessages };
  }

  it("renders the quote block and submits typed text", async () => {
    const user = userEvent.setup({ delay: null });
    const { assistantReply, sentMessages } =
      await setupFeedbackNoteThread("submit");

    selectTextForInlineFeedback(await screen.findByText(assistantReply));
    await user.click(await screen.findByText("Quote"));

    const note = await findFeedbackNote();
    // The block is its own content element: no nested note wrapper.
    expect(note.dataset.feedbackItem).toBe("");
    expect(note.querySelector("[data-feedback-note]")).toBeNull();
    // The chrome widget carries the quote chip; the empty-note placeholder is
    // an attribute the paragraph renders through ::before, so typing never
    // inserts or removes DOM around the caret.
    expect(note).toHaveTextContent(assistantReply);
    expect(
      note.querySelector<HTMLElement>(":scope > p")?.dataset.placeholder,
    ).toBe("What should change about this?");

    await user.click(note);
    pastePlainText(note, "Make the dates explicit");
    await waitFor(() => {
      expect(note).toHaveTextContent("Make the dates explicit");
    });
    await waitFor(() => {
      expect(
        note.querySelector<HTMLElement>(":scope > p")?.dataset.placeholder,
      ).toBeUndefined();
    });

    await user.click(screen.getByLabelText("Send"));
    await waitFor(() => {
      expect(sentMessages).toHaveLength(1);
    });
    expect(sentMessages[0]?.prompt).toContain("Make the dates explicit");
    expect(sentMessages[0]?.prompt).toContain(assistantReply);
  });

  it("keeps the chrome widget's identity while the note empties and refills", async () => {
    // Recreating the widget swaps a contenteditable=false element right next
    // to the caret; at an IME composition boundary WebKit loses the caret.
    // The widget must survive both transitions with the same DOM element.
    const user = userEvent.setup({ delay: null });
    const { assistantReply } = await setupFeedbackNoteThread("stable");

    selectTextForInlineFeedback(await screen.findByText(assistantReply));
    await user.click(await screen.findByText("Quote"));

    const note = await findFeedbackNote();
    const chrome = note.firstElementChild;
    if (!(chrome instanceof HTMLElement) || chrome.tagName === "P") {
      throw new Error("Chrome widget not found");
    }

    await user.click(note);
    pastePlainText(note, "z");
    await waitFor(() => {
      expect(note).toHaveTextContent("z");
    });
    expect(note.firstElementChild).toBe(chrome);

    await replaceFeedbackNote(note, "{Backspace}");
    await waitFor(() => {
      expect(
        note.querySelector<HTMLElement>(":scope > p")?.dataset.placeholder,
      ).toBe("What should change about this?");
    });
    expect(note.firstElementChild).toBe(chrome);
  });

  it("stays editable after the quote block is damaged in place", async () => {
    const user = userEvent.setup({ delay: null });
    const { assistantReply, sentMessages } =
      await setupFeedbackNoteThread("damage");

    selectTextForInlineFeedback(await screen.findByText(assistantReply));
    await user.click(await screen.findByText("Quote"));

    const note = await findFeedbackNote();
    await user.click(note);
    pastePlainText(note, "Make the dates");
    await waitFor(() => {
      expect(note).toHaveTextContent("Make the dates");
    });

    // Damage the block the way the traced WebKit collapse does, with the DOM
    // observer live: the paragraph disappears and a bare <br> replaces it.
    for (const paragraph of Array.from(note.querySelectorAll(":scope > p"))) {
      paragraph.remove();
    }
    note.append(document.createElement("br"));

    // ProseMirror sees the damage (nothing ignores it) and redraws the block
    // into a consistent, editable state instead of a silent divergence.
    await waitFor(() => {
      expect(note.querySelector(":scope > p")).not.toBeNull();
    });

    await user.click(note);
    pastePlainText(note, "typed after damage");
    await waitFor(() => {
      expect(note).toHaveTextContent("typed after damage");
    });

    await user.click(screen.getByLabelText("Send"));
    await waitFor(() => {
      expect(sentMessages).toHaveLength(1);
    });
    expect(sentMessages[0]?.prompt).toContain("typed after damage");
  });

  it("removes the quote block from its widget chrome button", async () => {
    const user = userEvent.setup({ delay: null });
    const { assistantReply } = await setupFeedbackNoteThread("remove");

    selectTextForInlineFeedback(await screen.findByText(assistantReply));
    await user.click(await screen.findByText("Quote"));

    const note = await findFeedbackNote();
    await user.click(within(note).getByLabelText("Remove feedback"));
    await waitFor(() => {
      expect(document.querySelector("[data-feedback-item]")).toBeNull();
    });
  });

  it("waits until mouseup before showing the inline feedback toolbar", async () => {
    const assistantReply = "The rollout dates are unclear in this summary.";

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      chatEvents: [
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

    expect(screen.queryByText("Quote")).not.toBeInTheDocument();

    assistantReplyElement.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true }),
    );

    await waitFor(() => {
      expect(screen.getByText("Quote")).toBeInTheDocument();
    });
  });

  it("shows the inline feedback toolbar when double-click selection settles after mouseup", async () => {
    const assistantReply = "The rollout dates are unclear in this summary.";

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      chatEvents: [
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
      expect(screen.getByText("Quote")).toBeInTheDocument();
    });
  });

  it("keeps composer focus after the inline feedback toolbar closes", async () => {
    const user = userEvent.setup({ delay: null });
    const assistantReply = "The composer should keep focus after feedback.";

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      chatEvents: [
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
      expect(screen.getByText("Quote")).toBeInTheDocument();
    });

    const composerEditor = await findComposerEditor();
    await user.click(composerEditor);
    expect(composerEditor).toHaveFocus();

    await waitFor(() => {
      expect(screen.queryByText("Quote")).not.toBeInTheDocument();
    });
    await waitForDeferredSelectionCapture();

    expect(composerEditor).toHaveFocus();
  });

  it("dismisses the inline feedback toolbar after the system copy shortcut", async () => {
    const assistantReply = "Copy this passage with the system shortcut.";

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      chatEvents: [
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
      expect(screen.getByText("Quote")).toBeInTheDocument();
    });
    expect(window.getSelection()?.toString()).toBe(assistantReply);

    const event = dispatchDocumentShortcut("c", { ctrlKey: true });
    expect(event.defaultPrevented).toBeFalsy();

    await waitFor(() => {
      expect(screen.queryByText("Quote")).not.toBeInTheDocument();
    });
    expect(window.getSelection()?.toString()).toBe(assistantReply);

    dispatchDocumentShortcut("c", { ctrlKey: true }, "keyup");
    await waitForDeferredSelectionCapture();

    expect(screen.queryByText("Quote")).not.toBeInTheDocument();
    expect(window.getSelection()?.toString()).toBe(assistantReply);
  });

  it("focuses the inline feedback composer when started from the keyboard shortcut", async () => {
    const assistantReply = "The launch summary needs more source context.";

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      chatEvents: [
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
      expect(screen.getByText("Quote")).toBeInTheDocument();
    });

    const quoteButton = buttonByText("Quote");
    expect(quoteButton).toHaveAttribute("aria-keyshortcuts", "q");

    const event = dispatchDocumentShortcut("q");
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
      chatEvents: [
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

    const firstReplyElement = await screen.findByText(firstReply, undefined, {
      timeout: 10_000,
    });
    const secondReplyElement = await screen.findByText(secondReply);
    selectTextAcrossElementsForInlineFeedback(
      firstReplyElement,
      secondReplyElement,
    );

    await waitFor(() => {
      expect(screen.getByText("Quote")).toBeInTheDocument();
    });
  });

  it("shows the inline feedback toolbar when a whole paragraph selection ends at the action area", async () => {
    const user = userEvent.setup({ delay: null });
    const assistantReply = "The rollout dates are unclear in this summary.";

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      chatEvents: [
        {
          id: "msg-feedback-paragraph-boundary-user",
          role: "user",
          content: "Review this launch summary",
          runId: "run-feedback-paragraph-boundary",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-feedback-paragraph-boundary-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-feedback-paragraph-boundary",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${FEEDBACK_THREAD_ID}`,
    });

    const assistantReplyElement = await screen.findByText(assistantReply);
    assistantReplyElement.append(document.createTextNode("\n  "));
    const assistantGroup = assistantReplyElement.closest(
      '[data-role="assistant"]',
    );
    const actionArea = assistantActionArea(assistantReplyElement);
    const range = selectTextToAssistantActionBoundaryForInlineFeedback(
      assistantReplyElement,
    );

    expect(range.commonAncestorContainer).toBe(assistantGroup);
    expect(range.endContainer).toBe(actionArea);
    expect(range.endOffset).toBe(0);
    await waitFor(() => {
      expect(buttonByText("Copy")).toBeInTheDocument();
      expect(buttonByText("Quote")).toBeInTheDocument();
      expect(buttonByText("Forward")).toBeInTheDocument();
    });

    await user.click(buttonByText("Quote"));
    const [feedbackItem] = await findFeedbackItems(1);
    expect(feedbackItem?.firstElementChild?.textContent).toBe(assistantReply);
  });

  it("rejects an action-boundary selection that crosses unrelated messages", async () => {
    const firstReply = "The rollout dates are unclear in this summary.";
    const secondReply = "The risk owners are missing from the plan.";

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      chatEvents: [
        {
          id: "msg-feedback-cross-boundary-user-one",
          role: "user",
          content: "Review this launch summary",
          runId: "run-feedback-cross-boundary-one",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-feedback-cross-boundary-assistant-one",
          role: "assistant",
          content: firstReply,
          runId: "run-feedback-cross-boundary-one",
          createdAt: "2026-06-09T10:01:00Z",
        },
        {
          id: "msg-feedback-cross-boundary-user-two",
          role: "user",
          content: "Review the risk plan too",
          runId: "run-feedback-cross-boundary-two",
          createdAt: "2026-06-09T10:02:00Z",
        },
        {
          id: "msg-feedback-cross-boundary-assistant-two",
          role: "assistant",
          content: secondReply,
          runId: "run-feedback-cross-boundary-two",
          createdAt: "2026-06-09T10:03:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${FEEDBACK_THREAD_ID}`,
    });

    const firstReplyElement = await screen.findByText(firstReply);
    const secondReplyElement = await screen.findByText(secondReply);
    selectTextToAssistantActionBoundaryForInlineFeedback(
      firstReplyElement,
      secondReplyElement,
    );
    await waitForDeferredSelectionCapture();

    expect(window.getSelection()?.isCollapsed).toBeFalsy();
    expect(screen.queryByText("Quote")).not.toBeInTheDocument();
  });

  it("dismisses the inline feedback toolbar when a click clears the selection", async () => {
    const assistantReply = "The rollout dates are unclear in this summary.";

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      chatEvents: [
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
      expect(screen.getByText("Quote")).toBeInTheDocument();
    });

    // A real browser emits selectionchange after the selection collapses.
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));

    await waitFor(() => {
      expect(screen.queryByText("Quote")).not.toBeInTheDocument();
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
        defaultProviderType: "built-in",
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
      chatEvents: [
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
    click(await screen.findByLabelText("Select style Award night"));
    click(buttonByText("Use this template"));
    await waitFor(() => {
      expect(findInlineTemplate()).toHaveTextContent(templateChipLabel);
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
      expect(screen.getByText("Quote")).toBeInTheDocument();
    });
    click(buttonByText("Quote"));

    pastePlainText(
      await findFeedbackNote(),
      "Use the attached brief as supporting context.",
    );
    expect(findInlineTemplate()).toHaveTextContent(templateChipLabel);
    expect(
      screen.getByLabelText("Remove feedback-brief.txt"),
    ).toBeInTheDocument();

    click(screen.getByLabelText("Send"));

    await waitFor(() => {
      expect(sentBodies).toHaveLength(1);
    });
    const sentBody = sentBodies[0];
    if (!sentBody) {
      throw new Error("feedback send body not captured");
    }
    expect(sentBody.userMessage?.parts).toContainEqual({
      type: "file",
      fileId: "upload-feedback-brief",
      filenameSnapshot: "feedback-brief.txt",
      contentType: "text/plain",
    });
    expect(sentBody.userMessage?.parts).toContainEqual({
      type: "template",
      titleSnapshot: templateChipLabel,
      template: {
        type: "presentation",
        selection: {
          colorSystemId: "color-system:gold-luxe",
          templateId: template.templateId,
          previewUrl: template.embedUrl,
        },
      },
    });
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
      chatEvents: [
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
      expect(screen.getByText("Quote")).toBeInTheDocument();
    });
    await user.click(buttonByText("Quote"));

    const firstComment = await findFeedbackNote();
    await user.keyboard("Assign each risk to an owner.");
    await waitFor(() => {
      expect(firstComment).toHaveTextContent("Assign each risk to an owner.");
    });

    selectTextForInlineFeedback(assistantReplyElement);
    await waitFor(() => {
      expect(screen.getByText("Quote")).toBeInTheDocument();
    });
    await user.click(buttonByText("Quote"));

    const comments = await findFeedbackNotes(2);
    expect(comments).toHaveLength(2);
    // The first note persists on top; the newest fragment sits below it with
    // an empty note, taking the composer position nearest Send.
    expect(comments[0]).toHaveTextContent("Assign each risk to an owner.");
    expect(comments[1]?.querySelector(":scope > p")).toHaveTextContent(/^$/);

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
      chatEvents: [
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
      expect(screen.getByText("Quote")).toBeInTheDocument();
    });
    await user.click(buttonByText("Quote"));

    const firstComment = await findFeedbackNote();
    await user.keyboard("Add owners.");
    await waitFor(() => {
      expect(firstComment).toHaveTextContent("Add owners.");
    });

    selectTextForInlineFeedback(assistantReplyElement);
    await waitFor(() => {
      expect(screen.getByText("Quote")).toBeInTheDocument();
    });
    await user.click(buttonByText("Quote"));

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

  it("sends multiple referenced passages without comments", async () => {
    const user = userEvent.setup({ delay: null });
    const assistantReply = "The launch summary needs clearer risk ownership.";
    const firstQuote = "launch summary";
    const secondQuote = "risk ownership";
    const firstRange = {
      start: assistantReply.indexOf(firstQuote),
      end: assistantReply.indexOf(firstQuote) + firstQuote.length,
    };
    const secondRange = {
      start: assistantReply.indexOf(secondQuote),
      end: assistantReply.indexOf(secondQuote) + secondQuote.length,
    };
    const sentMessages: RunCreateCapture[] = [];

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      chatEvents: [
        {
          id: "msg-quote-only-user",
          role: "user",
          content: "Review this launch summary",
          runId: "run-quote-only",
          createdAt: "2026-08-18T10:00:00Z",
        },
        {
          id: "msg-quote-only-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-quote-only",
          createdAt: "2026-08-18T10:01:00Z",
        },
      ],
      onRunCreate: (body) => {
        sentMessages.push(body);
      },
    });

    detachedSetupPage({
      context,
      path: `/chats/${FEEDBACK_THREAD_ID}`,
    });

    const assistantReplyElement = await screen.findByText(assistantReply);
    selectTextForInlineFeedback(assistantReplyElement, firstRange);
    await user.click(await screen.findByText("Quote"));
    await findFeedbackNote();

    selectTextForInlineFeedback(assistantReplyElement, secondRange);
    await user.click(await screen.findByText("Quote"));
    await findFeedbackNotes(2);
    await user.click(screen.getByLabelText("Send"));

    await waitFor(() => {
      expect(sentMessages).toHaveLength(1);
    });
    expect(sentMessages[0]).toMatchObject({
      prompt:
        "The user referenced 2 parts of your reply:\n\n" +
        `> ${firstQuote}\n\n---\n\n` +
        `> ${secondQuote}`,
      hasTextContent: true,
      userMessage: {
        version: 1,
        parts: [
          {
            type: "feedback",
            quote: firstQuote,
            eventId: "msg-quote-only-assistant",
            range: firstRange,
            note: [],
          },
          {
            type: "feedback",
            quote: secondQuote,
            eventId: "msg-quote-only-assistant",
            range: secondRange,
            note: [],
          },
        ],
      },
    });
    const sentFeedbackGroup = await waitFor(() => {
      const group = document.querySelector("[data-structured-feedback-group]");
      expect(group).toBeInstanceOf(HTMLElement);
      return group as HTMLElement;
    });
    expect(
      Array.from(
        sentFeedbackGroup.querySelectorAll("[data-structured-feedback-quote]"),
      ).map((quote) => {
        return quote.textContent;
      }),
    ).toStrictEqual([firstQuote, secondQuote]);
    await waitFor(() => {
      expect(feedbackNotes()).toHaveLength(0);
    });
  });

  it("keeps the divider spacing off the first inline feedback item", async () => {
    const user = userEvent.setup({ delay: null });
    const assistantReply = "The launch summary needs clearer risk ownership.";

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      chatEvents: [
        {
          id: "msg-feedback-spacing-user",
          role: "user",
          content: "Review this launch summary",
          runId: "run-feedback-spacing",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-feedback-spacing-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-feedback-spacing",
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
      expect(screen.getByText("Quote")).toBeInTheDocument();
    });
    await user.click(buttonByText("Quote"));

    // Alone, the quote chip aligns with the editor's own pt-4 inset.
    const [onlyItem] = await findFeedbackItems(1);
    expect(onlyItem).not.toHaveClass("pt-1.5");

    selectTextForInlineFeedback(assistantReplyElement);
    await waitFor(() => {
      expect(screen.getByText("Quote")).toBeInTheDocument();
    });
    await user.click(buttonByText("Quote"));

    const items = await findFeedbackItems(2);
    expect(items[0]).not.toHaveClass("pt-1.5");
    expect(items[1]).toHaveClass("pt-1.5", "border-t");
  });
});
