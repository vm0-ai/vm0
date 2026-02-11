import { command, computed, state } from "ccstate";
import { fetch$ } from "../fetch";
import type { ConnectorListResponse } from "@vm0/core";

/**
 * Reload trigger for connector signals.
 * Increment to force recomputation of connectors$.
 */
const internalReloadConnectors$ = state(0);

/**
 * Current user's connectors.
 */
export const connectors$ = computed(async (get) => {
  get(internalReloadConnectors$);
  const fetchFn = get(fetch$);
  const resp = await fetchFn("/api/connectors");
  return (await resp.json()) as ConnectorListResponse;
});

/**
 * Trigger a reload of connectors data.
 */
export const reloadConnectors$ = command(({ set }) => {
  set(internalReloadConnectors$, (x) => x + 1);
});

/**
 * Delete a connector by type.
 */
export const deleteConnector$ = command(async ({ get, set }, type: string) => {
  const fetchFn = get(fetch$);
  const response = await fetchFn(`/api/connectors/${type}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error(`Failed to delete connector: ${response.status}`);
  }

  set(internalReloadConnectors$, (x) => x + 1);
});
