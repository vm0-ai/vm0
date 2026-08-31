import { command, state, type Command } from "ccstate";

type SyncChatEventsCommand = Command<Promise<void>, [AbortSignal]>;

interface ActiveChatEventSignals {
  readonly id: string;
  readonly sync$: SyncChatEventsCommand;
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
    sync$: SyncChatEventsCommand,
    signal: AbortSignal,
  ): void => {
    signal.throwIfAborted();
    const id = crypto.randomUUID();
    const current = get(activeChatEventSignals$);
    const next = new Map(current);
    next.set(threadId, [...(current.get(threadId) ?? []), { id, sync$ }]);
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

export const syncActiveChatEvents$ = command(
  async (
    { get, set },
    threadId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    await Promise.all(
      (get(activeChatEventSignals$).get(threadId) ?? []).map((registration) => {
        return set(registration.sync$, signal);
      }),
    );
    signal.throwIfAborted();
  },
);
