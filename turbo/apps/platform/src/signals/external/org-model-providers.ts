import { command, computed, state } from "ccstate";
import {
  zeroModelProvidersMainContract,
  zeroModelProvidersByTypeContract,
  zeroModelProvidersDefaultContract,
} from "@vm0/api-contracts/contracts/zero-model-providers";
import type {
  UpsertModelProviderRequest,
  ModelProviderType,
  UpsertModelProviderResponse,
} from "@vm0/api-contracts/contracts/model-providers";
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
    const result = await accept(
      client.upsert({
        body: request,
        fetchOptions: { signal: _signal },
      }),
      [200, 201],
    );

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
    await accept(
      client.setDefault({
        params: { type },
        fetchOptions: { signal: _signal },
      }),
      [200],
    );

    set(internalReloadOrgModelProviders$, (x) => {
      return x + 1;
    });
  },
);

/**
 * Submit a raw `~/.codex/auth.json` payload for the codex-oauth-token
 * provider via the `auth_json` authMethod (server-side parser lives in
 * #11978). Suppresses the default toast on error so the paste dialog can
 * render typed error codes inline (e.g. `auth_json_shape_invalid`,
 * `free_plan_rejected`); callers handle the thrown ApiError.
 */
export const submitCodexAuthJson$ = command(
  async (
    { get, set },
    rawJson: string,
    signal: AbortSignal,
  ): Promise<UpsertModelProviderResponse> => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroModelProvidersMainContract);
    const result = await accept(
      client.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: rawJson },
        },
        fetchOptions: { signal },
      }),
      [200, 201],
      { toast: false },
    );

    set(internalReloadOrgModelProviders$, (x) => {
      return x + 1;
    });

    return result.body;
  },
);

/**
 * Delete an org model provider by type (admin only).
 */
export const deleteOrgModelProvider$ = command(
  async ({ get, set }, type: ModelProviderType, _signal: AbortSignal) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroModelProvidersByTypeContract);
    await accept(
      client.delete({
        params: { type },
        fetchOptions: { signal: _signal },
      }),
      [204],
    );

    set(internalReloadOrgModelProviders$, (x) => {
      return x + 1;
    });
  },
);
