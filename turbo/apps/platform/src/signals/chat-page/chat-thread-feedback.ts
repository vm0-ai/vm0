import type { prepareChatForwardComposer$ } from "./chat-forward-composer.ts";
import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { animationFrame, delay } from "signal-timers";
import { isEditableTarget, matchShortcut } from "@okouai/ui";
import { toast } from "@okouai/ui/components/ui/sonner";
import type { ChatTranslationLanguage } from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { i18n } from "../../i18n/index.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import type {
  ComposerFeedbackSignals,
  FeedbackRange,
  FeedbackSource,
} from "../okou-page/chat-feedback.ts";
import { writeToClipboard } from "../okou-page/clipboard.ts";
import { setChatListQuery$ } from "../okou-page/sidebar-state.ts";
import { onDomEventFn, onRef, resetSignal } from "../utils.ts";
import type {
  ChatForwardTarget,
  ChatForwardContext,
  ChatForwardSelection,
} from "./chat-forward.ts";
import {
  persistChatTranslationLanguage$,
  requestChatTranslation$,
  savedChatTranslationLanguage$,
} from "./chat-translation.ts";
import {
  createTouchSelectionListeners,
  createTouchSelectionOverlayRef,
  FEEDBACK_SOURCE_SELECTOR,
  measureTouchSelection,
  touchSelectionText,
  type TouchSelectionGeometry,
} from "./chat-touch-selection.ts";

const ASSISTANT_GROUP_SELECTOR = '[data-role="assistant"]';
const CHAT_EVENT_SELECTOR = "[data-chat-scroll-anchor-event-id]";
const THREAD_CONTAINER_SELECTOR = "[data-chat-thread-container-id]";
const CHAT_COMPOSER_SELECTOR = "[data-chat-composer]";
const RUN_GROUP_SELECTOR = "[data-chat-run-id]";
const SELECTION_INTERACTION_SELECTOR = "[data-chat-selection-interaction]";
const SELECTION_SCROLL_DISMISS_DISTANCE_PX = 8;

export interface ChatThreadFeedbackSelection {
  readonly rect: {
    readonly top: number;
    readonly left: number;
    readonly width: number;
    readonly height: number;
  };
  readonly text: string;
  readonly threadId: string | null;
  readonly runId: string | null;
  readonly eventId?: string;
  readonly range?: FeedbackRange;
  readonly source?: FeedbackSource;
  readonly touch?: TouchSelectionGeometry;
}

export interface ChatThreadTranslationResult {
  readonly text: string;
  readonly targetLanguage: ChatTranslationLanguage;
}

interface CapturedFeedbackSelection {
  readonly text: string;
  readonly rect: ChatThreadFeedbackSelection["rect"];
  readonly scrollReferenceRect: ChatThreadFeedbackSelection["rect"];
  readonly threadId: string | null;
  readonly runId: string | null;
  readonly eventId?: string;
  readonly range?: FeedbackRange;
  readonly source?: FeedbackSource;
  readonly touchRange?: Range;
  readonly touch?: TouchSelectionGeometry;
}

function isSameFeedbackRange(
  current: FeedbackRange | undefined,
  next: FeedbackRange | undefined,
): boolean {
  return current?.start === next?.start && current?.end === next?.end;
}

function isSameFeedbackSource(
  current: FeedbackSource | undefined,
  next: FeedbackSource | undefined,
): boolean {
  return (
    current?.type === next?.type &&
    current?.id === next?.id &&
    current?.status === next?.status &&
    current?.sentId === next?.sentId
  );
}

function isSameFeedbackSelection(
  current: CapturedFeedbackSelection,
  next: CapturedFeedbackSelection,
): boolean {
  return (
    current.text === next.text &&
    current.threadId === next.threadId &&
    current.runId === next.runId &&
    current.eventId === next.eventId &&
    isSameFeedbackRange(current.range, next.range) &&
    isSameFeedbackSource(current.source, next.source)
  );
}

