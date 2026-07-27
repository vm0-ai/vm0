import { command, computed, state } from "ccstate";
import { onRef } from "../utils.ts";

function isDocumentScrollTarget(
  root: HTMLElement,
  target: EventTarget | null,
): boolean {
  const doc = root.ownerDocument;
  return (
    target === doc || target === doc.body || target === doc.documentElement
  );
}

function hasOpenDialog(doc: Document): boolean {
  return doc.querySelector('[role="dialog"]') !== null;
}

const attachMainThreadFocusFallback$ = command(
  (_, el: HTMLElement, signal: AbortSignal) => {
    const doc = el.ownerDocument;
    const win = doc.defaultView;

    const focusMainThreadIfDocumentFocused = (
      target: EventTarget | null = doc.activeElement,
    ) => {
      if (
        !el.isConnected ||
        hasOpenDialog(doc) ||
        !isDocumentScrollTarget(el, target)
      ) {
        return;
      }
      el.focus({ preventScroll: true });
    };

    queueMicrotask(() => {
      if (!signal.aborted) {
        focusMainThreadIfDocumentFocused();
      }
    });

    doc.addEventListener(
      "focusin",
      (event) => {
        focusMainThreadIfDocumentFocused(event.target);
      },
      { signal },
    );
    win?.addEventListener(
      "focus",
      () => {
        focusMainThreadIfDocumentFocused();
      },
      { signal },
    );
  },
);

export function createChatThreadContainerSignals() {
  const internalContainerEl$ = state<HTMLElement | null>(null);
  const containerEl$ = computed((get) => {
    return get(internalContainerEl$);
  });
  const attachContainer$ = command(
    ({ set }, el: HTMLElement, signal: AbortSignal) => {
      signal.addEventListener("abort", () => {
        set(internalContainerEl$, null);
      });
      set(internalContainerEl$, el);
    },
  );
  const setContainerRef$ = onRef(attachContainer$);
  const setMainContainerRef$ = onRef(
    command(({ set }, el: HTMLElement, signal: AbortSignal) => {
      set(attachContainer$, el, signal);
      set(attachMainThreadFocusFallback$, el, signal);
    }),
  );
  return { containerEl$, setContainerRef$, setMainContainerRef$ };
}
