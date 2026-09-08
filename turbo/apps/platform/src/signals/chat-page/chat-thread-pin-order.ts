import {
  command,
  computed,
  state,
  type Command,
  type State,
  type Computed,
} from "ccstate";
import { chatThreadPinOrderContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  comparePinnedThreads,
  moveChatThreadPinOrder,
} from "@okouai/core/chat-thread-pin-order";
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
  type ElementDropTargetEventBasePayload,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { disableNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/disable-native-drag-preview";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { stableChatThreadNavigationEnabled$ } from "../external/feature-switch.ts";
import { onRef } from "../utils.ts";
import { CHAT_THREAD_VIRTUAL_ROW_HEIGHT } from "../okou-page/sidebar-state.ts";
import { chatThreadOnlyUnread$ } from "./chat-thread-only-unread.ts";
import {
  eventDrivenChatThreads$,
  registerOptimisticChatThreadEvent$,
} from "./chat-thread-event-sourcing.ts";
import { registerPinnedThreadDragSession$ } from "./chat-thread-pin-drag-lifecycle.ts";
import { createPinnedThreadTouchDrag } from "./chat-thread-pin-touch.ts";

export const pinnedThreadReorderEnabled$ = computed((get) => {
  return get(stableChatThreadNavigationEnabled$) && !get(chatThreadOnlyUnread$);
});

interface PinMove {
  readonly threadId: string;
  readonly targetId: string;
  readonly side: "before" | "after";
}

const movePinnedThread$ = command(
  async ({ get, set }, move: PinMove, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!get(pinnedThreadReorderEnabled$)) {
      return;
    }
    const threads = get(eventDrivenChatThreads$);
    const thread = threads.find((item) => {
      return item.id === move.threadId;
    });
    if (!thread) {
      return;
    }
    const updates = moveChatThreadPinOrder(
      threads.filter((item) => {
        return item.agentId === thread.agentId;
      }),
      move.threadId,
      move.targetId,
      move.side,
    ).map((update) => {
      return { ...update, eventId: crypto.randomUUID() };
    });
    for (const update of updates) {
      set(registerOptimisticChatThreadEvent$, {
        id: update.eventId,
        kind: "sort_touched",
        chatThreadId: update.threadId,
        agentId: thread.agentId,
        pinOrder: update.pinOrder,
      });
    }
    const client = get(apiClient$)(chatThreadPinOrderContract);
    await Promise.all(
      updates.map((update) => {
        return accept(
          client.reorder({
            params: { id: update.threadId },
            body: { pinOrder: update.pinOrder, eventId: update.eventId },
            fetchOptions: { signal },
          }),
          [204],
        );
      }),
    );
    signal.throwIfAborted();
  },
);

export const stepPinnedThread$ = command(
  async (
    { get, set },
    threadId: string,
    direction: -1 | 1,
    signal: AbortSignal,
  ) => {
    const threads = get(eventDrivenChatThreads$);
    const thread = threads.find((item) => {
      return item.id === threadId;
    });
    if (!thread) {
      return;
    }
    const pins = threads
      .filter((item) => {
        return item.agentId === thread.agentId && item.pinnedAt !== null;
      })
      .sort(comparePinnedThreads);
    const index = pins.findIndex((item) => {
      return item.id === threadId;
    });
    const target = pins[index + direction];
    if (target) {
      await set(
        movePinnedThread$,
        {
          threadId,
          targetId: target.id,
          side: direction < 0 ? "before" : "after",
        },
        signal,
      );
    }
  },
);

interface PinDrag extends PinMove {
  readonly keyboard: boolean;
}

