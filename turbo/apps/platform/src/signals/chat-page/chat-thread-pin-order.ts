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
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { stableChatThreadNavigationEnabled$ } from "../external/feature-switch.ts";
import { onRef } from "../utils.ts";
import { chatThreadOnlyUnread$ } from "./chat-thread-only-unread.ts";
import {
  eventDrivenChatThreads$,
  registerOptimisticChatThreadEvent$,
} from "./chat-thread-event-sourcing.ts";
import { registerPinnedThreadDragSession$ } from "./chat-thread-pin-drag-lifecycle.ts";

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
}

interface PinDragPreview extends PinDragPointer {
  readonly title: string | null;
}

interface PinDragAnnouncement {
  readonly side: PinMove["side"];
  readonly title: string;
}

export interface PinnedThreadDragSignals {
  readonly drag$: Computed<PinDrag | null>;
  readonly preview$: Computed<PinDragPreview | null>;
  readonly announcement$: Computed<PinDragAnnouncement | null>;
  readonly mount$: Command<(() => void) | undefined, [HTMLElement | null]>;
  readonly mountRow$: Command<(() => void) | undefined, [HTMLElement | null]>;
  readonly cancelKeyboard$: Command<boolean, [string]>;
  readonly start$: Command<void, [string, PinDragPointer | null]>;
  readonly step$: Command<void, [-1 | 1]>;
  readonly drop$: Command<Promise<void>, [AbortSignal]>;
  readonly dropPointer$: Command<Promise<void>, [AbortSignal]>;
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
  return { cancel$, cancelKeyboard$, mount$, start$, preview$ };
}

function createPinDragRowMount(
  internalDrag$: State<PinDrag | null>,
  drag$: Computed<PinDrag | null>,
  start$: PinnedThreadDragSignals["start$"],
  target$: Command<void, [string, PinMove["side"]]>,
) {
  return onRef(
    command(({ get, set }, row: HTMLElement, signal: AbortSignal) => {
      const threadId = row.dataset.threadId;
      const handle = row.querySelector(".okou-thread-drag-handle");
      const slot = row.parentElement;
      if (!threadId || !(handle instanceof HTMLElement) || !slot) {
        throw new Error("Missing pinned thread drag elements");
      }
      const updateTarget = ({
        location,
      }: ElementDropTargetEventBasePayload) => {
        const rect = row.getBoundingClientRect();
        set(
          target$,
          threadId,
          location.current.input.clientY < rect.top + rect.height / 2
            ? "before"
            : "after",
        );
      };
      const cleanup = combine(
        draggable({
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
            });
          },
        }),
        dropTargetForElements({
          // Include the existing 4px padding in the hit area, without
          // changing the 32px row or its 36px virtual slot.
          element: slot,
          canDrop: ({ source }) => {
            return source.data.session === internalDrag$ && get(drag$) !== null;
          },
          onDragEnter: updateTarget,
          onDrag: updateTarget,
          onDrop: updateTarget,
        }),
      );
      signal.addEventListener("abort", cleanup, { once: true });
    }),
  );
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
  const { cancel$, cancelKeyboard$, mount$, start$, preview$ } =
    createPinDragInteraction(internalDrag$, drag$);
  const target$ = command(
    ({ get, set }, targetId: string, side: PinMove["side"]) => {
      const drag = get(drag$);
      if (drag && (drag.targetId !== targetId || drag.side !== side)) {
        set(internalDrag$, { ...drag, targetId, side });
      }
    },
  );
  const step$ = command(({ get, set }, direction: -1 | 1) => {
    const drag = get(drag$);
    if (!drag) {
      return;
    }
    const threads = get(eventDrivenChatThreads$);
    const source = threads.find((item) => {
      return item.id === drag.threadId;
    })!;
    const pins = threads
      .filter((item) => {
        return item.agentId === source.agentId && item.pinnedAt !== null;
      })
      .sort(comparePinnedThreads);
    const remaining = pins.filter((item) => {
      return item.id !== source.id;
    });
    const currentIndex =
      drag.targetId === source.id
        ? pins.findIndex((item) => {
            return item.id === source.id;
          })
        : remaining.findIndex((item) => {
            return item.id === drag.targetId;
          }) + (drag.side === "after" ? 1 : 0);
    const nextIndex = Math.max(
      0,
      Math.min(remaining.length, currentIndex + direction),
    );
    const target = remaining[nextIndex] ?? remaining.at(-1);
    if (target) {
      set(internalDrag$, {
        ...drag,
        targetId: target.id,
        side: nextIndex === remaining.length ? "after" : "before",
      });
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
    preview$,
    mount$,
    mountRow$: createPinDragRowMount(internalDrag$, drag$, start$, target$),
    cancelKeyboard$,
    start$,
    step$,
    drop$,
    dropPointer$,
    announcement$,
  };
}
