import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { zeroUserConnectorsContract } from "@vm0/core";
import { throwIfAbort } from "../../utils.ts";
import { logger } from "../../log.ts";
import { zeroClient$ } from "../../api-client.ts";
import { zeroJobDetail$ } from "./detail.ts";
import { setSaving$ } from "./settings.ts";

const L = logger("ZeroJobDetail");

// ---------------------------------------------------------------------------
// Connectors management — user-level permissions per agent
// ---------------------------------------------------------------------------

const internalConnectorsReload$ = state(0);

const reloadJobConnectors$ = command(({ set }) => {
  set(internalConnectorsReload$, (prev) => {
    return prev + 1;
  });
});

const seededConnectors$ = computed(async (get): Promise<string[]> => {
  get(internalConnectorsReload$);
  const detail = await get(zeroJobDetail$);
  if (!detail?.agentId) {
    return [];
  }
  const client = get(zeroClient$)(zeroUserConnectorsContract);
  const result = await client.get({ params: { id: detail.agentId } });
  if (result.status !== 200) {
    throw new Error(`Failed to fetch connector permissions (${result.status})`);
  }
  return result.body.enabledTypes;
});

const internalAddedConnectors$ = state<string[] | null>(null);

export const zeroJobAddedConnectors$ = computed(
  async (get): Promise<string[]> => {
    const local = get(internalAddedConnectors$);
    if (local !== null) {
      return local;
    }
    return await get(seededConnectors$);
  },
);

export const zeroJobConnectorsDirty$ = computed(async (get) => {
  const local = get(internalAddedConnectors$);
  if (local === null) {
    return false;
  }
  const seeded = await get(seededConnectors$);
  if (local.length !== seeded.length) {
    return true;
  }
  const sorted = [...local].sort();
  const seededSorted = [...seeded].sort();
  return sorted.some((s, i) => {
    return s !== seededSorted[i];
  });
});

export const addZeroJobConnector$ = command(
  async ({ get, set }, name: string, _signal: AbortSignal) => {
    if (get(internalAddedConnectors$) === null) {
      set(internalAddedConnectors$, await get(seededConnectors$));
    }
    set(internalAddedConnectors$, (prev) => {
      return [...(prev ?? []), name];
    });
  },
);

export const removeZeroJobConnector$ = command(
  async ({ get, set }, name: string, _signal: AbortSignal) => {
    if (get(internalAddedConnectors$) === null) {
      set(internalAddedConnectors$, await get(seededConnectors$));
    }
    set(internalAddedConnectors$, (prev) => {
      return (prev ?? []).filter((s) => {
        return s !== name;
      });
    });
  },
);

export const discardZeroJobConnectors$ = command(({ set }) => {
  set(internalAddedConnectors$, null);
});

export const saveZeroJobConnectors$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const detail = await get(zeroJobDetail$);
    signal.throwIfAborted();
    if (!detail?.agentId) {
      throw new Error("No agent detail loaded");
    }

    set(setSaving$, true);
    try {
      const enabledTypes = get(internalAddedConnectors$) ?? [];
      const client = get(zeroClient$)(zeroUserConnectorsContract);
      const result = await client.update({
        params: { id: detail.agentId },
        body: { enabledTypes },
      });
      signal.throwIfAborted();

      if (result.status !== 200) {
        const errorDetail =
          result.status === 401 ||
          result.status === 403 ||
          result.status === 404
            ? result.body.error.message
            : `status ${result.status}`;
        throw new Error(`Save failed: ${errorDetail}`);
      }

      set(internalAddedConnectors$, null);
      set(reloadJobConnectors$);
      toast.success("Connectors saved");
    } catch (error) {
      throwIfAbort(error);
      L.error("Failed to save connectors:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to save connectors",
      );
    } finally {
      set(setSaving$, false);
    }
  },
);
