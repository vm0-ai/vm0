import { command, computed, state, type Command, type Computed } from "ccstate";
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
  events$: Computed<VoiceChatEvent[]>;
  startPolling$: Command<Promise<void>, [AbortSignal]>;
  focusInput$: Command<void, []>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createVoiceChatPanelSignals(
  sessionId: string,
): VoiceChatPanelSignals {
  const internalEvents$ = state<VoiceChatEvent[]>([]);
  const internalLastSeq$ = state(0);

  const events$ = computed((get) => {
    return get(internalEvents$);
  });

  const startPolling$ = command(async ({ get, set }, signal: AbortSignal) => {
    await setLoop(
      async (sig: AbortSignal) => {
        const lastSeq = get(internalLastSeq$);
        const fetchFn = get(fetch$);
        const res = await fetchFn(
          `/api/zero/voice-chat/${sessionId}/context?after=${lastSeq}`,
          { signal: sig },
        );

        if (!res.ok) {
          return false;
        }

        const data = (await res.json()) as { events: VoiceChatEvent[] };
        sig.throwIfAborted();

        if (data.events.length > 0) {
          set(internalEvents$, (prev) => {
            return [...prev, ...data.events];
          });
          const lastEvent = data.events[data.events.length - 1];
          if (lastEvent) {
            set(internalLastSeq$, lastEvent.seq);
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
