import { sharedThreadsContract } from "@vm0/api-contracts/contracts/shared-threads";
import { command, computed, state, type Command, type Computed } from "ccstate";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";

const SHARED_THREAD_SELECTION_TEXT_LIMIT_BYTES = 1.5 * 1024 * 1024;

export interface ShareableChatEvent {
  readonly id: string;
  readonly text: string;
}

export type SharedThreadSelectionPhase = "idle" | "selecting" | "created";
export type ToggleSharedThreadSelectionResult =
  | "selected"
  | "deselected"
  | "too-large";

export interface ChatThreadSharingSignals {
  readonly phase$: Computed<SharedThreadSelectionPhase>;
  readonly selectedEventIds$: Computed<ReadonlySet<string>>;
  readonly selectedCount$: Computed<number>;
  readonly createdSharedThreadId$: Computed<string | null>;
  readonly start$: Command<void, []>;
  readonly close$: Command<void, []>;
  readonly toggle$: Command<
    ToggleSharedThreadSelectionResult,
    [readonly ShareableChatEvent[]]
  >;
  readonly create$: Command<Promise<void>, [AbortSignal]>;
}

export function createChatThreadSharingSignals(
  threadId: string,
): ChatThreadSharingSignals {
  const internalPhase$ = state<SharedThreadSelectionPhase>("idle");
  const internalSelectedBytes$ = state<ReadonlyMap<string, number>>(new Map());
  const internalCreatedSharedThreadId$ = state<string | null>(null);

  const start$ = command(({ set }) => {
    set(internalSelectedBytes$, new Map());
    set(internalCreatedSharedThreadId$, null);
    set(internalPhase$, "selecting");
  });

  const close$ = command(({ set }) => {
    set(internalSelectedBytes$, new Map());
    set(internalCreatedSharedThreadId$, null);
    set(internalPhase$, "idle");
  });

  const toggle$ = command(
    (
      { get, set },
      events: readonly ShareableChatEvent[],
    ): ToggleSharedThreadSelectionResult => {
      const selected = get(internalSelectedBytes$);
      const allSelected = events.every((event) => {
        return selected.has(event.id);
      });
      if (allSelected) {
        const next = new Map(selected);
        for (const event of events) {
          next.delete(event.id);
        }
        set(internalSelectedBytes$, next);
        return "deselected";
      }

      const next = new Map(selected);
      for (const event of events) {
        if (!next.has(event.id)) {
          next.set(event.id, new TextEncoder().encode(event.text).byteLength);
        }
      }
      const selectedBytes = [...next.values()].reduce((total, value) => {
        return total + value;
      }, 0);
      if (selectedBytes > SHARED_THREAD_SELECTION_TEXT_LIMIT_BYTES) {
        return "too-large";
      }
      set(internalSelectedBytes$, next);
      return "selected";
    },
  );

  const create$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const eventIds = [...get(internalSelectedBytes$).keys()];
      const client = get(zeroClient$)(sharedThreadsContract);
      const result = await accept(
        client.create({
          params: { threadId },
          body: { eventIds },
          fetchOptions: { signal },
        }),
        [201, 400, 413],
        signal,
      );
      if (result.status !== 201) {
        throw new Error(result.body.error.message);
      }
      set(internalCreatedSharedThreadId$, result.body.id);
      set(internalPhase$, "created");
    },
  );

  return {
    phase$: computed((get) => {
      return get(internalPhase$);
    }),
    selectedEventIds$: computed((get) => {
      return new Set(get(internalSelectedBytes$).keys());
    }),
    selectedCount$: computed((get) => {
      return get(internalSelectedBytes$).size;
    }),
    createdSharedThreadId$: computed((get) => {
      return get(internalCreatedSharedThreadId$);
    }),
    start$,
    close$,
    toggle$,
    create$,
  };
}
