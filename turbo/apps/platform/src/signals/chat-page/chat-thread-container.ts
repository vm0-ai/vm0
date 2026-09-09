import { command, computed, state, type Command, type Computed } from "ccstate";
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

export function createChatThreadContainerSignals(
  attachActivitySummary$: Computed<
    Command<Promise<void>, [HTMLElement, AbortSignal]>
  >,
  pageSignal: AbortSignal,
) {
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
  const mainContainerRef$ = computed((get) => {
    const attachActivity$ = get(attachActivitySummary$);
    return onRef(
      command(async ({ set }, el: HTMLElement, mountSignal: AbortSignal) => {
        const signal = AbortSignal.any([mountSignal, pageSignal]);
        signal.throwIfAborted();
        set(attachContainer$, el, signal);
        set(attachMainThreadFocusFallback$, el, signal);
        await set(attachActivity$, el, signal);
      }),
    );
  });
  return { containerEl$, setContainerRef$, mainContainerRef$ };
}
