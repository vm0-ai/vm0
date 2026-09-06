import { command, type Command, type Computed } from "ccstate";
import { isEditableTarget } from "@okouai/ui";
import { timeout } from "signal-timers";
import { i18n } from "../../i18n/index.ts";
import { onRef, resetSignal } from "../utils.ts";

// Assistant messages and other agent-produced content, such as linked email
// drafts, opt into the shared Copy / Quote interaction.
export const FEEDBACK_SOURCE_SELECTOR =
  ".okou-chat-bubble-assistant, [data-feedback-source]";
const THREAD_SELECTOR = "[data-chat-thread-container-id]";
const INTERACTIVE_SELECTOR =
  'a, button, input, textarea, select, [role="button"], [contenteditable]:not([contenteditable="false"])';
const LONG_PRESS_MS = 450;
const SCROLL_SLOP_PX = 10;

interface Point {
  readonly x: number;
  readonly y: number;
}

interface SelectionRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface TouchSelectionGeometry {
  readonly rects: readonly SelectionRect[];
  readonly start: SelectionRect;
  readonly end: SelectionRect;
}

function selectionRect(rect: DOMRectReadOnly): SelectionRect {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

export function measureTouchSelection(range: Range): TouchSelectionGeometry {
  const start = range.cloneRange();
  start.collapse(true);
  const end = range.cloneRange();
  end.collapse(false);
  return {
    rects: Array.from(range.getClientRects(), selectionRect),
    start: selectionRect(start.getBoundingClientRect()),
    end: selectionRect(end.getBoundingClientRect()),
  };
}

export function touchSelectionText(range: Range): string {
  // Range.toString() joins adjacent paragraphs. Serialize the detached fragment
  // so Copy / Quote retain block boundaries without creating a native Selection.
  const fragment = range.cloneContents();
  for (const br of fragment.querySelectorAll("br")) {
    br.replaceWith("\n");
  }
  for (const cell of fragment.querySelectorAll("td, th")) {
    cell.append("\t");
  }
  const blocks = fragment.querySelectorAll(
    "p, div, pre, li, blockquote, h1, h2, h3, h4, h5, h6, tr",
  );
  for (const block of Array.from(blocks).reverse()) {
    // Markdown emits whitespace between blocks. Replace that layout whitespace
    // and reuse nested block breaks without collapsing blank lines inside code.
    const next = block.nextSibling;
    if (next instanceof Text && !next.data.trim()) {
      next.remove();
    }
    if (!block.textContent.endsWith("\n")) {
      block.append("\n");
    }
    if (
      block.matches("p, h1, h2, h3, h4, h5, h6") &&
      !block.textContent.endsWith("\n\n")
    ) {
      block.append("\n");
    }
  }
  return fragment.textContent.trim();
}

function caretAtPoint(doc: Document, point: Point): Range | null {
  // The current Safari/iOS 16.4 build target needs the WebKit API. Keep this
  // branch until the browser target guarantees caretPositionFromPoint.
  if (typeof doc.caretPositionFromPoint !== "function") {
    return doc.caretRangeFromPoint(point.x, point.y);
  }
  const caret = doc.caretPositionFromPoint(point.x, point.y);
  if (!caret) {
    return null;
  }
  const range = doc.createRange();
  range.setStart(caret.offsetNode, caret.offset);
  range.collapse(true);
  return range;
}

function segmentAtOffset(text: string, offset: number) {
  if (typeof Intl.Segmenter === "function") {
    return new Intl.Segmenter(i18n.language, { granularity: "word" })
      .segment(text)
      .containing(offset);
  }
  // Firefox in the current build target predates Intl.Segmenter. A complete
  // Unicode character remains adjustable with the same selection handles.
  let index = 0;
  for (const segment of text) {
    if (index + segment.length > offset) {
      return { index, segment };
    }
    index += segment.length;
  }
  return undefined;
}

function wordAtPoint(
  doc: Document,
  point: Point,
  source: Element,
): Range | null {
  const caret = caretAtPoint(doc, point);
  if (!caret || !source.contains(caret.startContainer)) {
    return null;
  }
  const node = caret.startContainer;
  if (!(node instanceof Text) || node.data.length === 0) {
    return null;
  }
  const word = segmentAtOffset(
    node.data,
    Math.min(caret.startOffset, node.data.length - 1),
  );
  if (!word?.segment.trim()) {
    return null;
  }
  caret.setStart(node, word.index);
  caret.setEnd(node, word.index + word.segment.length);
  return caret;
}

function extendRange(base: Range, caret: Range, edge: "start" | "end"): Range {
  const anchor = base.cloneRange();
  anchor.collapse(edge === "end");
  const range = base.cloneRange();
  if (caret.compareBoundaryPoints(Range.START_TO_START, anchor) < 0) {
    range.setStart(caret.startContainer, caret.startOffset);
    range.setEnd(anchor.startContainer, anchor.startOffset);
  } else {
    range.setStart(anchor.startContainer, anchor.startOffset);
    range.setEnd(caret.startContainer, caret.startOffset);
  }
  return range;
}

interface TouchGesture {
  readonly pointerId: number;
  readonly source: Element;
  readonly origin: Point;
  readonly adjustment: Point;
  readonly edge: "start" | "end";
  range: Range | null;
}

interface TouchSelectionCommands {
  readonly threadId: string;
  readonly range$: Computed<Range | null>;
  readonly capture$: Command<void, [Range]>;
  readonly close$: Command<void, []>;
}

interface TouchSession {
  gesture: TouchGesture | null;
  suppressClick: boolean;
  readonly ownedContainers: Set<HTMLElement>;
}

function handleGesture(
  event: PointerEvent,
  range: Range | null,
  threadId: string,
): TouchGesture | null {
  const handle =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-chat-selection-handle]")
      : null;
  const edge = handle?.dataset.chatSelectionHandle;
  if (
    event.pointerType !== "touch" ||
    handle?.dataset.chatSelectionThread !== threadId ||
    !range ||
    (edge !== "start" && edge !== "end")
  ) {
    return null;
  }
  const source = range.startContainer.parentElement?.closest(
    FEEDBACK_SOURCE_SELECTOR,
  );
  if (!source) {
    return null;
  }
  const endpoint = measureTouchSelection(range)[edge];
  return {
    pointerId: event.pointerId,
    source,
    origin: { x: event.clientX, y: event.clientY },
    adjustment: {
      x: endpoint.left - event.clientX,
      y: endpoint.top + endpoint.height / 2 - event.clientY,
    },
    edge,
    range,
  };
}

