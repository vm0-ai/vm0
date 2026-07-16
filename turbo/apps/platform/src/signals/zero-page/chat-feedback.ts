import { state, computed, command } from "ccstate";
import { isEditableTarget, matchShortcut } from "@vm0/ui";
import { toast } from "@vm0/ui/components/ui/sonner";
import { writeToClipboard } from "./clipboard.ts";
import { ensureDraft$ } from "../chat-page/create-chat-thread.ts";
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

const feedbackSelection$ = state<FeedbackSelection | null>(null);
const feedbackItems$ = state<readonly FeedbackItem[]>([]);
const feedbackThreadId$ = state<string | null>(null);
// Source-passage ranges keyed by feedback item id, used to keep each commented
// passage highlighted while its draft lives.
const feedbackRanges$ = state<ReadonlyMap<number, Range>>(new Map());
const feedbackNextId$ = state<number>(1);
const resetFeedbackSelectionToolbarSignal$ = resetSignal();

export const feedbackSelectionValue$ = computed((get) => {
  return get(feedbackSelection$);
});

export const feedbackItemsValue$ = computed((get) => {
  return get(feedbackItems$);
});

// Which thread the docked feedback belongs to. The composer compares this to
// its own thread id so a draft only ever shows in the thread it came from.
export const feedbackThreadIdValue$ = computed((get) => {
  return get(feedbackThreadId$);
});

// What "Send" will dispatch: every fragment that carries a non-empty note.
export const feedbackSendCountValue$ = computed((get) => {
  return get(feedbackItems$).filter((item) => {
    return item.note.trim().length > 0;
  }).length;
});

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
// The painter is a pure function of the range map (kept in feedbackRanges$) and
// is a no-op where the API is unavailable (e.g. the test/SSR environment).
// ---------------------------------------------------------------------------

const FEEDBACK_HIGHLIGHT_NAME = "zero-feedback";

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

function applyFeedbackHighlight(ranges: ReadonlyMap<number, Range>): void {
  const registry = highlightRegistry();
  if (!registry) {
    return;
  }
  if (ranges.size === 0) {
    registry.delete(FEEDBACK_HIGHLIGHT_NAME);
    return;
  }
  registry.set(FEEDBACK_HIGHLIGHT_NAME, new Highlight(...ranges.values()));
}

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

const hideFeedbackSelectionToolbar$ = command(({ set }) => {
  set(resetFeedbackSelectionToolbarSignal$);
  set(feedbackSelection$, null);
});

export const closeFeedbackSelectionToolbar$ = command(({ get, set }) => {
  if (get(feedbackSelection$) === null) {
    return;
  }
  set(hideFeedbackSelectionToolbar$);
  window.getSelection()?.removeAllRanges();
});

// Watch the document selection and drive the floating toolbar. The toolbar
// shows whether or not the tray is open — selecting another passage and
// clicking "Provide feedback" again is how a further fragment is added.
export const captureFeedbackSelection$ = command(({ get, set }) => {
  const selection = readFeedbackSelection();
  if (!selection) {
    if (get(feedbackSelection$) !== null) {
      set(closeFeedbackSelectionToolbar$);
    }
    return;
  }
  set(feedbackSelection$, selection);
});

// Selectionchange can arrive after mouseup for double-click/line selections in
// Chromium. Use it only as an additive capture path so toolbar button clicks are
// not interrupted when focusing a button clears the native selection.
export const captureFeedbackSelectionIfPresent$ = command(({ set }) => {
  const selection = readFeedbackSelection();
  if (!selection) {
    return;
  }
  set(feedbackSelection$, selection);
});