export interface ChatThreadFeedbackSignals {
  readonly selection$: Computed<ChatThreadFeedbackSelection | null>;
  readonly start$: Command<void, []>;
  readonly close$: Command<void, []>;
  readonly copy$: Command<Promise<void>, [AbortSignal]>;
  readonly translationLanguage$: Computed<Promise<ChatTranslationLanguage>>;
  readonly translationPromise$: Computed<Promise<void> | null>;
  readonly translationResult$: Computed<ChatThreadTranslationResult | null>;
  readonly setTranslationLanguage$: Command<
    Promise<void>,
    [ChatTranslationLanguage, AbortSignal]
  >;
  readonly translate$: Command<Promise<void>, [AbortSignal]>;
  readonly copyTranslation$: Command<Promise<void>, [AbortSignal]>;
  readonly forwardSelection$: Computed<ChatForwardSelection | null>;
  readonly forwardTarget$: Computed<ChatForwardTarget | null>;
  readonly prepareForwardComposer$: ReturnType<
    typeof createForwardState
  >["prepareForwardComposer$"];
  readonly resetForwardTarget$: Command<void, []>;
  readonly startForward$: Command<boolean, []>;
  readonly closeForward$: Command<void, []>;
  readonly setListenersRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly setToolbarRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly setTouchListenersRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly setTouchOverlayRef$: Command<
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
  if (startSource && !endSource && range.endOffset === 0) {
    // Chromium can end a whole-paragraph selection at offset 0 in the
    // following action-area sibling. Accept only that trailing boundary in
    // the same assistant group as the selected content.
    const endElement =
      range.endContainer instanceof Element
        ? range.endContainer
        : range.endContainer.parentElement;
    const startGroup = startSource.closest(ASSISTANT_GROUP_SELECTOR);
    const endGroup = endElement?.closest(ASSISTANT_GROUP_SELECTOR);
    if (startGroup !== null && startGroup === endGroup) {
      return startSource;
    }
  }
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

function resolveSelectionRunId(source: Element): string | null {
  const runGroup = source.closest(RUN_GROUP_SELECTOR);
  if (!(runGroup instanceof HTMLElement)) {
    return null;
  }
  return runGroup.dataset.chatRunId ?? null;
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

function closestChatEvent(node: Node): HTMLElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  const event = element?.closest(CHAT_EVENT_SELECTOR);
  return event instanceof HTMLElement ? event : null;
}

function resolveFeedbackLocation(
  range: Range,
): { readonly eventId: string; readonly range: FeedbackRange } | undefined {
  const startEvent = closestChatEvent(range.startContainer);
  const endEvent = closestChatEvent(range.endContainer);
  if (!startEvent || startEvent !== endEvent) {
    return undefined;
  }
  const eventId = startEvent.dataset.chatScrollAnchorEventId;
  if (!eventId) {
    return undefined;
  }

  const prefixRange = startEvent.ownerDocument.createRange();
  prefixRange.selectNodeContents(startEvent);
  prefixRange.setEnd(range.startContainer, range.startOffset);
  const prefixLength = prefixRange.toString().length;
  const selectedText = range.toString();
  const leadingWhitespace =
    selectedText.length - selectedText.trimStart().length;
  const trailingWhitespace =
    selectedText.length - selectedText.trimEnd().length;
  const start = prefixLength + leadingWhitespace;
  const end = prefixLength + selectedText.length - trailingWhitespace;
  if (end <= start) {
    return undefined;
  }
  return { eventId, range: { start, end } };
}

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

function readFeedbackSelection(
  touchRange?: Range,
): CapturedFeedbackSelection | null {
  const selection = window.getSelection();
  const range =
    touchRange ??
    (selection && !selection.isCollapsed && selection.rangeCount > 0
      ? selection.getRangeAt(0)
      : null);
  if (
    !range ||
    !range.startContainer.isConnected ||
    !range.endContainer.isConnected
  ) {
    return null;
  }
  const text = touchRange
    ? touchSelectionText(touchRange)
    : selection?.toString().trim();
  if (!text) {
    return null;
  }
  const sourceElement = resolveSelectionSource(range);
  if (!sourceElement) {
    return null;
  }
  const source = resolveFeedbackSource(sourceElement);
  const location = resolveFeedbackLocation(range);
  const rect = rectFromRange(range);
  return {
    text,
    rect,
    scrollReferenceRect: rect,
    threadId: resolveSelectionThreadId(sourceElement),
    runId: resolveSelectionRunId(sourceElement),
    ...location,
    ...(source ? { source } : {}),
    ...(touchRange
      ? { touchRange, touch: measureTouchSelection(touchRange) }
      : {}),
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

function isSelectionInteractionTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(SELECTION_INTERACTION_SELECTOR) !== null
  );
}

function createSelectionReconciliation({
  threadId,
  internalSelection$,
  close$,
}: {
  readonly threadId: string;
  readonly internalSelection$: State<CapturedFeedbackSelection | null>;
  readonly close$: Command<void, []>;
}) {
  const reconcile$ = command(({ get, set }, reason: "scroll" | "layout") => {
    const currentSelection = get(internalSelection$);
    if (!currentSelection) {
      return;
    }
    const selection = readFeedbackSelection(currentSelection.touchRange);
    if (
      !selection ||
      selection.threadId !== threadId ||
      !isSameFeedbackSelection(currentSelection, selection)
    ) {
      set(close$);
      return;
    }
    const horizontalDisplacement =
      selection.rect.left - currentSelection.scrollReferenceRect.left;
    const verticalDisplacement =
      selection.rect.top - currentSelection.scrollReferenceRect.top;
    if (
      reason === "scroll" &&
      Math.hypot(horizontalDisplacement, verticalDisplacement) >
        SELECTION_SCROLL_DISMISS_DISTANCE_PX
    ) {
      set(close$);
      return;
    }
    if (
      selection.touch ||
      selection.rect.top !== currentSelection.rect.top ||
      selection.rect.left !== currentSelection.rect.left ||
      selection.rect.width !== currentSelection.rect.width ||
      selection.rect.height !== currentSelection.rect.height
    ) {
      set(internalSelection$, {
        ...currentSelection,
        rect: selection.rect,
        ...(reason === "layout" ? { scrollReferenceRect: selection.rect } : {}),
        ...(selection.touch ? { touch: selection.touch } : {}),
      });
    }
  });
  const reconcileAfterScroll$ = command(({ set }) => {
    set(reconcile$, "scroll");
  });
  const reconcileAfterLayout$ = command(({ set }) => {
    set(reconcile$, "layout");
  });
  return { reconcileAfterScroll$, reconcileAfterLayout$ };
}

function createSelectionState(threadId: string) {
  const internalSelection$ = state<CapturedFeedbackSelection | null>(null);
  const internalTranslationPromise$ = state<Promise<void> | null>(null);
  const internalTranslationResult$ = state<ChatThreadTranslationResult | null>(
    null,
  );
  const resetToolbarSignal$ = resetSignal();
  const resetTranslationSignal$ = resetSignal();
  const selection$ = computed((get): ChatThreadFeedbackSelection | null => {
    const selection = get(internalSelection$);
    return selection
      ? {
          rect: selection.rect,
          text: selection.text,
          threadId: selection.threadId,
          runId: selection.runId,
          ...(selection.eventId !== undefined && selection.range !== undefined
            ? { eventId: selection.eventId, range: selection.range }
            : {}),
          ...(selection.source ? { source: selection.source } : {}),
          ...(selection.touch ? { touch: selection.touch } : {}),
        }
      : null;
  });
  const close$ = command(({ set }) => {
    set(resetToolbarSignal$);
    set(resetTranslationSignal$);
    set(internalSelection$, null);
    set(internalTranslationPromise$, null);
    set(internalTranslationResult$, null);
  });
  const touchRange$ = computed((get) => {
    return get(internalSelection$)?.touchRange ?? null;
  });
  const capture$ = command(({ get, set }, touchRange?: Range) => {
    const selection = readFeedbackSelection(touchRange);
    if (!selection || selection.threadId !== threadId) {
      set(close$);
      return;
    }
    const currentSelection = get(internalSelection$);
    if (
      currentSelection &&
      isSameFeedbackSelection(currentSelection, selection)
    ) {
      return;
    }
    set(resetTranslationSignal$);
    set(internalTranslationPromise$, null);
    set(internalTranslationResult$, null);
    set(internalSelection$, selection);
  });
  const { reconcileAfterScroll$, reconcileAfterLayout$ } =
    createSelectionReconciliation({ threadId, internalSelection$, close$ });
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
  const setTouchOverlayRef$ = createTouchSelectionOverlayRef({
    range$: touchRange$,
    reconcile$: reconcileAfterLayout$,
  });
  return {
    internalSelection$,
    internalTranslationPromise$,
    internalTranslationResult$,
    resetToolbarSignal$,
    resetTranslationSignal$,
    selection$,
    close$,
    capture$,
    touchRange$,
    setTouchOverlayRef$,
    reconcileAfterScroll$,
    copy$,
  };
}

function createTranslationState({
  selection$,
  promise$,
  result$,
  resetTranslationSignal$,
}: {
  selection$: State<CapturedFeedbackSelection | null>;
  promise$: State<Promise<void> | null>;
  result$: State<ChatThreadTranslationResult | null>;
  resetTranslationSignal$: ReturnType<typeof resetSignal>;
}) {
  const internalLanguage$ = state<ChatTranslationLanguage | null>(null);
  const translationLanguage$ = computed(
    async (get): Promise<ChatTranslationLanguage> => {
      return (
        get(internalLanguage$) ?? (await get(savedChatTranslationLanguage$))
      );
    },
  );
  const translationResult$ = computed((get) => {
    return get(result$);
  });
  const translationPromise$ = computed((get) => {
    return get(promise$);
  });
  const setTranslationLanguage$ = command(
    async (
      { set },
      language: ChatTranslationLanguage,
      signal: AbortSignal,
    ): Promise<void> => {
      set(resetTranslationSignal$);
      set(internalLanguage$, language);
      await set(persistChatTranslationLanguage$, language, signal);
      signal.throwIfAborted();
    },
  );
  const performTranslation$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const selection = get(selection$);
      if (!selection) {
        return;
      }
      const requestSignal = set(resetTranslationSignal$, signal);
      const targetLanguage = await get(translationLanguage$);
      signal.throwIfAborted();
      requestSignal.throwIfAborted();
      const response = await set(
        requestChatTranslation$,
        selection.text,
        targetLanguage,
        requestSignal,
      );
      signal.throwIfAborted();
      requestSignal.throwIfAborted();
      const currentSelection = get(selection$);
      if (
        !currentSelection ||
        !isSameFeedbackSelection(currentSelection, selection)
      ) {
        return;
      }
      set(result$, { text: response.text, targetLanguage });
    },
  );
  const translate$ = command(({ set }, signal: AbortSignal): Promise<void> => {
    const promise = set(performTranslation$, signal);
    set(promise$, promise);
    return promise;
  });
  const copyTranslation$ = command(
    async ({ get }, signal: AbortSignal): Promise<void> => {
      const result = get(result$);
      if (!result) {
        return;
      }
      signal.throwIfAborted();
      const copied = await writeToClipboard(result.text);
      signal.throwIfAborted();
      if (copied) {
        toast.success(
          i18n.t(($) => {
            return $.chat.toasts.copied;
          }),
        );
      }
    },
  );
  return {
    translationLanguage$,
    translationPromise$,
    translationResult$,
    setTranslationLanguage$,
    translate$,
    copyTranslation$,
  };
}