function createActivatePress(capture$: Command<void, [Range]>) {
  return command(({ set }, session: TouchSession, gesture: TouchGesture) => {
    const doc = gesture.source.ownerDocument;
    const range = wordAtPoint(doc, gesture.origin, gesture.source);
    if (!range || !gesture.source.isConnected) {
      return;
    }
    const activeElement = doc.activeElement;
    if (
      activeElement instanceof HTMLElement &&
      isEditableTarget(activeElement)
    ) {
      activeElement.blur();
    }
    doc.getSelection()?.removeAllRanges();
    gesture.range = range;
    session.suppressClick = true;
    set(capture$, range);
  });
}

function createStartPress(
  options: TouchSelectionCommands,
  resetPress$: ReturnType<typeof resetSignal>,
) {
  const activate$ = createActivatePress(options.capture$);
  return command(
    (
      { get, set },
      session: TouchSession,
      event: PointerEvent,
      signal: AbortSignal,
    ) => {
      set(resetPress$);
      session.suppressClick = false;
      if (
        session.gesture ||
        (event.pointerType === "touch" && !event.isPrimary)
      ) {
        session.gesture = null;
        if (get(options.range$)) {
          set(options.close$);
        }
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const selectedRange = get(options.range$);
      const handle = handleGesture(event, selectedRange, options.threadId);
      if (handle) {
        event.preventDefault();
        session.gesture = handle;
        return;
      }
      if (
        selectedRange &&
        !target.closest("[data-chat-selection-interaction]")
      ) {
        set(options.close$);
      }
      const source = target.closest(FEEDBACK_SOURCE_SELECTOR);
      const container = source?.closest<HTMLElement>(THREAD_SELECTOR);
      if (
        !source ||
        container?.dataset.chatThreadContainerId !== options.threadId
      ) {
        return;
      }
      // Switch before the browser's long-press recognizer runs. Actual pointer
      // input covers iPad desktop UA, PWA and hybrid devices without sniffing.
      container.dataset.chatSelectionMode = event.pointerType;
      session.ownedContainers.add(container);
      if (
        event.pointerType !== "touch" ||
        isEditableTarget(target) ||
        target.closest(INTERACTIVE_SELECTOR)
      ) {
        return;
      }
      const gesture: TouchGesture = {
        pointerId: event.pointerId,
        source,
        origin: { x: event.clientX, y: event.clientY },
        adjustment: { x: 0, y: 0 },
        edge: "end",
        range: null,
      };
      session.gesture = gesture;
      timeout(
        () => {
          set(activate$, session, gesture);
        },
        LONG_PRESS_MS,
        { signal: set(resetPress$, signal) },
      );
    },
  );
}

function createMovePress(
  capture$: Command<void, [Range]>,
  resetPress$: ReturnType<typeof resetSignal>,
) {
  return command(({ set }, session: TouchSession, event: PointerEvent) => {
    const gesture = session.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) {
      return;
    }
    if (!gesture.range) {
      if (
        Math.hypot(
          event.clientX - gesture.origin.x,
          event.clientY - gesture.origin.y,
        ) > SCROLL_SLOP_PX
      ) {
        set(resetPress$);
        session.gesture = null;
      }
      return;
    }
    const caret = caretAtPoint(gesture.source.ownerDocument, {
      x: event.clientX + gesture.adjustment.x,
      y: event.clientY + gesture.adjustment.y,
    });
    if (
      caret &&
      caret.startContainer instanceof Text &&
      gesture.source.contains(caret.startContainer)
    ) {
      const range = extendRange(gesture.range, caret, gesture.edge);
      if (!range.collapsed && range.toString().trim()) {
        set(capture$, range);
      }
    }
  });
}

