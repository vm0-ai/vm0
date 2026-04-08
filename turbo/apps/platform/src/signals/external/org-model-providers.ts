import { command, computed, state } from "ccstate";
import {
  zeroModelProvidersMainContract,
  zeroModelProvidersByTypeContract,
  zeroModelProvidersDefaultContract,
  type UpsertModelProviderRequest,
  type ModelProviderType,
} from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

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
  const result = await accept(client.list(), [200]);
  return result.body;
});

/**
 * Create or update an org model provider (admin only).
 */
export const createOrgModelProvider$ = command(
  async (
    { get, set },
    request: UpsertModelProviderRequest,
    _signal: AbortSignal,
  ) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroModelProvidersMainContract);
    const result = await accept(client.upsert({ body: request }), [200, 201]);

    set(internalReloadOrgModelProviders$, (x) => {
      return x + 1;
    });

    return result.body;
  },
);

/**
 * Set an org model provider as the default (admin only).
 */
export const setDefaultOrgModelProvider$ = command(
  async ({ get, set }, type: ModelProviderType, _signal: AbortSignal) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroModelProvidersDefaultContract);
    await accept(client.setDefault({ params: { type } }), [200]);

    set(internalReloadOrgModelProviders$, (x) => {
      return x + 1;
    });
  },
);

/**
 * Delete an org model provider by type (admin only).
 */
export const deleteOrgModelProvider$ = command(
  async ({ get, set }, type: ModelProviderType, _signal: AbortSignal) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroModelProvidersByTypeContract);
    await accept(client.delete({ params: { type } }), [204]);

    set(internalReloadOrgModelProviders$, (x) => {
      return x + 1;
    });
  },
);
