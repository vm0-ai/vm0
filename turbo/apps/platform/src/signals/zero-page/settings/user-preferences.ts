import { command, computed, state } from "ccstate";
import {
  zeroUserPreferencesContract,
  type UpdateUserPreferencesRequest,
} from "@vm0/api-contracts/contracts/zero-user-preferences";
import { zeroClient$ } from "../../api-client.ts";
import { clerk$ } from "../../auth.ts";
import { accept } from "../../../lib/accept.ts";

// ---------------------------------------------------------------------------
// Reload trigger
// ---------------------------------------------------------------------------

const internalReloadPreferences$ = state(0);

export const reloadUserPreferences$ = command(({ set }) => {
  set(internalReloadPreferences$, (x) => {
    return x + 1;
  });
});

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

export const userPreferences$ = computed(async (get) => {
  get(internalReloadPreferences$);
  const createClient = get(zeroClient$);
  const client = createClient(zeroUserPreferencesContract);
  const result = await accept(client.get(), [200]);
  return result.body;
});

// ---------------------------------------------------------------------------
// Update command
// ---------------------------------------------------------------------------

export const updateUserPreference$ = command(
  async (
    { get, set },
    update: UpdateUserPreferencesRequest,
    _signal: AbortSignal,
  ) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroUserPreferencesContract);
    await accept(
      client.update({
        body: update,
        fetchOptions: { signal: _signal },
      }),
      [200],
    );

    // Force JWT refresh so updated membership metadata is available immediately
    const clerk = await get(clerk$);
    await clerk.session?.getToken({ skipCache: true });

    set(reloadUserPreferences$);
  },
);
