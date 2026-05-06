import { command, computed, state } from "ccstate";
import {
  zeroPersonalModelProvidersMainContract,
  zeroPersonalModelProvidersByTypeContract,
  zeroPersonalModelProvidersDefaultContract,
} from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import type {
  UpsertModelProviderRequest,
  ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

/**
 * Reload trigger for personal model provider signals.
 * Increment to force recomputation of personalModelProviders$.
 */
const internalReloadPersonalModelProviders$ = state(0);

/**
 * Personal (user-level) model providers for the requesting user.
 */
export const personalModelProviders$ = computed(async (get) => {
  get(internalReloadPersonalModelProviders$);
  const createClient = get(zeroClient$);
  const client = createClient(zeroPersonalModelProvidersMainContract);
  const result = await accept(client.list(), [200]);
  return result.body;
});

/**
 * Create or update a personal model provider for the requesting user.
 */
export const createPersonalModelProvider$ = command(
  async (
    { get, set },
    request: UpsertModelProviderRequest,
    _signal: AbortSignal,
  ) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroPersonalModelProvidersMainContract);
    const result = await accept(
      client.upsert({
        body: request,
        fetchOptions: { signal: _signal },
      }),
      [200, 201],
    );

    set(internalReloadPersonalModelProviders$, (x) => {
      return x + 1;
    });

    return result.body;
  },
);

/**
 * Set a personal model provider as the user's default.
 */
export const setDefaultPersonalModelProvider$ = command(
  async ({ get, set }, type: ModelProviderType, _signal: AbortSignal) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroPersonalModelProvidersDefaultContract);
    await accept(
      client.setDefault({
        params: { type },
        fetchOptions: { signal: _signal },
      }),
      [200],
    );

    set(internalReloadPersonalModelProviders$, (x) => {
      return x + 1;
    });
  },
);

/**
 * Delete a personal model provider by type.
 */
export const deletePersonalModelProvider$ = command(
  async ({ get, set }, type: ModelProviderType, _signal: AbortSignal) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroPersonalModelProvidersByTypeContract);
    await accept(
      client.delete({
        params: { type },
        fetchOptions: { signal: _signal },
      }),
      [204],
    );

    set(internalReloadPersonalModelProviders$, (x) => {
      return x + 1;
    });
  },
);
