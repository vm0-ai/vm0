import { command, computed, state } from "ccstate";
import { fetch$ } from "../fetch";
import type {
  ModelProviderListResponse,
  UpsertModelProviderRequest,
  UpsertModelProviderResponse,
} from "@vm0/core";

/**
 * Reload trigger for model provider signals.
 * Increment to force recomputation of modelProviders$.
 */
const internalReloadModelProviders$ = state(0);

/**
 * Current user's model providers.
 */
export const modelProviders$ = computed(async (get) => {
  get(internalReloadModelProviders$); // Subscribe to reload trigger
  const fetchFn = get(fetch$);
  const resp = await fetchFn("/api/model-providers");
  return (await resp.json()) as ModelProviderListResponse;
});

/**
 * Whether the user has a claude-code-oauth-token model provider configured.
 */
export const hasClaudeCodeOAuthToken$ = computed(async (get) => {
  const { modelProviders } = await get(modelProviders$);
  return modelProviders.some((p) => p.type === "claude-code-oauth-token");
});

/**
 * Trigger a reload of model providers data.
 */
export const reloadModelProviders$ = command(({ set }) => {
  set(internalReloadModelProviders$, (x) => x + 1);
});

/**
 * Create or update a model provider.
 */
export const createModelProvider$ = command(
  async ({ get, set }, request: UpsertModelProviderRequest) => {
    const fetchFn = get(fetch$);
    const response = await fetchFn("/api/model-providers", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`Failed to create model provider: ${response.status}`);
    }

    const result = (await response.json()) as UpsertModelProviderResponse;

    // Trigger reload after successful creation
    set(internalReloadModelProviders$, (x) => x + 1);

    return result;
  },
);

/**
 * Delete a model provider by type.
 */
export const deleteModelProvider$ = command(
  async ({ get, set }, type: string) => {
    const fetchFn = get(fetch$);
    const response = await fetchFn(`/api/model-providers/${type}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      throw new Error(`Failed to delete model provider: ${response.status}`);
    }

    // Trigger reload after successful deletion
    set(internalReloadModelProviders$, (x) => x + 1);
  },
);
