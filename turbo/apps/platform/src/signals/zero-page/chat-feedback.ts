import {
  state,
  computed,
  command,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { delay } from "signal-timers";
import { isEditableTarget, matchShortcut } from "@vm0/ui";
import { toast } from "@vm0/ui/components/ui/sonner";
import { writeToClipboard } from "./clipboard.ts";
import { onDomEventFn, onRef, resetSignal } from "../utils.ts";

// Assistant message bubbles carry this class in the chat thread. Text selected
// inside one of them is what we offer feedback on.
const ASSISTANT_BUBBLE_SELECTOR = ".zero-chat-bubble-assistant";
const ASSISTANT_GROUP_SELECTOR = '[data-role="assistant"]';

// Each chat thread renders inside a container tagged with its thread id. We
// read it off the selection so a feedback draft stays bound to its own thread.
const THREAD_CONTAINER_SELECTOR = "[data-chat-thread-container-id]";
const CHAT_COMPOSER_SELECTOR = "[data-chat-composer]";
// The Codex-style inline feedback input; interacting with it must not dismiss
// the quoted passage it is anchored to.
const FEEDBACK_INPUT_SELECTOR = "[data-feedback-input]";

export interface FeedbackSelectionRect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface FeedbackSelection {
  readonly text: string;
  readonly rect: FeedbackSelectionRect;
  // The thread the selected passage belongs to. Feedback stays with this
  // thread, so switching chats never carries the draft across.
  readonly threadId: string | null;
  // A snapshot of the selected range. Kept so the passage can stay highlighted
  // once the comment is drafted and the native selection clears.
  readonly range: Range | null;
}

// A quoted passage together with the note the user is writing about it. Every
// fragment is a peer: there is no separate "draft" — each row owns its note and
// edits it in place, so the tray reads as one continuous stack of comments.
export interface FeedbackItem {
  readonly id: number;
  readonly quote: string;
  readonly note: string;
}

export interface FeedbackEditorAdapter {
  insertItem(item: FeedbackItem): void;
  removeItem(id: number): void;
}

export interface FeedbackDraftSignals {
  readonly items$: Computed<readonly FeedbackItem[]>;
  readonly setItems$: Command<void, [readonly FeedbackItem[]]>;
}

export interface FeedbackSignals {
  readonly items$: Computed<readonly FeedbackItem[]>;
  readonly active$: Computed<boolean>;
  readonly feedbackMessageCardsEnabled: boolean;
  readonly selection$: Computed<FeedbackSelection | null>;
  readonly startFeedback$: Command<void, []>;
  // Insert a feedback item whose note is already written — used by the
  // Codex-style inline input that collects the comment beside the selection
  // before the item lands in the composer.
  readonly startFeedbackWithNote$: Command<void, [string]>;
  // Draft state for that inline input: whether it is open for the current
  // selection and the note being typed.
  readonly draftOpen$: Computed<boolean>;
  readonly draftNote$: Computed<string>;
  readonly openFeedbackDraft$: Command<void, []>;
  readonly setFeedbackDraftNote$: Command<void, [string]>;
  readonly submitFeedbackDraft$: Command<void, []>;
  readonly cancelFeedbackDraft$: Command<void, []>;
  readonly dismissFeedbackDraft$: Command<void, []>;
  readonly replaceFromEditor$: Command<void, [readonly FeedbackItem[]]>;
  readonly updateFeedbackNote$: Command<void, [id: number, note: string]>;
  readonly removeFeedback$: Command<void, [number]>;
  readonly closeSelectionToolbar$: Command<void, []>;
  readonly copySelection$: Command<Promise<void>, [AbortSignal]>;
  readonly setSelectionListenersRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly setSelectionToolbarRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
}

function closestAssistantBubble(node: Node | null): Element | null {
  if (!node) {
    return null;
  }
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest(ASSISTANT_BUBBLE_SELECTOR) ?? null;
}

function resolveSelectionBubble(range: Range): Element | null {
  const commonBubble = closestAssistantBubble(range.commonAncestorContainer);
  if (commonBubble) {
    return commonBubble;
  }

  // Multi-line selections can report an outer message group as the range's
  // common ancestor even when both endpoints are inside assistant bubbles.
  const startBubble = closestAssistantBubble(range.startContainer);
  const endBubble = closestAssistantBubble(range.endContainer);
  if (!startBubble || !endBubble) {
    return null;
  }
  if (startBubble === endBubble) {
    return startBubble;
  }

  const startGroup = startBubble.closest(ASSISTANT_GROUP_SELECTOR);
  const endGroup = endBubble.closest(ASSISTANT_GROUP_SELECTOR);
  if (startGroup !== null && startGroup === endGroup) {
    return startBubble;
  }

  return null;
}

// The id of the thread that owns the selected passage, or null when it sits
// outside any thread container.
function resolveSelectionThreadId(bubble: Element): string | null {
  const container = bubble.closest(THREAD_CONTAINER_SELECTOR);
  if (!(container instanceof HTMLElement)) {
    return null;
  }
  return container.dataset.chatThreadContainerId ?? null;
}

// ---------------------------------------------------------------------------
// Source-passage highlight. While a feedback comment is being drafted, its
// quoted passage stays highlighted inside the message via the CSS Custom
// Highlight API, so the comment is visibly anchored to the text it is about.
// The painter is a pure function of the per-thread range maps and
// is a no-op where the API is unavailable (e.g. the test/SSR environment).
// ---------------------------------------------------------------------------

const FEEDBACK_HIGHLIGHT_NAME = "zero-feedback";
const feedbackRangesByThread$ = state<
  ReadonlyMap<string, ReadonlyMap<number, Range>>
>(new Map());

function highlightRegistry(): HighlightRegistry | null {
  if (
    typeof CSS === "undefined" ||
    typeof Highlight === "undefined" ||
    !CSS.highlights
  ) {
    return null;
  }
  return CSS.highlights;
}

function applyFeedbackHighlight(
  feedbackRangesByThread: ReadonlyMap<string, ReadonlyMap<number, Range>>,
): void {
  const registry = highlightRegistry();
  if (!registry) {
    return;
  }
  const activeRanges = Array.from(feedbackRangesByThread.values()).flatMap(
    (threadRanges) => {
      return Array.from(threadRanges.values());
    },
  );
  if (activeRanges.length === 0) {
    registry.delete(FEEDBACK_HIGHLIGHT_NAME);
    return;
  }
  registry.set(FEEDBACK_HIGHLIGHT_NAME, new Highlight(...activeRanges));
}

const setFeedbackHighlight$ = command(
  ({ get, set }, threadId: string, ranges: ReadonlyMap<number, Range>) => {
    const rangesByThread = new Map(get(feedbackRangesByThread$));
    if (ranges.size === 0) {
      rangesByThread.delete(threadId);
    } else {
      rangesByThread.set(threadId, ranges);
    }
    set(feedbackRangesByThread$, rangesByThread);
    applyFeedbackHighlight(rangesByThread);
  },
);

// Read the live document selection when it sits inside an assistant message.
function readAssistantSelection(): {
  text: string;
  range: Range;
  bubble: Element;
} | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }
  const text = selection.toString().trim();
  if (!text) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const bubble = resolveSelectionBubble(range);
  if (!bubble) {
    return null;
  }
  return { text, range, bubble };
}

