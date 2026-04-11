import { command, computed, state } from "ccstate";
import {
  createChatThreadSignals,
  ensureDraft$,
  type ChatThreadSignals,
} from "../chat-page/create-chat-thread.ts";

// ---------------------------------------------------------------------------
// Open thread registry — keyed by threadId
// ---------------------------------------------------------------------------

const openThreadsMap$ = state(new Map<string, ChatThreadSignals>());

/**
 * Whether the Mission Control thread panel is visible.
 * True when at least one thread is open.
 */
export const missionControlPanelVisible$ = computed((get) => {
  return get(openThreadsMap$).size > 0;
});

/**
 * Ordered list of [threadId, ChatThreadSignals] entries for rendering.
 */
export const openThreadEntries$ = computed(
  (get): [string, ChatThreadSignals][] => {
    return [...get(openThreadsMap$).entries()];
  },
);

/**
 * Open a chat thread in the Mission Control panel.
 * If the thread is already open, this is a no-op.
 * Callers should detach with Reason.DomCallback.
 */
export const openMissionControlThread$ = command(
  async (
    { get, set },
    threadId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const map = get(openThreadsMap$);
    if (map.has(threadId)) {
      return;
    }
    const draft = set(ensureDraft$, threadId);
    const signals = createChatThreadSignals(threadId, draft);
    set(openThreadsMap$, new Map(map).set(threadId, signals));
    await set(signals.loadMessages$, signal);
  },
);

/**
 * Close a chat thread in the Mission Control panel.
 * The ChatThreadSignals instance becomes unreferenced and is GC'd.
 */
export const closeMissionControlThread$ = command(
  ({ get, set }, threadId: string) => {
    const map = get(openThreadsMap$);
    if (!map.has(threadId)) {
      return;
    }
    const next = new Map(map);
    next.delete(threadId);
    set(openThreadsMap$, next);
  },
);
