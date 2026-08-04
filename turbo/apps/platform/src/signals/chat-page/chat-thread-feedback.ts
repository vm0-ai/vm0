import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { delay } from "signal-timers";
import { isEditableTarget, matchShortcut } from "@vm0/ui";
import { toast } from "@vm0/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import {
  createComposerFeedbackModel,
  type ComposerFeedbackModel,
  type FeedbackItem,
  type FeedbackSource,
} from "../zero-page/chat-feedback.ts";
import { writeToClipboard } from "../zero-page/clipboard.ts";
import { onDomEventFn, onRef, resetSignal } from "../utils.ts";

// Assistant messages and other agent-produced content, such as linked email
// drafts, opt into the shared Copy / Provide feedback interaction.
const FEEDBACK_SOURCE_SELECTOR =
  ".zero-chat-bubble-assistant, [data-feedback-source]";
const ASSISTANT_GROUP_SELECTOR = '[data-role="assistant"]';
const THREAD_CONTAINER_SELECTOR = "[data-chat-thread-container-id]";
const CHAT_COMPOSER_SELECTOR = "[data-chat-composer]";

export interface ChatThreadFeedbackSelection {
  readonly rect: {
    readonly top: number;
    readonly left: number;
    readonly width: number;
    readonly height: number;
  };
}

interface CapturedFeedbackSelection {
  readonly text: string;
  readonly rect: ChatThreadFeedbackSelection["rect"];
  readonly threadId: string | null;
  readonly range: Range;
  readonly source?: FeedbackSource;
}

export interface ChatThreadFeedbackSignals {
  readonly selection$: Computed<ChatThreadFeedbackSelection | null>;
  readonly start$: Command<void, []>;
  readonly close$: Command<void, []>;
  readonly copy$: Command<Promise<void>, [AbortSignal]>;
  readonly setListenersRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly setToolbarRef$: Command<
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
  return startGroup !== null && startGroup === endGroup ? startSource : null;
}

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
  const status = source.dataset.feedbackSourceStatus;
  const sentId = source.dataset.feedbackSourceSentId;
  if (type !== "mail" || !id || (status !== "draft" && status !== "sent")) {
    return undefined;
  }
  return { type, id, status, ...(sentId ? { sentId } : {}) };
}

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

function hasVisibleArea(rect: DOMRectReadOnly): boolean {
  return rect.width > 0 && rect.height > 0;
}

function rectFromRange(range: Range): ChatThreadFeedbackSelection["rect"] {
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
  return { top, left, width: right - left, height: bottom - top };
}

function readFeedbackSelection(): CapturedFeedbackSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }
  const text = selection.toString().trim();
  if (!text) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const sourceElement = resolveSelectionSource(range);
  if (!sourceElement) {
    return null;
  }
  const source = resolveFeedbackSource(sourceElement);
  return {
    text,
    rect: rectFromRange(range),
    threadId: resolveSelectionThreadId(sourceElement),
    range: range.cloneRange(),
    ...(source ? { source } : {}),
  };
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

function createSelectionState(threadId: string) {
  const internalSelection$ = state<CapturedFeedbackSelection | null>(null);
  const resetToolbarSignal$ = resetSignal();
  const selection$ = computed((get): ChatThreadFeedbackSelection | null => {
    return get(internalSelection$);
  });
  const close$ = command(({ set }) => {
    set(resetToolbarSignal$);
    set(internalSelection$, null);
  });
  const capture$ = command(({ set }) => {
    const selection = readFeedbackSelection();
    if (!selection || selection.threadId !== threadId) {
      set(close$);
      return;
    }
    set(internalSelection$, selection);
  });
  const dismissOnScroll$ = command(({ get, set }) => {
    if (get(internalSelection$) !== null) {
      set(close$);
    }
  });
  const copy$ = command(async ({ get, set }, signal: AbortSignal) => {
    const selection = get(internalSelection$);
    if (!selection) {
      return;
    }
    signal.throwIfAborted();
    const copied = await writeToClipboard(selection.text);
    signal.throwIfAborted();
    if (copied) {
      set(close$);
      toast.success(
        i18n.t(($) => {
          return $.chat.toasts.copied;
        }),
      );
    }
  });
  return {
    internalSelection$,
    resetToolbarSignal$,
    selection$,
    close$,
    capture$,
    dismissOnScroll$,
    copy$,
  };
}

function createUpdateRanges(
  ranges: State<ReadonlyMap<number, Range>>,
  threadId: string,
) {
  return command(
    (
      { get, set },
      update: (current: ReadonlyMap<number, Range>) => Map<number, Range>,
    ) => {
      const next = update(get(ranges));
      set(ranges, next);
      set(setFeedbackHighlight$, threadId, next);
    },
  );
}