function hasVisibleArea(rect: DOMRectReadOnly): boolean {
  return rect.width > 0 && rect.height > 0;
}

function rectFromRange(range: Range): FeedbackSelectionRect {
  const rects = Array.from(range.getClientRects()).filter(hasVisibleArea);
  if (rects.length === 0) {
    const rect = range.getBoundingClientRect();
    return {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    };
  }

  const top = Math.min(
    ...rects.map((rect) => {
      return rect.top;
    }),
  );
  const left = Math.min(
    ...rects.map((rect) => {
      return rect.left;
    }),
  );
  const right = Math.max(
    ...rects.map((rect) => {
      return rect.right;
    }),
  );
  const bottom = Math.max(
    ...rects.map((rect) => {
      return rect.bottom;
    }),
  );
  return {
    top,
    left,
    width: right - left,
    height: bottom - top,
  };
}

function readFeedbackSelection(): FeedbackSelection | null {
  const found = readAssistantSelection();
  if (!found) {
    return null;
  }
  const rect = rectFromRange(found.range);
  return {
    text: found.text,
    threadId: resolveSelectionThreadId(found.bubble),
    range: found.range.cloneRange(),
    rect,
  };
}

// Compose every noted fragment into a single follow-up turn, each passage
// quoted above the note that belongs to it.
export function formatFeedbackPrompt(items: readonly FeedbackItem[]): string {
  const blocks = items.map((item) => {
    const quoted = item.quote
      .split("\n")
      .map((line) => {
        return `> ${line}`;
      })
      .join("\n");
    return `${quoted}\n\n${item.note.trim()}`;
  });
  const intro =
    items.length === 1
      ? "Feedback on this part of your reply:"
      : `Feedback on ${items.length} parts of your reply:`;
  return `${intro}\n\n${blocks.join("\n\n---\n\n")}`;
}

