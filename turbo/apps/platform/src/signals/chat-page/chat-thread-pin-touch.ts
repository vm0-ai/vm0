import { command, state, type Command } from "ccstate";
import { timeout } from "signal-timers";
import { createChildAbortController, createDeferredPromise } from "../utils.ts";
import type { PinnedThreadDragSignals } from "./chat-thread-pin-order.ts";

const LONG_PRESS_MS = 300;
const SCROLL_TOLERANCE_PX = 10;

type TouchDragActions = Pick<
  PinnedThreadDragSignals,
  "drag$" | "start$" | "drop$"
> & {
  cancel$: Command<void, []>;
  move$: Command<boolean, [HTMLElement, number, number]>;
};

export function createPinnedThreadTouchDrag(actions: TouchDragActions) {
  const session$ = state<{
    threadId: string;
    controller: AbortController;
  } | null>(null);
  const cancelRow$ = command(({ get }, threadId: string) => {
    const session = get(session$);
    if (session?.threadId === threadId) {
      session.controller.abort();
    }
  });
  const startTouch$ = command(
    async (
      { get, set },
      row: HTMLElement,
      event: TouchEvent,
      signal: AbortSignal,
    ) => {
      get(session$)?.controller.abort();
      const touch = event.touches[0];
      const threadId = row.dataset.threadId;
      const link = row.querySelector("a[data-sidebar-chat-thread-id]");
      if (
        event.touches.length !== 1 ||
        !touch ||
        !threadId ||
        !(event.target instanceof Node) ||
        !link?.contains(event.target)
      ) {
        return;
      }

      signal.throwIfAborted();
      const controller = createChildAbortController(signal);
      const session = { threadId, controller };
      const options = { signal: controller.signal };
      const finished = createDeferredPromise<boolean>(controller.signal);
      const document = row.ownerDocument;
      let activated = false;
      set(session$, session);
      controller.signal.addEventListener(
        "abort",
        () => {
          if (get(session$) === session) {
            set(session$, null);
            if (activated) {
              set(actions.cancel$);
            }
          }
        },
        { once: true },
      );

      timeout(
        () => {
          const bounds = row.getBoundingClientRect();
          set(actions.start$, threadId, {
            x: touch.clientX,
            y: touch.clientY,
            width: bounds.width,
            offsetX: bounds.left - touch.clientX,
            offsetY: bounds.top - touch.clientY - 6,
          });
          activated = get(actions.drag$)?.threadId === threadId;
        },
        LONG_PRESS_MS,
        options,
      );

      document.addEventListener(
        "touchmove",
        (moveEvent) => {
          const position = Array.from(moveEvent.touches).find((item) => {
            return item.identifier === touch.identifier;
          });
          if (!position || moveEvent.touches.length !== 1) {
            controller.abort();
            return;
          }
          if (activated) {
            moveEvent.preventDefault();
            set(actions.move$, row, position.clientX, position.clientY);
          } else if (
            Math.hypot(
              position.clientX - touch.clientX,
              position.clientY - touch.clientY,
            ) > SCROLL_TOLERANCE_PX
          ) {
            // Leave the browser in charge of a swipe that starts before pickup.
            controller.abort();
          }
        },
        { ...options, passive: false },
      );
      document.addEventListener(
        "touchend",
        (endEvent) => {
          const position = Array.from(endEvent.changedTouches).find((item) => {
            return item.identifier === touch.identifier;
          });
          if (!position) {
            return;
          }
          if (activated) {
            // Suppress the compatibility click that would open the conversation.
            endEvent.preventDefault();
          }
          finished.resolve(
            activated &&
              set(actions.move$, row, position.clientX, position.clientY),
          );
        },
        { ...options, passive: false },
      );
      bindTouchCancellation(
        row,
        () => {
          controller.abort();
        },
        controller.signal,
      );

      const shouldDrop = await finished.promise;
      signal.throwIfAborted();
      controller.signal.throwIfAborted();
      const dropping = shouldDrop
        ? set(actions.drop$, signal)
        : Promise.resolve();
      controller.abort();
      await dropping;
    },
  );
  return { startTouch$, cancelRow$ };
}

function bindTouchCancellation(
  row: HTMLElement,
  cancel: () => void,
  signal: AbortSignal,
) {
  const document = row.ownerDocument;
  const options = { signal };
  document.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length > 1) {
        cancel();
      }
    },
    options,
  );
  document.addEventListener("touchcancel", cancel, options);
  document.addEventListener("scroll", cancel, { ...options, capture: true });
  document.defaultView?.addEventListener("blur", cancel, options);
  for (const type of ["contextmenu", "dragstart"] as const) {
    row.addEventListener(
      type,
      (event) => {
        event.preventDefault();
      },
      { ...options, capture: true },
    );
  }
}
