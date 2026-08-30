import { command, computed, state } from "ccstate";
import {
  personalModelProvidersMainContract,
  personalModelProvidersByTypeContract,
  personalModelProviderAccountsByIdContract,
  type ResetPersonalModelProviderSubscriptionUsageResponse,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import type { ModelProviderType } from "@okouai/api-contracts/contracts/model-providers";
import { apiClient$ } from "../api-client.ts";
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
  const createClient = get(apiClient$);
  const client = createClient(personalModelProvidersMainContract);
  const result = await accept(client.list(), [200]);
  return result.body;
});

/**
 * Delete a personal model provider by type.
 */
export const deletePersonalModelProvider$ = command(
  async ({ get, set }, type: ModelProviderType, _signal: AbortSignal) => {
    const createClient = get(apiClient$);
    const client = createClient(personalModelProvidersByTypeContract);
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

export const activatePersonalModelProviderAccount$ = command(
  async ({ get, set }, id: string, signal: AbortSignal) => {
    const createClient = get(apiClient$);
    const client = createClient(personalModelProviderAccountsByIdContract);
    const result = await accept(
      client.activate({
        params: { id },
        body: {},
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(internalReloadPersonalModelProviders$, (x) => {
      return x + 1;
    });
    return result.body;
  },
);

export const deletePersonalModelProviderAccount$ = command(
  async ({ get, set }, id: string, signal: AbortSignal) => {
    const createClient = get(apiClient$);
    const client = createClient(personalModelProviderAccountsByIdContract);
    await accept(
      client.delete({
        params: { id },
        fetchOptions: { signal },
      }),
      [204],
    );
    signal.throwIfAborted();
    set(internalReloadPersonalModelProviders$, (x) => {
      return x + 1;
    });
  },
);

export const resetPersonalCodexAccountSubscriptionUsage$ = command(
  async (
    { get, set },
    args: { readonly id: string; readonly idempotencyKey: string },
    signal: AbortSignal,
  ): Promise<ResetPersonalModelProviderSubscriptionUsageResponse> => {
    const createClient = get(apiClient$);
    const client = createClient(personalModelProviderAccountsByIdContract);
    const result = await accept(
      client.resetSubscriptionUsage({
        params: { id: args.id },
        body: { idempotencyKey: args.idempotencyKey },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(internalReloadPersonalModelProviders$, (x) => {
      return x + 1;
    });
    return result.body;
  },
);

export const resetPersonalCodexSubscriptionUsage$ = command(
  async (
    { get, set },
    args: {
      readonly idempotencyKey: string;
    },
    signal: AbortSignal,
  ): Promise<ResetPersonalModelProviderSubscriptionUsageResponse> => {
    const createClient = get(apiClient$);
    const client = createClient(personalModelProvidersByTypeContract);
    const result = await accept(
      client.resetSubscriptionUsage({
        params: { type: "codex-oauth-token" },
        body: { idempotencyKey: args.idempotencyKey },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();

    set(internalReloadPersonalModelProviders$, (x) => {
      return x + 1;
    });

    return result.body;
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