function shouldIgnoreTextShortcut(event: KeyboardEvent): boolean {
  return isEditableTarget(event.target);
}

function isFeedbackInputTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest(FEEDBACK_INPUT_SELECTOR) !== null
  );
}

function shouldDismissSelectionForInteractionTarget(
  target: EventTarget | null,
): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  // Typing the comment in the inline feedback input must keep the passage
  // selected, otherwise the input would dismiss its own anchor.
  if (isFeedbackInputTarget(target)) {
    return false;
  }
  return (
    isEditableTarget(target) || target.closest(CHAT_COMPOSER_SELECTOR) !== null
  );
}

function createFeedbackSelectionState(threadId: string) {
  const selectionState$ = state<FeedbackSelection | null>(null);
  const resetSelectionToolbarSignal$ = resetSignal();
  // Inline-input draft: open while the user is typing a comment beside the
  // selected passage, cleared whenever the toolbar is dismissed.
  const draftOpenState$ = state(false);
  const draftNoteState$ = state("");
  const draftOpen$ = computed((get) => {
    return get(draftOpenState$);
  });
  const draftNote$ = computed((get) => {
    return get(draftNoteState$);
  });
  const resetDraft$ = command(({ set }) => {
    set(draftOpenState$, false);
    set(draftNoteState$, "");
  });
  const openFeedbackDraft$ = command(({ set }) => {
    set(draftNoteState$, "");
    set(draftOpenState$, true);
  });
  const setFeedbackDraftNote$ = command(({ set }, note: string) => {
    set(draftNoteState$, note);
  });
  const selection$ = computed((get) => {
    return get(selectionState$);
  });
  const hideSelectionToolbar$ = command(({ set }) => {
    set(resetSelectionToolbarSignal$);
    set(selectionState$, null);
    set(resetDraft$);
  });
  const closeSelectionToolbar$ = command(({ get, set }) => {
    if (get(selectionState$) === null || get(draftOpenState$)) {
      return;
    }
    set(hideSelectionToolbar$);
  });
  const captureSelection$ = command(({ get, set }) => {
    const selection = readFeedbackSelection();
    if (!selection || selection.threadId !== threadId) {
      // While the inline input is open the native selection legitimately moves
      // into the textarea, so keep the anchored passage instead of dismissing.
      if (get(draftOpenState$)) {
        return;
      }
      if (get(selectionState$) !== null) {
        set(hideSelectionToolbar$);
      }
      return;
    }
    set(selectionState$, selection);
  });
  const dismissSelectionOnScroll$ = command(({ get, set }) => {
    if (get(selectionState$) !== null) {
      set(closeSelectionToolbar$);
    }
  });
  const copySelection$ = command(async ({ get, set }, signal: AbortSignal) => {
    const selection = get(selectionState$);
    if (!selection) {
      return;
    }
    signal.throwIfAborted();
    const ok = await writeToClipboard(selection.text);
    signal.throwIfAborted();
    if (ok) {
      set(closeSelectionToolbar$);
      toast.success("Copied");
    }
  });
  const cancelFeedbackDraft$ = command(({ set }) => {
    set(resetDraft$);
  });
  const dismissFeedbackDraft$ = command(({ set }) => {
    set(hideSelectionToolbar$);
    window.getSelection()?.removeAllRanges();
  });
  return {
    selectionState$,
    resetSelectionToolbarSignal$,
    selection$,
    hideSelectionToolbar$,
    closeSelectionToolbar$,
    captureSelection$,
    dismissSelectionOnScroll$,
    copySelection$,
    draftOpen$,
    draftNote$,
    openFeedbackDraft$,
    setFeedbackDraftNote$,
    cancelFeedbackDraft$,
    dismissFeedbackDraft$,
  };
}