// "Provide feedback" on a passage: append it as a new fragment. The newest
// fragment is the one the user just picked, so the view focuses its note input.
export const startFeedback$ = command(({ get, set }) => {
  const selection = get(feedbackSelection$);
  if (!selection) {
    return;
  }
  // A feedback stack belongs to a single thread. Picking a passage from a
  // different thread starts a fresh stack instead of mixing comments across
  // threads.
  const activeThreadId = get(feedbackThreadId$);
  const crossesThreads =
    activeThreadId !== null && activeThreadId !== selection.threadId;
  const existing = crossesThreads ? [] : get(feedbackItems$);
  // When this is the first comment in a stack, carry any text already typed in
  // the composer into its note — otherwise the textarea (and the text in it)
  // vanishes the moment the feedback rows replace it, and the pending text is
  // lost when the turn sends. Only non-blank text is moved, and it leaves the
  // draft so it is not also re-sent. Later comments find the draft empty.
  let note = "";
  if (existing.length === 0 && selection.threadId !== null) {
    const { draft } = set(ensureDraft$, selection.threadId);
    const pending = get(draft.input$);
    if (pending.trim().length > 0) {
      note = pending;
      set(draft.setInput$, "");
    }
  }
  const id = get(feedbackNextId$);
  set(feedbackNextId$, id + 1);
  set(feedbackThreadId$, selection.threadId);
  set(feedbackItems$, [...existing, { id, quote: selection.text, note }]);

  // A fresh stack on a thread switch starts the highlights over too.
  const ranges = new Map<number, Range>(
    crossesThreads ? [] : get(feedbackRanges$),
  );
  if (selection.range) {
    ranges.set(id, selection.range);
  }
  set(feedbackRanges$, ranges);
  applyFeedbackHighlight(ranges);
  set(closeFeedbackSelectionToolbar$);
});

export const setFeedbackItemNote$ = command(
  ({ get, set }, payload: { id: number; note: string }) => {
    set(
      feedbackItems$,
      get(feedbackItems$).map((item) => {
        return item.id === payload.id ? { ...item, note: payload.note } : item;
      }),
    );
  },
);

export const removeFeedbackItem$ = command(({ get, set }, id: number) => {
  const ranges = new Map<number, Range>(get(feedbackRanges$));
  if (ranges.delete(id)) {
    set(feedbackRanges$, ranges);
    applyFeedbackHighlight(ranges);
  }
  set(
    feedbackItems$,
    get(feedbackItems$).filter((item) => {
      return item.id !== id;
    }),
  );
});

// TipTap owns the editable feedback document while feedback is active. Mirror
// its current items back into the selection state and release highlights for
// any block removed from the document.
export const replaceFeedbackItems$ = command(
  ({ get, set }, items: readonly FeedbackItem[]) => {
    const retainedIds = new Set(
      items.map((item) => {
        return item.id;
      }),
    );
    const ranges = new Map(
      Array.from(get(feedbackRanges$)).filter(([id]) => {
        return retainedIds.has(id);
      }),
    );
    set(feedbackRanges$, ranges);
    applyFeedbackHighlight(ranges);
    set(feedbackItems$, items);
    if (items.length === 0) {
      set(feedbackThreadId$, null);
    }
  },
);

// Compose every noted fragment into one prompt and clear the shared editor
// state before the asynchronous send begins. Failed sends intentionally do not
// restore the feedback draft.
export const submitFeedback$ = command(({ get, set }): string | null => {
  const noted = get(feedbackItems$).filter((item) => {
    return item.note.trim().length > 0;
  });
  if (noted.length === 0) {
    return null;
  }
  const prompt = formatFeedbackPrompt(noted);
  set(dismissFeedback$);
  return prompt;
});

export const dismissFeedback$ = command(({ set }) => {
  set(closeFeedbackSelectionToolbar$);
  const emptyRanges = new Map<number, Range>();
  set(feedbackRanges$, emptyRanges);
  applyFeedbackHighlight(emptyRanges);
  set(feedbackItems$, []);
  set(feedbackThreadId$, null);
});

// Dismiss only the floating selection toolbar — the docked tray keeps its
// comments, so clicking away from a fresh selection never wipes earlier notes.
export const dismissFeedbackSelection$ = closeFeedbackSelectionToolbar$;

// Scrolling detaches the toolbar from its passage, so hide it. The docked tray
// is pinned above the composer, not to the selection, so it stays put.
export const dismissFeedbackOnScroll$ = command(({ get, set }) => {
  if (get(feedbackSelection$) === null) {
    return;
  }
  set(closeFeedbackSelectionToolbar$);
});

export const copyFeedbackSelection$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const selection = get(feedbackSelection$);
    if (!selection) {
      return;
    }
    signal.throwIfAborted();
    const text = selection.text;
    const ok = await writeToClipboard(text);
    signal.throwIfAborted();
    if (ok) {
      set(closeFeedbackSelectionToolbar$);
      toast.success("Copied");
    }
  },
);

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

