import { command, computed, state } from "ccstate";

import { localStorageSignals } from "../external/local-storage.ts";
import { resetSignal } from "../utils.ts";

// Smallest the sidebar may shrink to before its content stops being usable.
export const CHAT_THREAD_SIDEBAR_MIN_WIDTH = 400;
// Width the chat thread keeps so its composer never collapses.
export const CHAT_THREAD_SIDEBAR_MIN_THREAD_WIDTH = 600;

// Keep the existing storage key so previously saved artifact panel widths
// continue to apply to the unified chat thread sidebar.
const {
  get$: chatThreadSidebarWidthRaw$,
  set$: setChatThreadSidebarWidthRaw$,
} = localStorageSignals("artifactPanelWidth");

export const chatThreadSidebarWidth$ = computed<number | null>((get) => {
  const raw = get(chatThreadSidebarWidthRaw$);
  if (raw === null) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
});

const setChatThreadSidebarWidth$ = command(({ set }, width: number) => {
  set(setChatThreadSidebarWidthRaw$, String(Math.round(width)));
});

const internalChatThreadSidebarResizing$ = state(false);
export const chatThreadSidebarResizing$ = computed((get) => {
  return get(internalChatThreadSidebarResizing$);
});

const resetChatThreadSidebarResize$ = resetSignal();

const chatThreadSidebarDragMaskEl$ = computed(() => {
  const element = document.createElement("div");
  element.dataset.chatThreadSidebarResizeMask = "";
  element.setAttribute("aria-hidden", "true");
  Object.assign(element.style, {
    background: "transparent",
    cursor: "col-resize",
    inset: "0",
    position: "fixed",
    touchAction: "none",
    userSelect: "none",
    zIndex: "2147483647",
  });
  return element;
});

export const startChatThreadSidebarResize$ = command(
  ({ get, set }, container: HTMLElement, pageSignal: AbortSignal): void => {
    pageSignal.throwIfAborted();

    const rect = container.getBoundingClientRect();
    const maxWidth = Math.max(
      CHAT_THREAD_SIDEBAR_MIN_WIDTH,
      rect.width - CHAT_THREAD_SIDEBAR_MIN_THREAD_WIDTH,
    );
    const dragSignal = set(resetChatThreadSidebarResize$, pageSignal);
    const dragMaskEl = get(chatThreadSidebarDragMaskEl$);

    function resetResize(): void {
      set(resetChatThreadSidebarResize$);
    }

    dragMaskEl.addEventListener(
      "pointermove",
      (event) => {
        const nextWidth = Math.min(
          Math.max(rect.right - event.clientX, CHAT_THREAD_SIDEBAR_MIN_WIDTH),
          maxWidth,
        );
        set(setChatThreadSidebarWidth$, nextWidth);
      },
      { signal: dragSignal },
    );
    dragMaskEl.addEventListener("pointerup", resetResize, {
      signal: dragSignal,
    });
    dragMaskEl.addEventListener("pointercancel", resetResize, {
      signal: dragSignal,
    });
    window.addEventListener("blur", resetResize, { signal: dragSignal });

    dragSignal.addEventListener(
      "abort",
      () => {
        dragMaskEl.remove();
        set(internalChatThreadSidebarResizing$, false);
      },
      { once: true },
    );

    document.body.append(dragMaskEl);
    set(internalChatThreadSidebarResizing$, true);
  },
);