function createFeedbackItemSignals({
  threadId,
  editor,
  syncEditor,
  draft,
  selectionState$,
  hideSelectionToolbar$,
}: {
  threadId: string;
  editor: FeedbackEditorAdapter;
  syncEditor: boolean;
  draft: FeedbackDraftSignals | undefined;
  selectionState$: State<FeedbackSelection | null>;
  hideSelectionToolbar$: Command<void, []>;
}) {
  const itemsState$ = state<readonly FeedbackItem[]>([]);
  const rangesState$ = state<ReadonlyMap<number, Range>>(new Map());
  const nextIdState$ = state(1);
  const localItems$ = computed((get) => {
    return get(itemsState$);
  });
  const items$ = draft?.items$ ?? localItems$;
  const setItems$ = command(({ set }, nextItems: readonly FeedbackItem[]) => {
    if (draft) {
      set(draft.setItems$, nextItems);
      return;
    }
    set(itemsState$, nextItems);
  });
  const active$ = computed((get) => {
    return get(items$).length > 0;
  });
  const replaceFromEditor$ = command(
    ({ get, set }, items: readonly FeedbackItem[]) => {
      const retainedIds = new Set(
        items.map((item) => {
          return item.id;
        }),
      );
      const ranges = new Map(
        Array.from(get(rangesState$)).filter(([id]) => {
          return retainedIds.has(id);
        }),
      );
      set(rangesState$, ranges);
      set(setFeedbackHighlight$, threadId, ranges);
      set(setItems$, items);
      set(
        nextIdState$,
        items.reduce((nextId, item) => {
          return Math.max(nextId, item.id + 1);
        }, 1),
      );
    },
  );
  const startFeedbackWithNote$ = command(({ get, set }, note: string) => {
    const selection = get(selectionState$);
    if (!selection) {
      return;
    }
    const currentItems = get(items$);
    const id = draft
      ? currentItems.reduce((nextId, item) => {
          return Math.max(nextId, item.id + 1);
        }, 1)
      : get(nextIdState$);
    const item = { id, quote: selection.text, note };
    set(nextIdState$, id + 1);
    set(setItems$, [...currentItems, item]);
    const ranges = new Map<number, Range>(get(rangesState$));
    if (selection.range) {
      ranges.set(id, selection.range);
    }
    set(rangesState$, ranges);
    set(setFeedbackHighlight$, threadId, ranges);
    if (syncEditor) {
      editor.insertItem(item);
    }
    set(hideSelectionToolbar$);
  });
  const startFeedback$ = command(({ set }) => {
    set(startFeedbackWithNote$, "");
  });
  const updateFeedbackNote$ = command(
    ({ get, set }, id: number, note: string) => {
      const item = get(items$).find((candidate) => {
        return candidate.id === id;
      });
      if (!item) {
        return;
      }
      set(
        setItems$,
        get(items$).map((candidate) => {
          return candidate.id === id ? { ...item, note } : candidate;
        }),
      );
    },
  );
  const removeFeedback$ = command(({ get, set }, id: number) => {
    const items = get(items$).filter((item) => {
      return item.id !== id;
    });
    const ranges = new Map<number, Range>(get(rangesState$));
    ranges.delete(id);
    set(rangesState$, ranges);
    set(setFeedbackHighlight$, threadId, ranges);
    set(setItems$, items);
    if (syncEditor) {
      editor.removeItem(id);
    }
  });
  return {
    items$,
    active$,
    startFeedback$,
    startFeedbackWithNote$,
    replaceFromEditor$,
    updateFeedbackNote$,
    removeFeedback$,
  };
}

