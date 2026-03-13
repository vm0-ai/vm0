import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import type { UserPreferencesResponse } from "@vm0/core";
import { fetch$ } from "../fetch.ts";
import { clerk$ } from "../auth.ts";

const reloadPinned$ = state(0);

/**
 * Optimistic override — when set, takes precedence over the server value.
 */
const optimisticPinnedIds$ = state<string[] | null>(null);

/**
 * Pinned agent IDs fetched from user preferences API.
 */
const serverPinnedIds$ = computed(async (get) => {
  get(reloadPinned$);
  const fetchFn = get(fetch$);
  const resp = await fetchFn("/api/user/preferences");
  const data = (await resp.json()) as UserPreferencesResponse;
  return data.pinnedAgentIds;
});

/**
 * Effective pinned agent IDs — optimistic value if set, otherwise server value.
 */
export const pinnedAgentIds$ = computed((get) => {
  const optimistic = get(optimisticPinnedIds$);
  if (optimistic !== null) {
    return optimistic;
  }
  return get(serverPinnedIds$);
});

/**
 * Whether a pinned agents update is in flight.
 */
const internalSavingPinned$ = state(false);
export const savingPinnedAgents$ = computed((get) =>
  get(internalSavingPinned$),
);

/**
 * Update pinned agent IDs on the server with optimistic UI.
 */
export const updatePinnedAgentIds$ = command(
  async ({ get, set }, ids: string[]) => {
    // Optimistic update — UI reflects the change immediately
    set(optimisticPinnedIds$, ids);
    set(internalSavingPinned$, true);
    try {
      const fetchFn = get(fetch$);
      const response = await fetchFn("/api/user/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinnedAgentIds: ids }),
      });

      if (!response.ok) {
        toast.error("Failed to update pinned agents");
        return;
      }

      // Force JWT refresh so updated membership metadata is available immediately
      const clerk = await get(clerk$);
      await clerk.session?.getToken({ skipCache: true });

      set(reloadPinned$, (x) => x + 1);
    } finally {
      set(optimisticPinnedIds$, null);
      set(internalSavingPinned$, false);
    }
  },
);
