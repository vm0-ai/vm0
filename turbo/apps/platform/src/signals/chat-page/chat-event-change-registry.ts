import { command, state, type Command, type Computed } from "ccstate";
import type { ChatEvent } from "./chat-event-types.ts";

type ChatEventChangeHandler = Command<Promise<void>, [AbortSignal]>;

interface ChatEventChangeRegistration {
  readonly id: string;
  readonly handler$: ChatEventChangeHandler;
}

type ChatEventsSignal = Computed<ChatEvent[]>;

const registrationsByEvents$ = state(
  new Map<ChatEventsSignal, readonly ChatEventChangeRegistration[]>(),
);

const unregisterChatEventChangeHandler$ = command(
  ({ get, set }, events$: ChatEventsSignal, id: string): void => {
    const current = get(registrationsByEvents$);
    const registrations = current.get(events$);
    if (registrations === undefined) {
      return;
    }
    const remaining = registrations.filter((registration) => {
      return registration.id !== id;
    });
    const next = new Map(current);
    if (remaining.length === 0) {
      next.delete(events$);
    } else {
      next.set(events$, remaining);
    }
    set(registrationsByEvents$, next);
  },
);

export const registerChatEventChangeHandler$ = command(
  (
    { get, set },
    events$: ChatEventsSignal,
    handler$: ChatEventChangeHandler,
    signal: AbortSignal,
  ): void => {
    signal.throwIfAborted();
    const id = crypto.randomUUID();
    const current = get(registrationsByEvents$);
    const next = new Map(current);
    next.set(events$, [...(current.get(events$) ?? []), { id, handler$ }]);
    set(registrationsByEvents$, next);
    signal.addEventListener(
      "abort",
      () => {
        set(unregisterChatEventChangeHandler$, events$, id);
      },
      { once: true },
    );
  },
);

export const notifyChatEventsChanged$ = command(
  async (
    { get, set },
    events$: ChatEventsSignal,
    signal: AbortSignal,
  ): Promise<void> => {
    await Promise.all(
      (get(registrationsByEvents$).get(events$) ?? []).map((registration) => {
        return set(registration.handler$, signal);
      }),
    );
    signal.throwIfAborted();
  },
);
