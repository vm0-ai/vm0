import { command, computed, state } from "ccstate";
import { chatThreadPinOrderContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  comparePinnedThreads,
  moveChatThreadPinOrder,
} from "@okouai/core/chat-thread-pin-order";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { stableChatThreadNavigationEnabled$ } from "../external/feature-switch.ts";
import { onRef } from "../utils.ts";
import { chatThreadOnlyUnread$ } from "./chat-thread-only-unread.ts";
import {
  eventDrivenChatThreads$,
  registerOptimisticChatThreadEvent$,
} from "./chat-thread-event-sourcing.ts";

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

export function createPinnedThreadDragSignals() {
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
  const cancel$ = command(({ set }) => {
    return set(internalDrag$, null);
  });
  const mount$ = onRef(
    command(({ set }, _element: HTMLElement, signal: AbortSignal) => {
      signal.addEventListener(
        "abort",
        () => {
          return set(cancel$);
        },
        { once: true },
      );
    }),
  );
  const start$ = command(
    ({ get, set }, threadId: string, keyboard: boolean) => {
      if (get(pinnedThreadReorderEnabled$)) {
        set(internalDrag$, {
          threadId,
          targetId: threadId,
          side: "before",
          keyboard,
        });
      }
    },
  );
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
    mount$,
    cancel$,
    start$,
    target$,
    step$,
    drop$,
    announcement$,
  };
}

export type PinnedThreadDragSignals = ReturnType<
  typeof createPinnedThreadDragSignals
>;