function createSelectionToolbarRef({
  resetSelectionToolbarSignal$,
  closeSelectionToolbar$,
  copySelection$,
  provideFeedback$,
  feedbackMessageCardsEnabled,
}: {
  resetSelectionToolbarSignal$: ReturnType<typeof resetSignal>;
  closeSelectionToolbar$: Command<void, []>;
  copySelection$: Command<Promise<void>, [AbortSignal]>;
  provideFeedback$: Command<void, []>;
  feedbackMessageCardsEnabled: boolean;
}) {
  return onRef(
    command(({ set }, el: HTMLElement, signal: AbortSignal) => {
      const toolbarSignal = set(resetSelectionToolbarSignal$, signal);
      el.ownerDocument.addEventListener(
        "keydown",
        onDomEventFn(async (event: KeyboardEvent) => {
          if (toolbarSignal.aborted) {
            return;
          }
          if (matchShortcut("mod+c", event)) {
            if (shouldIgnoreTextShortcut(event)) {
              return;
            }
            // Preserve the browser's native copy action, then dismiss only the
            // feedback state without changing the document selection.
            await delay(0, { signal: toolbarSignal });
            set(closeSelectionToolbar$);
            return;
          }
          if (event.defaultPrevented) {
            return;
          }
          if (matchShortcut("escape", event)) {
            event.preventDefault();
            set(closeSelectionToolbar$);
            return;
          }
          const feedbackShortcutMatches =
            matchShortcut("f", event) ||
            (feedbackMessageCardsEnabled && matchShortcut("q", event));
          if (feedbackShortcutMatches && !isFeedbackInputTarget(event.target)) {
            // Selecting assistant text does not move focus away from the main
            // composer. Treat the feedback shortcuts before the generic
            // editable-target guard so that stale composer focus does not make
            // them inert. F remains supported for users without browser-level
            // link-hint shortcuts; Q is the conflict-free visible shortcut.
            event.preventDefault();
            set(provideFeedback$);
            return;
          }
          if (shouldIgnoreTextShortcut(event)) {
            return;
          }
          if (matchShortcut("c", event)) {
            event.preventDefault();
            await set(copySelection$, signal);
            return;
          }
        }),
        { signal: toolbarSignal },
      );
    }),
  );
}

function createPointerSelectionListeners({
  selectionState$,
  draftOpen$,
  hideSelectionToolbar$,
}: {
  selectionState$: State<FeedbackSelection | null>;
  draftOpen$: Computed<boolean>;
  hideSelectionToolbar$: Command<void, []>;
}) {
  return command(({ get, set }, doc: Document, signal: AbortSignal) => {
    doc.addEventListener(
      "pointerdown",
      (event) => {
        const target = event.target;
        if (
          get(draftOpen$) &&
          target instanceof HTMLElement &&
          target.closest(FEEDBACK_INPUT_SELECTOR) === null
        ) {
          set(hideSelectionToolbar$);
          return;
        }
        if (
          get(selectionState$) !== null &&
          shouldDismissSelectionForInteractionTarget(target)
        ) {
          set(hideSelectionToolbar$);
        }
      },
      { capture: true, signal },
    );
  });
}

