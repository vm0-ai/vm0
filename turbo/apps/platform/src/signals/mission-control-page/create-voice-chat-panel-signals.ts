import { command, state, type Command, type State } from "ccstate";
import { zeroVoiceChatContextContract, type ContextEvent } from "@vm0/core";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { setLoop } from "../utils.ts";

export interface VoiceChatPanelSignals {
  sessionId: string;
  events$: State<ContextEvent[]>;
  startPolling$: Command<Promise<void>, [AbortSignal]>;
  focusInput$: Command<void, []>;
}

export function createVoiceChatPanelSignals(
  sessionId: string,
): VoiceChatPanelSignals {
  const events$ = state<ContextEvent[]>([]);
  const lastSeq$ = state(0);

  const startPolling$ = command(async ({ get, set }, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroVoiceChatContextContract);
    await setLoop(
      async (sig: AbortSignal) => {
        const lastSeq = get(lastSeq$);
        const result = await accept(
          client.getEvents({
            params: { id: sessionId },
            query: { after: lastSeq },
            fetchOptions: { signal: sig },
          }),
          [200],
          { toast: false },
        );
        const incoming = result.body.events;
        if (incoming.length > 0) {
          set(events$, (prev) => {
            return [...prev, ...incoming];
          });
          const last = incoming[incoming.length - 1];
          if (last) {
            set(lastSeq$, last.seq);
          }
        }
        return false;
      },
      3000,
      signal,
    );
  });

  // No-op: satisfies the TaskPanelEntry.focusInput$ contract. Voice chat
  // panels have no text input to focus.
  const focusInput$ = command(() => {});

  return {
    sessionId,
    events$,
    startPolling$,
    focusInput$,
  };
}
