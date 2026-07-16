import {
  state,
  computed,
  command,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { isEditableTarget, matchShortcut } from "@vm0/ui";
import { toast } from "@vm0/ui/components/ui/sonner";
import { writeToClipboard } from "./clipboard.ts";
import type { DraftSignals } from "./chat-draft.ts";
import { onDomEventFn, onRef, resetSignal } from "../utils.ts";

// Assistant message bubbles carry this class in the chat thread. Text selected
// inside one of them is what we offer feedback on.
const ASSISTANT_BUBBLE_SELECTOR = ".zero-chat-bubble-assistant";
const ASSISTANT_GROUP_SELECTOR = '[data-role="assistant"]';

// Each chat thread renders inside a container tagged with its thread id. We
// read it off the selection so a feedback draft stays bound to its own thread.
const THREAD_CONTAINER_SELECTOR = "[data-chat-thread-container-id]";
const CHAT_COMPOSER_SELECTOR = "[data-chat-composer]";

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
  replaceItems(
    items: readonly FeedbackItem[] | null,
    draftValue: string,
    focusNewest: boolean,
  ): void;
}

export interface FeedbackSignals {
  readonly items$: Computed<readonly FeedbackItem[]>;
  readonly active$: Computed<boolean>;
  readonly sendCount$: Computed<number>;
  readonly selection$: Computed<FeedbackSelection | null>;
  readonly startFeedback$: Command<void, []>;
  readonly replaceFromEditor$: Command<void, [readonly FeedbackItem[]]>;
  readonly removeFeedback$: Command<void, [number]>;
  readonly dismissFeedback$: Command<void, []>;
  readonly submitFeedback$: Command<string | null, []>;
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
function formatFeedbackPrompt(items: readonly FeedbackItem[]): string {
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

function shouldDismissSelectionForInteractionTarget(
  target: EventTarget | null,
): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    isEditableTarget(target) || target.closest(CHAT_COMPOSER_SELECTOR) !== null
  );
}

function clearWindowTimer(timerId: number | null): null {
  if (timerId !== null) {
    window.clearTimeout(timerId);
  }
  return null;
}