interface PinDragPointer {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

interface PinDragPreview extends PinDragPointer {
  readonly title: string | null;
}

interface PinDragAnnouncement {
  readonly side: PinMove["side"];
  readonly title: string;
}

interface PinDragPlacement {
  readonly sourceIndex: number;
  readonly destinationIndex: number;
}

export interface PinnedThreadDragSignals {
  readonly drag$: Computed<PinDrag | null>;
  readonly placement$: Computed<PinDragPlacement | null>;
  readonly preview$: Computed<PinDragPreview | null>;
  readonly announcement$: Computed<PinDragAnnouncement | null>;
  readonly mount$: Command<(() => void) | undefined, [HTMLElement | null]>;
  readonly mountRow$: Command<(() => void) | undefined, [HTMLElement | null]>;
  readonly mountDropZone$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly cancelKeyboard$: Command<boolean, [string]>;
  readonly start$: Command<void, [string, PinDragPointer | null]>;
  readonly step$: Command<void, [-1 | 1]>;
  readonly drop$: Command<Promise<void>, [AbortSignal]>;
  readonly dropPointer$: Command<Promise<void>, [AbortSignal]>;
  readonly startTouch$: Command<
    Promise<void>,
    [HTMLElement, TouchEvent, AbortSignal]
  >;
}

function createPinDragInteraction(
  internalDrag$: State<PinDrag | null>,
  drag$: Computed<PinDrag | null>,
) {
  const pointer$ = state<PinDragPointer | null>(null);
  const cancel$ = command(({ set }) => {
    set(internalDrag$, null);
    set(pointer$, null);
  });
  const cancelKeyboard$ = command(({ get, set }, threadId: string) => {
    const session = get(internalDrag$);
    if (!session?.keyboard || session.threadId !== threadId) {
      return false;
    }
    set(cancel$);
    return true;
  });
  const reconcile$ = command(({ get, set }) => {
    if (get(internalDrag$) && !get(drag$)) {
      set(cancel$);
    }
  });
  const mount$ = onRef(
    command(({ get, set }, element: HTMLElement, signal: AbortSignal) => {
      set(registerPinnedThreadDragSession$, reconcile$, signal);
      const document = element.ownerDocument;
      const cleanup = monitorForElements({
        canMonitor: ({ source }) => {
          return source.data.session === internalDrag$;
        },
        onDrag: ({ location }) => {
          const pointer = get(pointer$);
          const input = location.current.input;
          if (
            pointer &&
            (pointer.x !== input.clientX || pointer.y !== input.clientY)
          ) {
            set(pointer$, { ...pointer, x: input.clientX, y: input.clientY });
          }
        },
        onDrop: ({ location }) => {
          // Valid drops are persisted by the list's React onDrop callback.
          // The adapter runs in capture phase, before that callback.
          if (location.current.dropTargets.length === 0) {
            set(cancel$);
          }
        },
      });
      document.addEventListener(
        "drop",
        () => {
          if (get(pointer$)) {
            set(cancel$);
          }
        },
        { signal },
      );
      signal.addEventListener(
        "abort",
        () => {
          cleanup();
          set(cancel$);
        },
        { once: true },
      );
    }),
  );
  const start$ = command(
    ({ get, set }, threadId: string, pointer: PinDragPointer | null) => {
      if (get(pinnedThreadReorderEnabled$)) {
        set(pointer$, pointer);
        set(internalDrag$, {
          threadId,
          targetId: threadId,
          side: "before",
          keyboard: pointer === null,
        });
      }
    },
  );
  const preview$ = computed((get) => {
    const drag = get(drag$);
    const pointer = get(pointer$);
    if (!drag || !pointer) {
      return null;
    }
    const source = get(eventDrivenChatThreads$).find((item) => {
      return item.id === drag.threadId;
    })!;
    return { ...pointer, title: source.title };
  });
  const movePointer$ = command(({ get, set }, x: number, y: number) => {
    const pointer = get(pointer$);
    if (pointer && get(drag$)) {
      set(pointer$, { ...pointer, x, y });
    }
  });
  return { cancel$, cancelKeyboard$, mount$, start$, preview$, movePointer$ };
}

function createPinDragRowMount(
  internalDrag$: State<PinDrag | null>,
  start$: PinnedThreadDragSignals["start$"],
  cancelTouch$: Command<void, [string]>,
) {
  return onRef(
    command(({ get, set }, row: HTMLElement, signal: AbortSignal) => {
      const threadId = row.dataset.threadId;
      const handle = row.querySelector(".okou-thread-drag-handle");
      if (!threadId || !(handle instanceof HTMLElement)) {
        throw new Error("Missing pinned thread drag elements");
      }
      // Safari needs a non-passive listener before touchstart to let a later
      // long press prevent scrolling. Pending holds still allow native swipes.
      row.addEventListener(
        "touchmove",
        (event) => {
          const drag = get(internalDrag$);
          if (drag?.threadId === threadId && !drag.keyboard) {
            event.preventDefault();
          }
        },
        { signal, passive: false },
      );
      const cleanup = draggable({
        element: handle,
        getInitialData: () => {
          return { threadId, session: internalDrag$ };
        },
        onGenerateDragPreview: ({ nativeSetDragImage }) => {
          disableNativeDragPreview({ nativeSetDragImage });
        },
        onDragStart: ({ location }) => {
          // Release pointer focus before the row moves. Otherwise React's
          // focus restoration ends the adapter's hover fix during drop.
          // Keyboard sorting calls start$ directly and keeps its focus.
          handle.blur();
          set(start$, threadId, {
            x: location.current.input.clientX,
            y: location.current.input.clientY,
            width: row.getBoundingClientRect().width,
            offsetX: 16,
            offsetY: 16,
          });
        },
      });
      signal.addEventListener(
        "abort",
        () => {
          cleanup();
          set(cancelTouch$, threadId);
        },
        { once: true },
      );
    }),
  );
}

function createPinDragDropZoneMount(
  internalDrag$: State<PinDrag | null>,
  drag$: Computed<PinDrag | null>,
  target$: Command<void, [number]>,
) {
  return onRef(
    command(({ get, set }, element: HTMLElement, signal: AbortSignal) => {
      const findList = () => {
        return element.querySelector(
          '[data-testid="sidebar-chat-threads-virtual-list"]',
        );
      };
      const updateTarget = ({
        location,
      }: ElementDropTargetEventBasePayload) => {
        const list = findList();
        if (!list) {
          return;
        }
        // The fixed virtual slots do not move with the placeholder. Include
        // the pinned-agent area and header so dragging above the list selects 0.
        set(
          target$,
          Math.floor(
            (location.current.input.clientY -
              list.getBoundingClientRect().top) /
              CHAT_THREAD_VIRTUAL_ROW_HEIGHT,
          ),
        );
      };
      const cleanup = dropTargetForElements({
        element,
        canDrop: ({ source }) => {
          return (
            source.data.session === internalDrag$ &&
            get(drag$) !== null &&
            findList() !== null
          );
        },
        onDragEnter: updateTarget,
        onDrag: updateTarget,
        onDrop: updateTarget,
      });
      signal.addEventListener("abort", cleanup, { once: true });
    }),
  );
}

function createPinDragPlacement(
  internalDrag$: State<PinDrag | null>,
  drag$: Computed<PinDrag | null>,
) {
  const pins$ = computed((get) => {
    const drag = get(drag$);
    const threads = get(eventDrivenChatThreads$);
    const source = threads.find((item) => {
      return item.id === drag?.threadId;
    });
    return threads
      .filter((item) => {
        return item.agentId === source?.agentId && item.pinnedAt !== null;
      })
      .sort(comparePinnedThreads);
  });
  const remaining$ = computed((get) => {
    const drag = get(drag$);
    return get(pins$).filter((item) => {
      return item.id !== drag?.threadId;
    });
  });
  const placement$ = computed((get) => {
    const drag = get(drag$);
    if (!drag) {
      return null;
    }
    const sourceIndex = get(pins$).findIndex((item) => {
      return item.id === drag.threadId;
    });
    const destinationIndex =
      drag.targetId === drag.threadId
        ? sourceIndex
        : get(remaining$).findIndex((item) => {
            return item.id === drag.targetId;
          }) + (drag.side === "after" ? 1 : 0);
    return { sourceIndex, destinationIndex };
  });
  const target$ = command(({ get, set }, index: number) => {
    const drag = get(drag$);
    const remaining = get(remaining$);
    const destination = Math.max(0, Math.min(remaining.length, index));
    const target = remaining[destination] ?? remaining.at(-1);
    const side = destination === remaining.length ? "after" : "before";
    if (drag && target && (drag.targetId !== target.id || drag.side !== side)) {
      set(internalDrag$, { ...drag, targetId: target.id, side });
    }
  });
  return { placement$, target$ };
}

export function createPinnedThreadDragSignals(): PinnedThreadDragSignals {
  const internalDrag$ = state<PinDrag | null>(null);
  const drag$ = computed((get) => {
    const drag = get(internalDrag$);
    if (!drag || !get(pinnedThreadReorderEnabled$)) {
      return null;
    }
    const threads = get(eventDrivenChatThreads$);
    const source = threads.find((item) => {
      return item.id === drag.threadId;
    });
    const target = threads.find((item) => {
      return item.id === drag.targetId;
    });
    return source?.pinnedAt &&
      target?.pinnedAt &&
      source.agentId === target.agentId
      ? drag
      : null;
  });
  const { cancel$, cancelKeyboard$, mount$, start$, preview$, movePointer$ } =
    createPinDragInteraction(internalDrag$, drag$);
  const { placement$, target$ } = createPinDragPlacement(internalDrag$, drag$);
  const step$ = command(({ get, set }, direction: -1 | 1) => {
    const placement = get(placement$);
    if (placement) {
      set(target$, placement.destinationIndex + direction);
    }
  });
  const drop$ = command(async ({ get, set }, signal: AbortSignal) => {
    const drag = get(drag$);
    set(cancel$);
    if (drag) {
      await set(movePinnedThread$, drag, signal);
    }
  });
  const dropPointer$ = command(async ({ get, set }, signal: AbortSignal) => {
    if (get(drag$)?.keyboard === false) {
      await set(drop$, signal);
    }
  });
  const moveTouch$ = command(
    ({ get, set }, row: HTMLElement, x: number, y: number) => {
      if (!get(drag$)) {
        return false;
      }
      set(movePointer$, x, y);
      const zone = row.closest('[data-testid="pinned-thread-drop-zone"]');
      const bounds = zone?.getBoundingClientRect();
      const list = zone?.querySelector(
        '[data-testid="sidebar-chat-threads-virtual-list"]',
      );
      if (
        !bounds ||
        !list ||
        x < bounds.left ||
        x > bounds.right ||
        y < bounds.top ||
        y > bounds.bottom
      ) {
        return false;
      }
      set(
        target$,
        Math.floor(
          (y - list.getBoundingClientRect().top) /
            CHAT_THREAD_VIRTUAL_ROW_HEIGHT,
        ),
      );
      return true;
    },
  );
  const { startTouch$, cancelRow$ } = createPinnedThreadTouchDrag({
    drag$,
    start$,
    drop$,
    cancel$,
    move$: moveTouch$,
  });
  const announcement$ = computed((get) => {
    const drag = get(drag$);
    if (!drag?.keyboard) {
      return null;
    }
    const threads = get(eventDrivenChatThreads$);
    return {
      side: drag.side,
      title:
        threads.find((item) => {
          return item.id === drag.targetId;
        })?.title ?? "",
    };
  });
  return {
    drag$,
    placement$,
    preview$,
    mount$,
    mountRow$: createPinDragRowMount(internalDrag$, start$, cancelRow$),
    mountDropZone$: createPinDragDropZoneMount(internalDrag$, drag$, target$),
    cancelKeyboard$,
    start$,
    step$,
    drop$,
    dropPointer$,
    startTouch$,
    announcement$,
  };
}
