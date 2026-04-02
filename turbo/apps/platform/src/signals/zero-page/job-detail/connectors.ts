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

interface UserConnectorPermissionsState {
  enabledTypes: string[];
  loading: boolean;
  error: string | null;
}

const userConnectorPermissionsState$ = state<UserConnectorPermissionsState>({
  enabledTypes: [],
  loading: false,
  error: null,
});

export const fetchZeroJobUserConnectors$ = command(
  async ({ get, set }, _signal: AbortSignal) => {
    const detail = get(zeroJobDetail$);
    if (!detail?.agentId) {
      return;
    }

    set(userConnectorPermissionsState$, {
      enabledTypes: [],
      loading: true,
      error: null,
    });

    try {
      const client = get(zeroClient$)(zeroUserConnectorsContract);
      const result = await client.get({ params: { id: detail.agentId } });
      if (result.status !== 200) {
        throw new Error(
          `Failed to fetch connector permissions (${result.status})`,
        );
      }
      set(userConnectorPermissionsState$, {
        enabledTypes: result.body.enabledTypes,
        loading: false,
        error: null,
      });
    } catch (error) {
      throwIfAbort(error);
      L.error("Failed to fetch user connector permissions:", error);
      set(userConnectorPermissionsState$, {
        enabledTypes: [],
        loading: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load connector permissions",
      });
    }
  },
);

const internalAddedConnectors$ = state<string[] | null>(null);

const seededConnectors$ = computed((get) => {
  return get(userConnectorPermissionsState$).enabledTypes;
});

export const zeroJobConnectorsLoading$ = computed((get) => {
  return get(userConnectorPermissionsState$).loading;
});

export const zeroJobAddedConnectors$ = computed((get) => {
  const local = get(internalAddedConnectors$);
  if (local !== null) {
    return local;
  }
  return get(seededConnectors$);
});

export const zeroJobConnectorsDirty$ = computed((get) => {
  const local = get(internalAddedConnectors$);
  if (local === null) {
    return false;
  }
  const seeded = get(seededConnectors$);
  if (local.length !== seeded.length) {
    return true;
  }
  const sorted = [...local].sort();
  const seededSorted = [...seeded].sort();
  return sorted.some((s, i) => {
    return s !== seededSorted[i];
  });
});

export const addZeroJobConnector$ = command(({ get, set }, name: string) => {
  if (get(internalAddedConnectors$) === null) {
    set(internalAddedConnectors$, get(seededConnectors$));
  }
  set(internalAddedConnectors$, (prev) => {
    return [...(prev ?? []), name];
  });
});

export const removeZeroJobConnector$ = command(({ get, set }, name: string) => {
  if (get(internalAddedConnectors$) === null) {
    set(internalAddedConnectors$, get(seededConnectors$));
  }
  set(internalAddedConnectors$, (prev) => {
    return (prev ?? []).filter((s) => {
      return s !== name;
    });
  });
});

export const discardZeroJobConnectors$ = command(({ set }) => {
  set(internalAddedConnectors$, null);
});

/** Reset connectors state to initial values. */
export const resetConnectorsState$ = command(({ set }) => {
  set(internalAddedConnectors$, null);
  set(userConnectorPermissionsState$, {
    enabledTypes: [],
    loading: false,
    error: null,
  });
});

export const saveZeroJobConnectors$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const detail = get(zeroJobDetail$);
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
      set(userConnectorPermissionsState$, {
        enabledTypes: result.body.enabledTypes,
        loading: false,
        error: null,
      });
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
