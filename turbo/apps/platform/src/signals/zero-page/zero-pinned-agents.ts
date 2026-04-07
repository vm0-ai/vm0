import { command, computed, state } from "ccstate";
import { zeroUserPreferencesContract } from "@vm0/core";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { clerk$ } from "../auth.ts";
import { zeroOnboardingStatus$ } from "./zero-onboarding.ts";
import { agents$ } from "../agent.ts";

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
  const result = await accept(client.get(), [200], { toast: false });
  return result.body.pinnedAgentIds;
});

/**
 * Effective pinned agent IDs — optimistic value if set, otherwise server value.
 */
export const pinnedAgentIds$ = computed(async (get) => {
  const status = await get(zeroOnboardingStatus$);
  const defaultAgentId = status.defaultAgentId;
  const optimistic = get(optimisticPinnedIds$);
  if (optimistic !== null) {
    return [
      defaultAgentId,
      ...optimistic.filter((id) => {
        return id !== defaultAgentId;
      }),
    ];
  }
  return [
    defaultAgentId,
    ...(await get(serverPinnedIds$)).filter((id) => {
      return id !== defaultAgentId;
    }),
  ];
});

/**
 * Update pinned agent IDs on the server with optimistic UI.
 */
/** Pinned agent IDs resolved to full agent objects. */
export const pinnedAgents$ = computed(async (get) => {
  const ids = await get(pinnedAgentIds$);
  const list = await get(agents$);
  return ids
    .map((id) => {
      return list.find((a) => {
        return a.id === id;
      });
    })
    .filter((a) => {
      return a !== undefined;
    });
});

export const updatePinnedAgentIds$ = command(
  async ({ get, set }, ids: string[], _signal: AbortSignal) => {
    // Optimistic update — UI reflects the change immediately
    set(optimisticPinnedIds$, ids);
    try {
      const createClient = get(zeroClient$);
      const client = createClient(zeroUserPreferencesContract);
      await accept(client.update({ body: { pinnedAgentIds: ids } }), [200]);

      // Force JWT refresh so updated membership metadata is available immediately
      const clerk = await get(clerk$);
      await clerk.session?.getToken({ skipCache: true });

      set(reloadPinned$, (x) => {
        return x + 1;
      });
    } finally {
      set(optimisticPinnedIds$, null);
    }
  },
);