function createStartFeedback(
  selection$: State<CapturedFeedbackSelection | null>,
  close$: Command<void, []>,
  feedback: ComposerFeedbackSignals,
) {
  return command(({ get, set }) => {
    const selection = get(selection$);
    if (!selection) {
      return;
    }
    set(feedback.add$, {
      quote: selection.text,
      ...(selection.eventId !== undefined && selection.range !== undefined
        ? { eventId: selection.eventId, range: selection.range }
        : {}),
      ...(selection.source ? { source: selection.source } : {}),
    });
    set(close$);
  });
}

function createForwardState(closeSelection$: Command<void, []>) {
  const internalForwardSelection$ = state<ChatForwardSelection | null>(null);
  const target$ = state<ChatForwardTarget | null>(null);
  const resetTarget$ = resetSignal();
  const forwardSelection$ = computed((get) => {
    return get(internalForwardSelection$);
  });
  const forwardTarget$ = computed((get) => {
    return get(target$);
  });
  const resetForwardTarget$ = command(({ set }) => {
    set(resetTarget$);
    set(target$, null);
  });
  const prepareForwardComposer$ = command(
    async (
      { set },
      prepare$: typeof prepareChatForwardComposer$,
      request: {
        readonly target: ChatForwardTarget;
        readonly forward: ChatForwardContext;
        readonly onOptimisticSend: () => void;
      },
      parentSignal: AbortSignal,
    ) => {
      const signal = set(resetTarget$, parentSignal);
      set(target$, request.target);
      return await set(
        prepare$,
        request.target,
        request.forward,
        request.onOptimisticSend,
        signal,
      );
    },
  );
  const openForward$ = command(
    ({ set }, selection: ChatForwardSelection): void => {
      set(setChatListQuery$, "");
      set(internalForwardSelection$, selection);
      set(resetForwardTarget$);
      set(closeSelection$);
    },
  );
  const closeForward$ = command(({ set }): void => {
    set(setChatListQuery$, "");
    set(internalForwardSelection$, null);
    set(resetForwardTarget$);
  });
  return {
    forwardSelection$,
    forwardTarget$,
    prepareForwardComposer$,
    resetForwardTarget$,
    openForward$,
    closeForward$,
  };
}