function preventTouchContextMenu(event: MouseEvent, threadId: string): void {
  const target = event.target;
  if (!(target instanceof Element) || target.closest(INTERACTIVE_SELECTOR)) {
    return;
  }
  const container = target
    .closest(FEEDBACK_SOURCE_SELECTOR)
    ?.closest<HTMLElement>(THREAD_SELECTOR);
  if (
    container?.dataset.chatThreadContainerId === threadId &&
    container.dataset.chatSelectionMode === "touch"
  ) {
    event.preventDefault();
  }
}

export function createTouchSelectionListeners(options: TouchSelectionCommands) {
  const resetPress$ = resetSignal();
  const start$ = createStartPress(options, resetPress$);
  const move$ = createMovePress(options.capture$, resetPress$);
  return onRef(
    command(({ set }, el: HTMLElement, signal: AbortSignal) => {
      const doc = el.ownerDocument;
      const session: TouchSession = {
        gesture: null,
        suppressClick: false,
        ownedContainers: new Set(),
      };
      doc.addEventListener(
        "pointerdown",
        (event) => {
          set(start$, session, event, signal);
        },
        { capture: true, signal },
      );
      doc.addEventListener(
        "pointermove",
        (event) => {
          set(move$, session, event);
        },
        { capture: true, signal },
      );
      doc.addEventListener(
        "touchmove",
        (event) => {
          // Pending presses leave scrolling and multi-touch zoom with the browser.
          if (session.gesture?.range && event.touches.length === 1) {
            event.preventDefault();
          }
        },
        { capture: true, passive: false, signal },
      );
      doc.addEventListener(
        "pointerup",
        (event) => {
          if (session.gesture?.pointerId === event.pointerId) {
            set(resetPress$);
            session.gesture = null;
          }
        },
        { capture: true, signal },
      );
      doc.addEventListener(
        "pointercancel",
        () => {
          set(resetPress$);
          session.gesture = null;
        },
        { capture: true, signal },
      );
      doc.addEventListener(
        "click",
        (event) => {
          if (session.suppressClick && event.detail > 0) {
            // A synthetic release click can land on the newly mounted toolbar,
            // not just the pressed passage. The next pointerdown resets this guard.
            event.preventDefault();
            event.stopPropagation();
            session.suppressClick = false;
          }
        },
        { capture: true, signal },
      );
      doc.addEventListener(
        "contextmenu",
        (event) => {
          preventTouchContextMenu(event, options.threadId);
        },
        { capture: true, signal },
      );
      signal.addEventListener(
        "abort",
        () => {
          set(options.close$);
          for (const container of session.ownedContainers) {
            delete container.dataset.chatSelectionMode;
          }
        },
        { once: true },
      );
    }),
  );
}

export function createTouchSelectionOverlayRef({
  range$,
  reconcile$,
}: {
  readonly range$: Computed<Range | null>;
  readonly reconcile$: Command<void, []>;
}) {
  return onRef(
    command(({ get, set }, el: HTMLElement, signal: AbortSignal) => {
      const range = get(range$);
      const source = range?.startContainer.parentElement?.closest(
        FEEDBACK_SOURCE_SELECTOR,
      );
      if (!source) {
        return;
      }
      const mutationObserver = new MutationObserver(() => {
        set(reconcile$);
      });
      mutationObserver.observe(source, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      const resizeObserver = new ResizeObserver(() => {
        set(reconcile$);
      });
      resizeObserver.observe(source);
      el.ownerDocument.defaultView?.addEventListener(
        "resize",
        () => {
          // Keyboard dismissal changes the viewport after the long press. Move
          // the selection with its text instead of immediately discarding it.
          set(reconcile$);
        },
        { signal },
      );
      el.ownerDocument.defaultView?.visualViewport?.addEventListener(
        "resize",
        () => {
          set(reconcile$);
        },
        { signal },
      );
      signal.addEventListener(
        "abort",
        () => {
          mutationObserver.disconnect();
          resizeObserver.disconnect();
        },
        { once: true },
      );
    }),
  );
}