function createFeedbackSelectionState(threadId: string) {
  const selectionState$ = state<FeedbackSelection | null>(null);
  const resetSelectionToolbarSignal$ = resetSignal();
  const selection$ = computed((get) => {
    return get(selectionState$);
  });
  const hideSelectionToolbar$ = command(({ set }) => {
    set(resetSelectionToolbarSignal$);
    set(selectionState$, null);
  });
  const closeSelectionToolbar$ = command(({ get, set }) => {
    if (get(selectionState$) === null) {
      return;
    }
    set(hideSelectionToolbar$);
    window.getSelection()?.removeAllRanges();
  });
  const captureSelection$ = command(({ get, set }) => {
    const selection = readFeedbackSelection();
    if (!selection || selection.threadId !== threadId) {
      if (get(selectionState$) !== null) {
        set(hideSelectionToolbar$);
      }
      return;
    }
    set(selectionState$, selection);
  });
  const captureSelectionIfPresent$ = command(({ set }) => {
    const selection = readFeedbackSelection();
    if (selection?.threadId === threadId) {
      set(selectionState$, selection);
    }
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
  return {
    selectionState$,
    resetSelectionToolbarSignal$,
    selection$,
    hideSelectionToolbar$,
    closeSelectionToolbar$,
    captureSelection$,
    captureSelectionIfPresent$,
    dismissSelectionOnScroll$,
    copySelection$,
  };
}

function createFeedbackItemSignals({
  threadId,
  draft,
  editor,
  selectionState$,
  closeSelectionToolbar$,
}: {
  threadId: string;
  draft: DraftSignals;
  editor: FeedbackEditorAdapter;
  selectionState$: State<FeedbackSelection | null>;
  closeSelectionToolbar$: Command<void, []>;
}) {
  const itemsState$ = state<readonly FeedbackItem[]>([]);
  const rangesState$ = state<ReadonlyMap<number, Range>>(new Map());
  const nextIdState$ = state(1);
  const items$ = computed((get) => {
    return get(itemsState$);
  });
  const active$ = computed((get) => {
    return get(itemsState$).length > 0;
  });
  const sendCount$ = computed((get) => {
    return get(itemsState$).filter((item) => {
      return item.note.trim().length > 0;
    }).length;
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
      set(itemsState$, items);
      if (items.length === 0) {
        editor.replaceItems(null, get(draft.input$), false);
      }
    },
  );
  const startFeedback$ = command(({ get, set }) => {
    const selection = get(selectionState$);
    if (!selection) {
      return;
    }
    const existing = get(itemsState$);
    const pending = existing.length === 0 ? get(draft.input$) : "";
    const note = pending.trim().length > 0 ? pending : "";
    if (note) {
      set(draft.setInput$, "");
    }
    const id = get(nextIdState$);
    const items = [...existing, { id, quote: selection.text, note }];
    set(nextIdState$, id + 1);
    set(itemsState$, items);
    const ranges = new Map<number, Range>(get(rangesState$));
    if (selection.range) {
      ranges.set(id, selection.range);
    }
    set(rangesState$, ranges);
    set(setFeedbackHighlight$, threadId, ranges);
    editor.replaceItems(items, get(draft.input$), true);
    set(closeSelectionToolbar$);
  });
  const removeFeedback$ = command(({ get, set }, id: number) => {
    const items = get(itemsState$).filter((item) => {
      return item.id !== id;
    });
    const ranges = new Map<number, Range>(get(rangesState$));
    ranges.delete(id);
    set(rangesState$, ranges);
    set(setFeedbackHighlight$, threadId, ranges);
    set(itemsState$, items);
    editor.replaceItems(
      items.length > 0 ? items : null,
      get(draft.input$),
      false,
    );
  });
  const dismissFeedback$ = command(({ get, set }) => {
    set(closeSelectionToolbar$);
    const ranges = new Map<number, Range>();
    set(rangesState$, ranges);
    set(setFeedbackHighlight$, threadId, ranges);
    set(itemsState$, []);
    editor.replaceItems(null, get(draft.input$), false);
  });
  const submitFeedback$ = command(({ get, set }): string | null => {
    const noted = get(itemsState$).filter((item) => {
      return item.note.trim().length > 0;
    });
    if (noted.length === 0) {
      return null;
    }
    const prompt = formatFeedbackPrompt(noted);
    set(dismissFeedback$);
    return prompt;
  });
  return {
    items$,
    active$,
    sendCount$,
    startFeedback$,
    replaceFromEditor$,
    removeFeedback$,
    dismissFeedback$,
    submitFeedback$,
  };
}

function createSelectionToolbarRef({
  resetSelectionToolbarSignal$,
  closeSelectionToolbar$,
  copySelection$,
  startFeedback$,
}: {
  resetSelectionToolbarSignal$: ReturnType<typeof resetSignal>;
  closeSelectionToolbar$: Command<void, []>;
  copySelection$: Command<Promise<void>, [AbortSignal]>;
  startFeedback$: Command<void, []>;
}) {
  return onRef(
    command(({ set }, el: HTMLElement, signal: AbortSignal) => {
      const toolbarSignal = set(resetSelectionToolbarSignal$, signal);
      el.ownerDocument.addEventListener(
        "keydown",
        onDomEventFn(async (event: KeyboardEvent) => {
          if (event.defaultPrevented || toolbarSignal.aborted) {
            return;
          }
          if (matchShortcut("escape", event)) {
            event.preventDefault();
            set(closeSelectionToolbar$);
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
          if (matchShortcut("f", event)) {
            event.preventDefault();
            set(startFeedback$);
          }
        }),
        { signal: toolbarSignal },
      );
    }),
  );
}

interface SelectionListenerRuntime {
  captureTimerId: number | null;
  pendingDismissWhenEmpty: boolean;
  mouseIsDown: boolean;
  suppressSelectionCapture: boolean;
  suppressSelectionClearTimerId: number | null;
}

function createPointerSelectionListeners({
  selectionState$,
  hideSelectionToolbar$,
}: {
  selectionState$: State<FeedbackSelection | null>;
  hideSelectionToolbar$: Command<void, []>;
}) {
  return command(
    (
      { get, set },
      doc: Document,
      runtime: SelectionListenerRuntime,
      signal: AbortSignal,
    ) => {
      const clearSuppressedSelectionCaptureSoon = () => {
        runtime.suppressSelectionClearTimerId = clearWindowTimer(
          runtime.suppressSelectionClearTimerId,
        );
        runtime.suppressSelectionClearTimerId = window.setTimeout(() => {
          runtime.suppressSelectionCapture = false;
          runtime.suppressSelectionClearTimerId = null;
        }, 0);
      };
      doc.addEventListener(
        "pointerdown",
        (event) => {
          if (
            get(selectionState$) !== null &&
            shouldDismissSelectionForInteractionTarget(event.target)
          ) {
            runtime.suppressSelectionCapture = true;
            set(hideSelectionToolbar$);
          }
        },
        { capture: true, signal },
      );
      doc.addEventListener(
        "pointerup",
        (event) => {
          if ((event as PointerEvent).pointerType !== "mouse") {
            clearSuppressedSelectionCaptureSoon();
          }
        },
        { signal },
      );
      doc.addEventListener(
        "pointercancel",
        clearSuppressedSelectionCaptureSoon,
        { signal },
      );
      doc.addEventListener(
        "mousedown",
        () => {
          runtime.mouseIsDown = true;
        },
        { capture: true, signal },
      );
    },
  );
}

function createDocumentSelectionListeners({
  threadId,
  captureSelection$,
  captureSelectionIfPresent$,
  dismissSelectionOnScroll$,
}: {
  threadId: string;
  captureSelection$: Command<void, []>;
  captureSelectionIfPresent$: Command<void, []>;
  dismissSelectionOnScroll$: Command<void, []>;
}) {
  return command(
    (
      { set },
      doc: Document,
      runtime: SelectionListenerRuntime,
      signal: AbortSignal,
    ) => {
      const capture = () => {
        set(captureSelection$);
      };
      const captureIfPresent = () => {
        set(captureSelectionIfPresent$);
      };
      const captureDeferred = (dismissWhenEmpty: boolean) => {
        runtime.pendingDismissWhenEmpty ||= dismissWhenEmpty;
        runtime.captureTimerId = clearWindowTimer(runtime.captureTimerId);
        runtime.captureTimerId = window.setTimeout(() => {
          const shouldDismissWhenEmpty = runtime.pendingDismissWhenEmpty;
          runtime.captureTimerId = null;
          runtime.pendingDismissWhenEmpty = false;
          if (shouldDismissWhenEmpty) {
            capture();
          } else {
            captureIfPresent();
          }
        }, 0);
      };
      doc.addEventListener(
        "mouseup",
        () => {
          runtime.mouseIsDown = false;
          if (runtime.suppressSelectionCapture) {
            runtime.suppressSelectionCapture = false;
            return;
          }
          captureDeferred(true);
        },
        { signal },
      );
      doc.addEventListener(
        "dblclick",
        () => {
          runtime.mouseIsDown = false;
          captureDeferred(false);
        },
        { signal },
      );
      doc.addEventListener(
        "selectionchange",
        () => {
          if (!runtime.mouseIsDown && !runtime.suppressSelectionCapture) {
            captureDeferred(false);
          }
        },
        { signal },
      );
      doc.addEventListener("keyup", capture, { signal });
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
          runtime.captureTimerId = clearWindowTimer(runtime.captureTimerId);
          runtime.suppressSelectionClearTimerId = clearWindowTimer(
            runtime.suppressSelectionClearTimerId,
          );
          set(setFeedbackHighlight$, threadId, new Map());
        },
        { once: true },
      );
    },
  );
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
      const runtime: SelectionListenerRuntime = {
        captureTimerId: null,
        pendingDismissWhenEmpty: false,
        mouseIsDown: false,
        suppressSelectionCapture: false,
        suppressSelectionClearTimerId: null,
      };
      set(pointerListeners$, el.ownerDocument, runtime, signal);
      set(documentListeners$, el.ownerDocument, runtime, signal);
    }),
  );
}

