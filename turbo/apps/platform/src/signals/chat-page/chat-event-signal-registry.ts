import { command, state, type Command } from "ccstate";
import type { ChatEvent } from "@vm0/api-contracts/contracts/chat-threads";

type ReceiveChatEventsCommand = Command<
  Promise<void>,
  [readonly ChatEvent[], AbortSignal]
>;

interface ActiveChatEventSignals {
  readonly id: string;
  readonly receive$: ReceiveChatEventsCommand;
}

const activeChatEventSignals$ = state(
  new Map<string, readonly ActiveChatEventSignals[]>(),
);

const unregisterActiveChatEventSignals$ = command(
  ({ get, set }, threadId: string, id: string): void => {
    const current = get(activeChatEventSignals$);
    const registrations = current.get(threadId);
    if (registrations === undefined) {
      return;
    }
    const remaining = registrations.filter((registration) => {
      return registration.id !== id;
    });
    const next = new Map(current);
    if (remaining.length === 0) {
      next.delete(threadId);
    } else {
      next.set(threadId, remaining);
    }
    set(activeChatEventSignals$, next);
  },
);

export const registerActiveChatEventSignals$ = command(
  (
    { get, set },
    threadId: string,
    receive$: ReceiveChatEventsCommand,
    signal: AbortSignal,
  ): void => {
    signal.throwIfAborted();
    const id = crypto.randomUUID();
    const current = get(activeChatEventSignals$);
    const next = new Map(current);
    next.set(threadId, [...(current.get(threadId) ?? []), { id, receive$ }]);
    set(activeChatEventSignals$, next);
    signal.addEventListener(
      "abort",
      () => {
        set(unregisterActiveChatEventSignals$, threadId, id);
      },
      { once: true },
    );
  },
);

export const receiveActiveChatEvents$ = command(
  async (
    { get, set },
    threadId: string,
    events: readonly ChatEvent[],
    signal: AbortSignal,
  ): Promise<void> => {
    await Promise.all(
      (get(activeChatEventSignals$).get(threadId) ?? []).map((registration) => {
        return set(registration.receive$, events, signal);
      }),
    );
    signal.throwIfAborted();
  },
);