function createStartForward(
  selection$: State<CapturedFeedbackSelection | null>,
  openForward$: Command<void, [ChatForwardSelection]>,
) {
  return command(({ get, set }): boolean => {
    const selection = get(selection$);
    if (!selection?.threadId || !selection.runId) {
      return false;
    }
    set(openForward$, {
      quote: selection.text,
      threadId: selection.threadId,
      runId: selection.runId,
      ...(selection.eventId !== undefined && selection.range !== undefined
        ? { eventId: selection.eventId, range: selection.range }
        : {}),
      ...(selection.source ? { source: selection.source } : {}),
    });
    return true;
  });
}

function createToolbarRef({
  resetToolbarSignal$,
  touchRange$,
  close$,
  copy$,
  start$,
  startForward$,
  translate$,
}: {
  resetToolbarSignal$: ReturnType<typeof resetSignal>;
  touchRange$: Computed<Range | null>;
  close$: Command<void, []>;
  copy$: Command<Promise<void>, [AbortSignal]>;
  start$: Command<void, []>;
  startForward$: Command<boolean, []>;
  translate$: Command<Promise<void>, [AbortSignal]>;
}) {
  return onRef(
    command(({ get, set }, el: HTMLElement, signal: AbortSignal) => {
      const toolbarSignal = set(resetToolbarSignal$, signal);
      el.ownerDocument.addEventListener(
        "keydown",
        onDomEventFn(async (event: KeyboardEvent) => {
          if (toolbarSignal.aborted) {
            return;
          }
          if (matchShortcut("mod+c", event)) {
            if (get(touchRange$) && !isEditableTarget(event.target)) {
              event.preventDefault();
              await set(copy$, signal);
              return;
            }
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
          if (matchShortcut("q", event)) {
            event.preventDefault();
            set(start$);
            return;
          }
          if (matchShortcut("f", event) && set(startForward$)) {
            event.preventDefault();
            return;
          }
          if (
            get(featureSwitch$)[FeatureSwitchKey.ChatTranslation] &&
            matchShortcut("t", event)
          ) {
            event.preventDefault();
            await set(translate$, signal);
          }
        }),
        { signal: toolbarSignal },
      );
    }),
  );
}

function createListenersRef({
  selection$,
  close$,
  capture$,
  reconcileAfterScroll$,
  isProgrammaticScrollEvent$,
}: {
  selection$: State<CapturedFeedbackSelection | null>;
  close$: Command<void, []>;
  capture$: Command<void, []>;
  reconcileAfterScroll$: Command<void, []>;
  isProgrammaticScrollEvent$: Command<boolean, [EventTarget | null]>;
}) {
  const deferredCaptureSignal$ = resetSignal();
  return onRef(
    command(({ get, set }, el: HTMLElement, signal: AbortSignal) => {
      const doc = el.ownerDocument;
      let mouseSelectionInProgress = false;
      let selectionInteractionInProgress = false;
      let scrollReconciliationScheduled = false;
      const captureDeferred = async () => {
        await delay(0, { signal: set(deferredCaptureSignal$, signal) });
        if (!get(selection$)?.touchRange) {
          set(capture$);
        }
      };
      doc.addEventListener(
        "pointerdown",
        (event) => {
          selectionInteractionInProgress = isSelectionInteractionTarget(
            event.target,
          );
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
        "pointerup",
        onDomEventFn(async () => {
          if (!selectionInteractionInProgress) {
            return;
          }
          await delay(0, { signal });
          selectionInteractionInProgress = false;
        }),
        { capture: true, signal },
      );
      doc.addEventListener(
        "pointercancel",
        () => {
          selectionInteractionInProgress = false;
        },
        { capture: true, signal },
      );
      doc.addEventListener(
        "mousedown",
        (event) => {
          if (get(selection$)?.touchRange) {
            return;
          }
          mouseSelectionInProgress =
            event.button === 0 &&
            event.target instanceof Node &&
            closestFeedbackSource(event.target) !== null;
          const activeElement = doc.activeElement;
          if (
            mouseSelectionInProgress &&
            activeElement instanceof HTMLElement &&
            activeElement.closest(CHAT_COMPOSER_SELECTOR) !== null
          ) {
            activeElement.blur();
          }
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
          if (!mouseSelectionInProgress && !selectionInteractionInProgress) {
            await captureDeferred();
          }
        }),
        { signal },
      );
      doc.addEventListener(
        "scroll",
        (event) => {
          if (
            get(selection$) === null ||
            isSelectionInteractionTarget(event.target) ||
            set(isProgrammaticScrollEvent$, event.target)
          ) {
            return;
          }
          if (scrollReconciliationScheduled) {
            return;
          }
          scrollReconciliationScheduled = true;
          // Browser scroll events can precede the ResizeObserver pass that
          // restores the selected text's viewport position.
          animationFrame(
            () => {
              scrollReconciliationScheduled = false;
              set(reconcileAfterScroll$);
            },
            { signal },
          );
        },
        { capture: true, passive: true, signal },
      );
    }),
  );
}

export function createChatThreadFeedbackSignals(
  threadId: string,
  feedback: ComposerFeedbackSignals,
  isProgrammaticScrollEvent$: Command<boolean, [EventTarget | null]>,
): ChatThreadFeedbackSignals {
  const selection = createSelectionState(threadId);
  const translation = createTranslationState({
    selection$: selection.internalSelection$,
    promise$: selection.internalTranslationPromise$,
    result$: selection.internalTranslationResult$,
    resetTranslationSignal$: selection.resetTranslationSignal$,
  });
  const forward = createForwardState(selection.close$);
  const start$ = createStartFeedback(
    selection.internalSelection$,
    selection.close$,
    feedback,
  );
  const startForward$ = createStartForward(
    selection.internalSelection$,
    forward.openForward$,
  );
  const setToolbarRef$ = createToolbarRef({
    resetToolbarSignal$: selection.resetToolbarSignal$,
    touchRange$: selection.touchRange$,
    close$: selection.close$,
    copy$: selection.copy$,
    start$,
    startForward$,
    translate$: translation.translate$,
  });
  const setListenersRef$ = createListenersRef({
    selection$: selection.internalSelection$,
    close$: selection.close$,
    capture$: selection.capture$,
    reconcileAfterScroll$: selection.reconcileAfterScroll$,
    isProgrammaticScrollEvent$,
  });
  const setTouchListenersRef$ = createTouchSelectionListeners({
    threadId,
    range$: selection.touchRange$,
    capture$: selection.capture$,
    close$: selection.close$,
  });
  return {
    selection$: selection.selection$,
    setTouchListenersRef$,
    setTouchOverlayRef$: selection.setTouchOverlayRef$,
    start$,
    close$: selection.close$,
    copy$: selection.copy$,
    translationLanguage$: translation.translationLanguage$,
    translationPromise$: translation.translationPromise$,
    translationResult$: translation.translationResult$,
    setTranslationLanguage$: translation.setTranslationLanguage$,
    translate$: translation.translate$,
    copyTranslation$: translation.copyTranslation$,
    forwardSelection$: forward.forwardSelection$,
    forwardTarget$: forward.forwardTarget$,
    prepareForwardComposer$: forward.prepareForwardComposer$,
    resetForwardTarget$: forward.resetForwardTarget$,
    startForward$,
    closeForward$: forward.closeForward$,
    setListenersRef$,
    setToolbarRef$,
  };
}
