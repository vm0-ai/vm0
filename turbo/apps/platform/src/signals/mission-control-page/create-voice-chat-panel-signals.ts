import { command, state, type Command, type State } from "ccstate";
import { fetch$ } from "../fetch.ts";
import { setLoop } from "../utils.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VoiceChatEvent {
  id: string;
  seq: number;
  source: string;
  type: string;
  content: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// VoiceChatPanelSignals — returned by createVoiceChatPanelSignals
// ---------------------------------------------------------------------------

export interface VoiceChatPanelSignals {
  sessionId: string;
  events$: State<VoiceChatEvent[]>;
  startPolling$: Command<Promise<void>, [AbortSignal]>;
  focusInput$: Command<void, []>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createVoiceChatPanelSignals(
  sessionId: string,
): VoiceChatPanelSignals {
  const events$ = state<VoiceChatEvent[]>([]);
  const lastSeq$ = state(0);

  const startPolling$ = command(async ({ get, set }, signal: AbortSignal) => {
    await setLoop(
      async (sig: AbortSignal) => {
        const lastSeq = get(lastSeq$);
        const fetchFn = get(fetch$);
        const res = await fetchFn(
          `/api/zero/voice-chat/${sessionId}/context?after=${lastSeq}`,
          { signal: sig },
        );

        if (!res.ok) {
          return false;
        }

        const json: unknown = await res.json();
        sig.throwIfAborted();

        if (
          typeof json !== "object" ||
          json === null ||
          !("events" in json) ||
          !Array.isArray((json as { events: unknown }).events)
        ) {
          return false;
        }

        const incoming = (json as { events: VoiceChatEvent[] }).events;
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

  const focusInput$ = command(() => {});

  return {
    sessionId,
    events$,
    startPolling$,
    focusInput$,
  };
}