function createDocumentSelectionListeners({
  threadId,
  captureSelection$,
  dismissSelectionOnScroll$,
}: {
  threadId: string;
  captureSelection$: Command<void, []>;
  dismissSelectionOnScroll$: Command<void, []>;
}) {
  const deferredCaptureSignal$ = resetSignal();
  return command(({ set }, doc: Document, signal: AbortSignal) => {
    // Read the selection one macrotask after selectionchange. Rescheduling
    // aborts the previous read, coalescing event bursts into one capture.
    const captureDeferred = async () => {
      await delay(0, { signal: set(deferredCaptureSignal$, signal) });
      set(captureSelection$);
    };
    doc.addEventListener(
      "selectionchange",
      onDomEventFn(async () => {
        await captureDeferred();
      }),
      { signal },
    );
    doc.addEventListener(
      "scroll",
      () => {
        set(dismissSelectionOnScroll$);
      },
      { capture: true, passive: true, signal },
    );
    signal.addEventListener(
      "abort",
      () => {
        set(setFeedbackHighlight$, threadId, new Map());
      },
      { once: true },
    );
  });
}

function createSelectionListenersRef({
  pointerListeners$,
  documentListeners$,
}: {
  pointerListeners$: ReturnType<typeof createPointerSelectionListeners>;
  documentListeners$: ReturnType<typeof createDocumentSelectionListeners>;
}) {
  return onRef(
    command(({ set }, el: HTMLElement, signal: AbortSignal) => {
      set(pointerListeners$, el.ownerDocument, signal);
      set(documentListeners$, el.ownerDocument, signal);
    }),
  );
}

export function createFeedbackSignals(
  threadId: string,
  editor: FeedbackEditorAdapter,
  feedbackMessageCardsEnabled = false,
  draft?: FeedbackDraftSignals,
): FeedbackSignals {
  const selection = createFeedbackSelectionState(threadId);
  const items = createFeedbackItemSignals({
    threadId,
    editor,
    syncEditor: !feedbackMessageCardsEnabled,
    draft: feedbackMessageCardsEnabled ? draft : undefined,
    selectionState$: selection.selectionState$,
    hideSelectionToolbar$: selection.hideSelectionToolbar$,
  });
  const provideFeedback$ = command(({ set }) => {
    if (feedbackMessageCardsEnabled) {
      set(selection.openFeedbackDraft$);
      return;
    }
    set(items.startFeedback$);
  });
  const setSelectionToolbarRef$ = createSelectionToolbarRef({
    resetSelectionToolbarSignal$: selection.resetSelectionToolbarSignal$,
    closeSelectionToolbar$: selection.closeSelectionToolbar$,
    copySelection$: selection.copySelection$,
    provideFeedback$,
    feedbackMessageCardsEnabled,
  });
  const pointerListeners$ = createPointerSelectionListeners({
    selectionState$: selection.selectionState$,
    draftOpen$: selection.draftOpen$,
    hideSelectionToolbar$: selection.hideSelectionToolbar$,
  });
  const documentListeners$ = createDocumentSelectionListeners({
    threadId,
    captureSelection$: selection.captureSelection$,
    dismissSelectionOnScroll$: selection.dismissSelectionOnScroll$,
  });
  const setSelectionListenersRef$ = createSelectionListenersRef({
    pointerListeners$,
    documentListeners$,
  });
  const submitFeedbackDraft$ = command(({ get, set }) => {
    const note = get(selection.draftNote$);
    if (note.trim().length === 0) {
      return;
    }
    set(items.startFeedbackWithNote$, note);
  });

  return {
    ...items,
    feedbackMessageCardsEnabled,
    selection$: selection.selection$,
    closeSelectionToolbar$: selection.closeSelectionToolbar$,
    copySelection$: selection.copySelection$,
    setSelectionListenersRef$,
    setSelectionToolbarRef$,
    draftOpen$: selection.draftOpen$,
    draftNote$: selection.draftNote$,
    openFeedbackDraft$: selection.openFeedbackDraft$,
    setFeedbackDraftNote$: selection.setFeedbackDraftNote$,
    submitFeedbackDraft$,
    cancelFeedbackDraft$: selection.cancelFeedbackDraft$,
    dismissFeedbackDraft$: selection.dismissFeedbackDraft$,
  };
}