export function createFeedbackSignals(
  threadId: string,
  draft: DraftSignals,
  editor: FeedbackEditorAdapter,
): FeedbackSignals {
  const selection = createFeedbackSelectionState(threadId);
  const items = createFeedbackItemSignals({
    threadId,
    draft,
    editor,
    selectionState$: selection.selectionState$,
    closeSelectionToolbar$: selection.closeSelectionToolbar$,
  });
  const setSelectionToolbarRef$ = createSelectionToolbarRef({
    resetSelectionToolbarSignal$: selection.resetSelectionToolbarSignal$,
    closeSelectionToolbar$: selection.closeSelectionToolbar$,
    copySelection$: selection.copySelection$,
    startFeedback$: items.startFeedback$,
  });
  const pointerListeners$ = createPointerSelectionListeners({
    selectionState$: selection.selectionState$,
    hideSelectionToolbar$: selection.hideSelectionToolbar$,
  });
  const documentListeners$ = createDocumentSelectionListeners({
    threadId,
    captureSelection$: selection.captureSelection$,
    captureSelectionIfPresent$: selection.captureSelectionIfPresent$,
    dismissSelectionOnScroll$: selection.dismissSelectionOnScroll$,
  });
  const setSelectionListenersRef$ = createSelectionListenersRef({
    pointerListeners$,
    documentListeners$,
  });

  return {
    ...items,
    selection$: selection.selection$,
    closeSelectionToolbar$: selection.closeSelectionToolbar$,
    copySelection$: selection.copySelection$,
    setSelectionListenersRef$,
    setSelectionToolbarRef$,
  };
}
