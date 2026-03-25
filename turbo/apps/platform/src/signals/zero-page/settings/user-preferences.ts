import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  zeroUserPreferencesContract,
  type UpdateUserPreferencesRequest,
} from "@vm0/core";
import { zeroClient$ } from "../../api-client.ts";
import { clerk$ } from "../../auth.ts";

// ---------------------------------------------------------------------------
// Reload trigger
// ---------------------------------------------------------------------------

const internalReloadPreferences$ = state(0);

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

export const userPreferences$ = computed(async (get) => {
  get(internalReloadPreferences$);
  const createClient = get(zeroClient$);
  const client = createClient(zeroUserPreferencesContract);
  const result = await client.get();
  if (result.status === 200) {
    return result.body;
  }
  throw new Error(`Failed to fetch user preferences: ${result.status}`);
});

// ---------------------------------------------------------------------------
// Update command
// ---------------------------------------------------------------------------

export const updateUserPreference$ = command(
  async ({ get, set }, update: UpdateUserPreferencesRequest) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroUserPreferencesContract);
    const result = await client.update({ body: update });

    if (result.status !== 200) {
      toast.error("Failed to update preference");
      return;
    }

    // Force JWT refresh so updated membership metadata is available immediately
    const clerk = await get(clerk$);
    await clerk.session?.getToken({ skipCache: true });

    set(internalReloadPreferences$, (x) => x + 1);
  },
);
