import { command, computed, state } from "ccstate";
import {
  zeroPersonalModelProvidersMainContract,
  zeroPersonalModelProvidersByTypeContract,
} from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import type {
  ModelProviderType,
  UpsertModelProviderRequest,
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

/**
 * Force-refresh `personalModelProviders$` after a successful higher-level
 * provider mutation, such as Codex device login. Mirrors
 * `reloadOrgModelProviders$` in `external/org-model-providers.ts`.
 */
export const reloadPersonalModelProviders$ = command(({ set }) => {
  set(internalReloadPersonalModelProviders$, (x) => {
    return x + 1;
  });
});
