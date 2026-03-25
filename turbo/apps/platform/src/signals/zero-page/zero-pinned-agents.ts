import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { zeroUserPreferencesContract } from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
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
  const createClient = get(zeroClient$);
  const client = createClient(zeroUserPreferencesContract);
  const result = await client.get();
  if (result.status === 200) {
    return result.body.pinnedAgentIds;
  }
  throw new Error(`Failed to fetch user preferences: ${result.status}`);
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
  async ({ get, set }, ids: string[], _signal: AbortSignal) => {
    // Optimistic update — UI reflects the change immediately
    set(optimisticPinnedIds$, ids);
    set(internalSavingPinned$, true);
    try {
      const createClient = get(zeroClient$);
      const client = createClient(zeroUserPreferencesContract);
      const result = await client.update({ body: { pinnedAgentIds: ids } });

      if (result.status !== 200) {
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
