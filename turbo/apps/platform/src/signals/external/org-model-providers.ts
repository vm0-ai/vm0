import { command, computed, state } from "ccstate";
import {
  zeroModelProvidersMainContract,
  zeroModelProvidersByTypeContract,
  type UpsertModelProviderRequest,
  type ModelProviderType,
} from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";

/**
 * Reload trigger for org model provider signals.
 * Increment to force recomputation of orgModelProviders$.
 */
const internalReloadOrgModelProviders$ = state(0);

/**
 * Org-level model providers.
 */
export const orgModelProviders$ = computed(async (get) => {
  get(internalReloadOrgModelProviders$);
  const createClient = get(zeroClient$);
  const client = createClient(zeroModelProvidersMainContract);
  const result = await client.list();
  if (result.status === 200) {
    return result.body;
  }
  throw new Error(`Failed to list org model providers: ${result.status}`);
});

/**
 * Create or update an org model provider (admin only).
 */
export const createOrgModelProvider$ = command(
  async ({ get, set }, request: UpsertModelProviderRequest) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroModelProvidersMainContract);
    const result = await client.upsert({ body: request });

    if (result.status !== 200 && result.status !== 201) {
      throw new Error(`Failed to create org model provider: ${result.status}`);
    }

    set(internalReloadOrgModelProviders$, (x) => x + 1);

    return result.body;
  },
);

/**
 * Delete an org model provider by type (admin only).
 */
export const deleteOrgModelProvider$ = command(
  async ({ get, set }, type: ModelProviderType) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroModelProvidersByTypeContract);
    const result = await client.delete({ params: { type } });

    if (result.status !== 204) {
      throw new Error(`Failed to delete org model provider: ${result.status}`);
    }

    set(internalReloadOrgModelProviders$, (x) => x + 1);
  },
);
