import { command, computed, state, type Computed } from "ccstate";
import type { ChatEventRow } from "@vm0/api-contracts/contracts/chat-event-rows";
import { goalRunIdsFromChatEventRows } from "@vm0/api-contracts/contracts/chat-event-row-projection";

/**
 * Goal-run ids learned from raw rows, per thread. Rows arrive in seq order and
 * a run's claimed `input.goal` row precedes the run's own events, so recording
 * every batch before projecting it reproduces the API's zero_runs-derived
 * `isGoalRun` flag. The map outlives individual panes so background-synced
 * batches project correctly for any thread a pane already initialized.
 */
const goalRunIdsByThread$ = state<ReadonlyMap<string, ReadonlySet<string>>>(
  new Map(),
);

export const recordGoalRunIds$ = command(
  ({ get, set }, threadId: string, rows: readonly ChatEventRow[]): void => {
    const learned = goalRunIdsFromChatEventRows(rows);
    if (learned.size === 0) {
      return;
    }
    const current = get(goalRunIdsByThread$);
    const merged = new Set([...(current.get(threadId) ?? []), ...learned]);
    const next = new Map(current);
    next.set(threadId, merged);
    set(goalRunIdsByThread$, next);
  },
);

const EMPTY_GOAL_RUN_IDS: ReadonlySet<string> = new Set();

export function goalRunIdsForThread(
  threadId: string,
): Computed<ReadonlySet<string>> {
  return computed((get): ReadonlySet<string> => {
    return get(goalRunIdsByThread$).get(threadId) ?? EMPTY_GOAL_RUN_IDS;
  });
}
