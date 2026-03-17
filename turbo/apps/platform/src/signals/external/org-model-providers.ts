import { command, computed, state } from "ccstate";
import { fetch$ } from "../fetch";
import type {
  ModelProviderListResponse,
  UpsertModelProviderRequest,
  UpsertModelProviderResponse,
} from "@vm0/core";

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
  const fetchFn = get(fetch$);
  const resp = await fetchFn("/api/org/model-providers");
  return (await resp.json()) as ModelProviderListResponse;
});

/**
 * Create or update an org model provider (admin only).
 */
export const createOrgModelProvider$ = command(
  async ({ get, set }, request: UpsertModelProviderRequest) => {
    const fetchFn = get(fetch$);
    const response = await fetchFn("/api/org/model-providers", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to create org model provider: ${response.status}`,
      );
    }

    const result = (await response.json()) as UpsertModelProviderResponse;

    set(internalReloadOrgModelProviders$, (x) => x + 1);

    return result;
  },
);

/**
 * Set an org model provider as the default (admin only).
 */
export const setDefaultOrgModelProvider$ = command(
  async ({ get, set }, type: string) => {
    const fetchFn = get(fetch$);
    const response = await fetchFn(
      `/api/org/model-providers/${type}/set-default`,
      { method: "POST" },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to set default org model provider: ${response.status}`,
      );
    }

    set(internalReloadOrgModelProviders$, (x) => x + 1);
  },
);

/**
 * Delete an org model provider by type (admin only).
 */
export const deleteOrgModelProvider$ = command(
  async ({ get, set }, type: string) => {
    const fetchFn = get(fetch$);
    const response = await fetchFn(`/api/org/model-providers/${type}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      throw new Error(
        `Failed to delete org model provider: ${response.status}`,
      );
    }

    set(internalReloadOrgModelProviders$, (x) => x + 1);
  },
);