function createThreadComposerFeedback(
  threadId: string,
  ranges$: State<ReadonlyMap<number, Range>>,
): ComposerFeedbackModel {
  const base = createComposerFeedbackModel();
  const updateRanges$ = createUpdateRanges(ranges$, threadId);
  // Composer mutations remain editor-only. This thread-owned decoration keeps
  // the corresponding source ranges in sync without exposing Range to it.
  const remove$ = command(({ set }, id: number) => {
    set(updateRanges$, (ranges) => {
      const next = new Map(ranges);
      next.delete(id);
      return next;
    });
    set(base.signals.remove$, id);
  });
  const replaceFromEditor$ = command(
    ({ set }, items: readonly FeedbackItem[]) => {
      const retainedIds = new Set(
        items.map((item) => {
          return item.id;
        }),
      );
      set(updateRanges$, (ranges) => {
        return new Map(
          Array.from(ranges).filter(([id]) => {
            return retainedIds.has(id);
          }),
        );
      });
      set(base.replaceFromEditor$, items);
    },
  );
  return {
    ...base,
    signals: { add$: base.signals.add$, remove$ },
    replaceFromEditor$,
  };
}

function createStartFeedback(
  selection$: State<CapturedFeedbackSelection | null>,
  close$: Command<void, []>,
  ranges$: State<ReadonlyMap<number, Range>>,
  threadId: string,
  composer: ComposerFeedbackModel,
) {
  const updateRanges$ = createUpdateRanges(ranges$, threadId);
  return command(({ get, set }) => {
    const selection = get(selection$);
    if (!selection) {
      return;
    }
    const id = set(composer.signals.add$, {
      quote: selection.text,
      ...(selection.source ? { source: selection.source } : {}),
    });
    set(updateRanges$, (ranges) => {
      const next = new Map(ranges);
      next.set(id, selection.range);
      return next;
    });
    set(close$);
  });
}

function createToolbarRef({
  resetToolbarSignal$,
  close$,
  copy$,
  start$,
}: {
  resetToolbarSignal$: ReturnType<typeof resetSignal>;
  close$: Command<void, []>;
  copy$: Command<Promise<void>, [AbortSignal]>;
  start$: Command<void, []>;
}) {
  return onRef(
    command(({ set }, el: HTMLElement, signal: AbortSignal) => {
      const toolbarSignal = set(resetToolbarSignal$, signal);
      el.ownerDocument.addEventListener(
        "keydown",
        onDomEventFn(async (event: KeyboardEvent) => {
          if (toolbarSignal.aborted) {
            return;
          }
          if (matchShortcut("mod+c", event)) {
            await delay(0, { signal: toolbarSignal });
            set(close$);
            return;
          }
          if (event.defaultPrevented) {
            return;
          }
          if (matchShortcut("escape", event)) {
            event.preventDefault();
            set(close$);
            return;
          }
          if (isEditableTarget(event.target)) {
            return;
          }
          if (matchShortcut("c", event)) {
            event.preventDefault();
            await set(copy$, signal);
            return;
          }
          if (matchShortcut("f", event)) {
            event.preventDefault();
            set(start$);
          }
        }),
        { signal: toolbarSignal },
      );
    }),
  );
}

function createListenersRef({
  threadId,
  selection$,
  close$,
  capture$,
  dismissOnScroll$,
}: {
  threadId: string;
  selection$: State<CapturedFeedbackSelection | null>;
  close$: Command<void, []>;
  capture$: Command<void, []>;
  dismissOnScroll$: Command<void, []>;
}) {
  const deferredCaptureSignal$ = resetSignal();
  return onRef(
    command(({ get, set }, el: HTMLElement, signal: AbortSignal) => {
      const doc = el.ownerDocument;
      let mouseSelectionInProgress = false;
      const captureDeferred = async () => {
        await delay(0, { signal: set(deferredCaptureSignal$, signal) });
        set(capture$);
      };
      doc.addEventListener(
        "pointerdown",
        (event) => {
          if (
            get(selection$) !== null &&
            shouldDismissSelectionForInteractionTarget(event.target)
          ) {
            set(close$);
          }
        },
        { capture: true, signal },
      );
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
          set(dismissOnScroll$);
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
    }),
  );
}

export function createChatThreadFeedbackSignals(threadId: string): {
  readonly signals: ChatThreadFeedbackSignals;
  readonly composer: ComposerFeedbackModel;
} {
  const selection = createSelectionState(threadId);
  const ranges$ = state<ReadonlyMap<number, Range>>(new Map());
  const composer = createThreadComposerFeedback(threadId, ranges$);
  const start$ = createStartFeedback(
    selection.internalSelection$,
    selection.close$,
    ranges$,
    threadId,
    composer,
  );
  const setToolbarRef$ = createToolbarRef({
    resetToolbarSignal$: selection.resetToolbarSignal$,
    close$: selection.close$,
    copy$: selection.copy$,
    start$,
  });
  const setListenersRef$ = createListenersRef({
    threadId,
    selection$: selection.internalSelection$,
    close$: selection.close$,
    capture$: selection.capture$,
    dismissOnScroll$: selection.dismissOnScroll$,
  });
  return {
    composer,
    signals: {
      selection$: selection.selection$,
      start$,
      close$: selection.close$,
      copy$: selection.copy$,
      setListenersRef$,
      setToolbarRef$,
    },
  };
}