export const setFeedbackSelectionToolbarRef$ = onRef(
  command(({ set }, el: HTMLElement, signal: AbortSignal) => {
    const toolbarSignal = set(resetFeedbackSelectionToolbarSignal$, signal);
    el.ownerDocument.addEventListener(
      "keydown",
      onDomEventFn(async (event: KeyboardEvent) => {
        if (event.defaultPrevented || toolbarSignal.aborted) {
          return;
        }
        if (matchShortcut("escape", event)) {
          event.preventDefault();
          set(closeFeedbackSelectionToolbar$);
          return;
        }
        if (shouldIgnoreTextShortcut(event)) {
          return;
        }
        if (matchShortcut("c", event)) {
          event.preventDefault();
          await set(copyFeedbackSelection$, signal);
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

export const setFeedbackSelectionListenersRef$ = onRef(
  command(({ get, set }, el: HTMLElement, signal: AbortSignal) => {
    const doc = el.ownerDocument;
    let captureTimerId: number | null = null;
    let pendingDismissWhenEmpty = false;
    let mouseIsDown = false;
    let suppressSelectionCapture = false;
    let suppressSelectionClearTimerId: number | null = null;
    const capture = () => {
      set(captureFeedbackSelection$);
    };
    const captureIfPresent = () => {
      set(captureFeedbackSelectionIfPresent$);
    };
    const captureDeferred = (dismissWhenEmpty: boolean) => {
      pendingDismissWhenEmpty ||= dismissWhenEmpty;
      captureTimerId = clearWindowTimer(captureTimerId);
      captureTimerId = window.setTimeout(() => {
        const shouldDismissWhenEmpty = pendingDismissWhenEmpty;
        captureTimerId = null;
        pendingDismissWhenEmpty = false;
        if (shouldDismissWhenEmpty) {
          capture();
          return;
        }
        captureIfPresent();
      }, 0);
    };
    const clearSuppressedSelectionCaptureSoon = () => {
      suppressSelectionClearTimerId = clearWindowTimer(
        suppressSelectionClearTimerId,
      );
      suppressSelectionClearTimerId = window.setTimeout(() => {
        suppressSelectionCapture = false;
        suppressSelectionClearTimerId = null;
      }, 0);
    };
    const dismissSelectionForComposerInteraction = (
      target: EventTarget | null,
    ) => {
      if (
        get(feedbackSelection$) === null ||
        !shouldDismissSelectionForInteractionTarget(target)
      ) {
        return;
      }
      suppressSelectionCapture = true;
      // Do not clear the native selection here: the composer may already own
      // the caret by the time the popover finishes closing.
      set(hideFeedbackSelectionToolbar$);
    };

    // Starting an interaction in the composer should hand focus back to the
    // composer, not let a stale assistant selection reopen the toolbar.
    doc.addEventListener(
      "pointerdown",
      (event) => {
        dismissSelectionForComposerInteraction(event.target);
      },
      { capture: true, signal },
    );
    doc.addEventListener(
      "pointerup",
      (event) => {
        // Mouse interactions finish through the mouseup path below; touch/pen
        // may not, so clear their suppression after the pointer sequence.
        if ((event as PointerEvent).pointerType !== "mouse") {
          clearSuppressedSelectionCaptureSoon();
        }
      },
      { signal },
    );
    doc.addEventListener("pointercancel", clearSuppressedSelectionCaptureSoon, {
      signal,
    });
    doc.addEventListener(
      "mousedown",
      () => {
        mouseIsDown = true;
      },
      { capture: true, signal },
    );
    doc.addEventListener(
      "mouseup",
      () => {
        mouseIsDown = false;
        if (suppressSelectionCapture) {
          suppressSelectionCapture = false;
          return;
        }
        captureDeferred(true);
      },
      { signal },
    );
    doc.addEventListener(
      "dblclick",
      () => {
        mouseIsDown = false;
        captureDeferred(false);
      },
      { signal },
    );
    doc.addEventListener(
      "selectionchange",
      () => {
        if (mouseIsDown || suppressSelectionCapture) {
          return;
        }
        captureDeferred(false);
      },
      { signal },
    );
    doc.addEventListener("keyup", capture, { signal });
    doc.addEventListener(
      "scroll",
      () => {
        set(dismissFeedbackOnScroll$);
      },
      {
        capture: true,
        passive: true,
        signal,
      },
    );
    signal.addEventListener(
      "abort",
      () => {
        captureTimerId = clearWindowTimer(captureTimerId);
        suppressSelectionClearTimerId = clearWindowTimer(
          suppressSelectionClearTimerId,
        );
      },
      { once: true },
    );
  }),
);
