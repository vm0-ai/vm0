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

// Assistant messages and other agent-produced content, such as linked email
// drafts, opt into the shared Copy / Provide feedback interaction.
const FEEDBACK_SOURCE_SELECTOR =
  ".zero-chat-bubble-assistant, [data-feedback-source]";
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

export interface FeedbackSource {
  readonly type: "mail";
  readonly id: string;
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
  readonly source?: FeedbackSource;
}

// A quoted passage together with the note the user is writing about it. Every
// fragment is a peer: there is no separate "draft" — each row owns its note and
// edits it in place, so the tray reads as one continuous stack of comments.
export interface FeedbackItem {
  readonly id: number;
  readonly quote: string;
  readonly note: string;
  readonly source?: FeedbackSource;
}

export interface FeedbackEditorAdapter {
  insertItem(item: FeedbackItem): void;
  removeItem(id: number): void;
}

export interface FeedbackSignals {
  readonly items$: Computed<readonly FeedbackItem[]>;
  readonly active$: Computed<boolean>;
  readonly selection$: Computed<FeedbackSelection | null>;
  readonly startFeedback$: Command<void, []>;
  readonly replaceFromEditor$: Command<void, [readonly FeedbackItem[]]>;
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

function closestFeedbackSource(node: Node | null): Element | null {
  if (!node) {
    return null;
  }
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest(FEEDBACK_SOURCE_SELECTOR) ?? null;
}

function resolveSelectionSource(range: Range): Element | null {
  const commonSource = closestFeedbackSource(range.commonAncestorContainer);
  if (commonSource) {
    return commonSource;
  }

  // Multi-line selections can report an outer message group as the range's
  // common ancestor even when both endpoints are inside assistant bubbles.
  const startSource = closestFeedbackSource(range.startContainer);
  const endSource = closestFeedbackSource(range.endContainer);
  if (!startSource || !endSource) {
    return null;
  }
  if (startSource === endSource) {
    return startSource;
  }

  const startGroup = startSource.closest(ASSISTANT_GROUP_SELECTOR);
  const endGroup = endSource.closest(ASSISTANT_GROUP_SELECTOR);
  if (startGroup !== null && startGroup === endGroup) {
    return startSource;
  }

  return null;
}

// The id of the thread that owns the selected passage, or null when it sits
// outside any thread container.
function resolveSelectionThreadId(source: Element): string | null {
  const container = source.closest(THREAD_CONTAINER_SELECTOR);
  if (!(container instanceof HTMLElement)) {
    return null;
  }
  return container.dataset.chatThreadContainerId ?? null;
}

function resolveFeedbackSource(source: Element): FeedbackSource | undefined {
  if (!(source instanceof HTMLElement)) {
    return undefined;
  }
  const type = source.dataset.feedbackSourceType;
  const id = source.dataset.feedbackSourceId;
  if (type !== "mail" || !id) {
    return undefined;
  }
  return { type, id };
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

// Read the live document selection when it sits inside supported content.
function readFeedbackSourceSelection(): {
  text: string;
  range: Range;
  source: Element;
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
  const source = resolveSelectionSource(range);
  if (!source) {
    return null;
  }
  return { text, range, source };
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
  const found = readFeedbackSourceSelection();
  if (!found) {
    return null;
  }
  const rect = rectFromRange(found.range);
  const source = resolveFeedbackSource(found.source);
  return {
    text: found.text,
    threadId: resolveSelectionThreadId(found.source),
    range: found.range.cloneRange(),
    rect,
    ...(source ? { source } : {}),
  };
}

// Compose every noted fragment into a single follow-up turn, each passage
// quoted above the note that belongs to it.
export function formatFeedbackPrompt(items: readonly FeedbackItem[]): string {
  const firstMailDraftId = items[0]?.source?.id;
  const commonMailDraftId =
    firstMailDraftId !== undefined &&
    items.every((item) => {
      return (
        item.source?.type === "mail" && item.source.id === firstMailDraftId
      );
    })
      ? firstMailDraftId
      : null;
  const hasSourceContext = items.some((item) => {
    return item.source !== undefined;
  });
  const blocks = items.map((item) => {
    const quoted = item.quote
      .split("\n")
      .map((line) => {
        return `> ${line}`;
      })
      .join("\n");
    const source =
      commonMailDraftId === null && item.source?.type === "mail"
        ? `Source: email draft (mail draft ID: ${item.source.id})\n\n`
        : "";
    return `${source}${quoted}\n\n${item.note.trim()}`;
  });
  const intro = commonMailDraftId
    ? items.length === 1
      ? `Feedback on this part of an email draft (mail draft ID: ${commonMailDraftId}):`
      : `Feedback on ${items.length} parts of an email draft (mail draft ID: ${commonMailDraftId}):`
    : hasSourceContext
      ? `Feedback on ${items.length} selected ${items.length === 1 ? "passage" : "passages"}:`
      : items.length === 1
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

function createFeedbackSelectionState(threadId: string) {
  const selectionState$ = state<FeedbackSelection | null>(null);
  const resetSelectionToolbarSignal$ = resetSignal();
  const selection$ = computed((get) => {
    return get(selectionState$);
  });
  const closeSelectionToolbar$ = command(({ set }) => {
    set(resetSelectionToolbarSignal$);
    set(selectionState$, null);
  });
  const captureSelection$ = command(({ set }) => {
    const selection = readFeedbackSelection();
    if (!selection || selection.threadId !== threadId) {
      set(closeSelectionToolbar$);
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
  return {
    selectionState$,
    resetSelectionToolbarSignal$,
    selection$,
    closeSelectionToolbar$,
    captureSelection$,
    dismissSelectionOnScroll$,
    copySelection$,
  };
}

function createFeedbackItemSignals({
  threadId,
  editor,
  selectionState$,
  closeSelectionToolbar$,
}: {
  threadId: string;
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
    },
  );
  const startFeedback$ = command(({ get, set }) => {
    const selection = get(selectionState$);
    if (!selection) {
      return;
    }
    const id = get(nextIdState$);
    const item = {
      id,
      quote: selection.text,
      note: "",
      ...(selection.source ? { source: selection.source } : {}),
    };
    const items = [...get(itemsState$), item];
    set(nextIdState$, id + 1);
    set(itemsState$, items);
    const ranges = new Map<number, Range>(get(rangesState$));
    if (selection.range) {
      ranges.set(id, selection.range);
    }
    set(rangesState$, ranges);
    set(setFeedbackHighlight$, threadId, ranges);
    editor.insertItem(item);
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
    editor.removeItem(id);
  });
  return {
    items$,
    active$,
    startFeedback$,
    replaceFromEditor$,
    removeFeedback$,
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
          if (toolbarSignal.aborted) {
            return;
          }
          if (matchShortcut("mod+c", event)) {
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

function createPointerSelectionListeners({
  selectionState$,
  closeSelectionToolbar$,
}: {
  selectionState$: State<FeedbackSelection | null>;
  closeSelectionToolbar$: Command<void, []>;
}) {
  return command(({ get, set }, doc: Document, signal: AbortSignal) => {
    doc.addEventListener(
      "pointerdown",
      (event) => {
        if (
          get(selectionState$) !== null &&
          shouldDismissSelectionForInteractionTarget(event.target)
        ) {
          set(closeSelectionToolbar$);
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
    let mouseSelectionInProgress = false;
    // Read the selection one macrotask after the interaction settles.
    // Rescheduling aborts the previous read, coalescing event bursts into one
    // capture.
    const captureDeferred = async () => {
      await delay(0, { signal: set(deferredCaptureSignal$, signal) });
      set(captureSelection$);
    };
    doc.addEventListener(
      "mousedown",
      (event) => {
        mouseSelectionInProgress =
          event.button === 0 &&
          event.target instanceof Node &&
          closestFeedbackSource(event.target) !== null;
      },
      { capture: true, signal },
    );
    doc.addEventListener(
      "mouseup",
      onDomEventFn(async () => {
        if (!mouseSelectionInProgress) {
          return;
        }
        mouseSelectionInProgress = false;
        await captureDeferred();
      }),
      { signal },
    );
    doc.addEventListener(
      "selectionchange",
      onDomEventFn(async () => {
        if (!mouseSelectionInProgress) {
          await captureDeferred();
        }
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
): FeedbackSignals {
  const selection = createFeedbackSelectionState(threadId);
  const items = createFeedbackItemSignals({
    threadId,
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
    closeSelectionToolbar$: selection.closeSelectionToolbar$,
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

  return {
    ...items,
    selection$: selection.selection$,
    closeSelectionToolbar$: selection.closeSelectionToolbar$,
    copySelection$: selection.copySelection$,
    setSelectionListenersRef$,
    setSelectionToolbarRef$,
  };
}
