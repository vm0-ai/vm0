import { command, computed, state } from "ccstate";
import {
  zeroAgentCustomConnectorsContract,
  type AgentCustomConnectorGrant,
  type AgentCustomConnectorResponse,
} from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import {
  zeroCustomConnectorByIdContract,
  type CustomConnectorPermissionBundleResponse,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { zeroClient$ } from "../../api-client.ts";
import { withCleanup } from "../../utils.ts";
import { accept } from "../../../lib/accept.ts";
import { agentDetail$ } from "./detail.ts";
import { reloadCustomConnectorAuthorizedAgents$ } from "../settings/custom-connectors.ts";
import { customConnectorPermissionsEnabled$ } from "../../external/feature-switch.ts";

// ---------------------------------------------------------------------------
// Per-agent custom connector authorization — mirrors connectors.ts but keyed
// on UUIDs from the org_custom_connectors table (not the built-in enum).
// ---------------------------------------------------------------------------

const internalReload$ = state(0);

const reloadAgentCustomConnectors$ = command(({ set }) => {
  set(internalReload$, (prev) => {
    return prev + 1;
  });
});

const seededCustomConnectorAccess$ = computed(
  async (get): Promise<AgentCustomConnectorResponse> => {
    get(internalReload$);
    const detail = await get(agentDetail$);
    if (!detail?.agentId) {
      return { enabledIds: [], grants: [] };
    }
    const client = get(zeroClient$)(zeroAgentCustomConnectorsContract);
    const result = await accept(
      client.get({ params: { id: detail.agentId } }),
      [200],
    );
    return result.body;
  },
);

const seededCustomConnectors$ = computed(async (get): Promise<string[]> => {
  return (await get(seededCustomConnectorAccess$)).enabledIds;
});

export const agentCustomConnectorGrants$ = computed(
  async (get): Promise<readonly AgentCustomConnectorGrant[]> => {
    return (await get(seededCustomConnectorAccess$)).grants ?? [];
  },
);

const internalPermissionTargetId$ = state<string | null>(null);

export const customConnectorPermissionTargetId$ = computed((get) => {
  return get(internalPermissionTargetId$);
});

interface CustomConnectorPermissionDraft {
  readonly connectorId: string;
  readonly initialPermissionNames: readonly string[];
  readonly permissionNames: readonly string[];
}

const internalPermissionDraft$ = state<CustomConnectorPermissionDraft | null>(
  null,
);

export const customConnectorPermissionDraft$ = computed((get) => {
  return get(internalPermissionDraft$);
});

export const openCustomConnectorPermissions$ = command(
  (
    { set },
    args: {
      readonly connectorId: string;
      readonly permissionNames: readonly string[];
    },
  ): void => {
    set(internalPermissionTargetId$, args.connectorId);
    set(internalPermissionDraft$, {
      connectorId: args.connectorId,
      initialPermissionNames: [...args.permissionNames],
      permissionNames: [...args.permissionNames],
    });
  },
);

export const closeCustomConnectorPermissions$ = command(({ set }): void => {
  set(internalPermissionTargetId$, null);
  set(internalPermissionDraft$, null);
});

export const setCustomConnectorPermissionDraftValue$ = command(
  (
    { set },
    args: { readonly permissionName: string; readonly allow: boolean },
  ): void => {
    set(internalPermissionDraft$, (current) => {
      if (!current) {
        return null;
      }
      const permissionNames = new Set(current.permissionNames);
      if (args.allow) {
        permissionNames.add(args.permissionName);
      } else {
        permissionNames.delete(args.permissionName);
      }
      return { ...current, permissionNames: [...permissionNames] };
    });
  },
);

export const agentCustomConnectorPermissionBundle$ = computed(
  async (get): Promise<CustomConnectorPermissionBundleResponse | null> => {
    if (!get(customConnectorPermissionsEnabled$)) {
      return null;
    }
    const connectorId = get(customConnectorPermissionTargetId$);
    if (!connectorId) {
      return null;
    }
    const client = get(zeroClient$)(zeroCustomConnectorByIdContract);
    const result = await accept(
      client.permissions({ params: { id: connectorId } }),
      [200, 404],
    );
    return result.status === 200 ? result.body : null;
  },
);

type CustomConnectorsDraft = {
  readonly agentId: string;
  readonly enabledIds: readonly string[];
};

const internalAdded$ = state<CustomConnectorsDraft | null>(null);
const internalToggleSaving$ = state(false);

export const agentAddedCustomConnectors$ = computed(
  async (get): Promise<string[]> => {
    const detail = await get(agentDetail$);
    if (!detail?.agentId) {
      return [];
    }
    const local = get(internalAdded$);
    if (local?.agentId === detail.agentId) {
      return [...local.enabledIds];
    }
    return await get(seededCustomConnectors$);
  },
);

export const agentCustomConnectorToggleSaving$ = computed((get): boolean => {
  return get(internalToggleSaving$);
});

const setAgentCustomConnectorDraft$ = command(
  async (
    { get, set },
    args: {
      readonly id: string;
      readonly operation: "add" | "remove";
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const detail = await get(agentDetail$);
    signal.throwIfAborted();
    if (!detail?.agentId) {
      return;
    }
    const current = get(internalAdded$);
    const base =
      current?.agentId === detail.agentId
        ? current.enabledIds
        : await get(seededCustomConnectors$);
    signal.throwIfAborted();
    const enabledIds =
      args.operation === "add"
        ? Array.from(new Set([...base, args.id]))
        : base.filter((s) => {
            return s !== args.id;
          });
    set(internalAdded$, {
      agentId: detail.agentId,
      enabledIds,
    });
  },
);

const clearAgentCustomConnectorDraft$ = command(
  ({ set }, agentId: string): void => {
    set(internalAdded$, (current) => {
      return current?.agentId === agentId ? null : current;
    });
  },
);

const addAgentCustomConnector$ = command(
  async ({ set }, id: string, signal: AbortSignal) => {
    await set(setAgentCustomConnectorDraft$, { id, operation: "add" }, signal);
  },
);

const removeAgentCustomConnector$ = command(
  async ({ set }, id: string, signal: AbortSignal) => {
    await set(
      setAgentCustomConnectorDraft$,
      { id, operation: "remove" },
      signal,
    );
  },
);

const saveAgentCustomConnectors$ = command(
  async (
    { get, set },
    id: string,
    operation: "add" | "remove",
    signal: AbortSignal,
  ) => {
    const detail = await get(agentDetail$);
    signal.throwIfAborted();
    if (!detail?.agentId) {
      throw new Error("No agent detail loaded");
    }

    const client = get(zeroClient$)(zeroAgentCustomConnectorsContract);
    await withCleanup(
      (async () => {
        await accept(
          client.update({
            params: { id: detail.agentId },
            body: { enabledIds: [id], operation },
            fetchOptions: { signal },
          }),
          [200],
        );
        signal.throwIfAborted();
      })(),
      () => {
        set(clearAgentCustomConnectorDraft$, detail.agentId);
        set(reloadAgentCustomConnectors$);
        set(reloadCustomConnectorAuthorizedAgents$);
      },
    );
  },
);

export const toggleAgentCustomConnector$ = command(
  async (
    { get, set },
    id: string,
    checked: boolean,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (get(internalToggleSaving$)) {
      return false;
    }
    set(internalToggleSaving$, true);
    await withCleanup(
      (async () => {
        if (checked) {
          await set(addAgentCustomConnector$, id, signal);
        } else {
          await set(removeAgentCustomConnector$, id, signal);
        }
        await set(
          saveAgentCustomConnectors$,
          id,
          checked ? "add" : "remove",
          signal,
        );
      })(),
      () => {
        set(internalToggleSaving$, false);
      },
    );
    signal.throwIfAborted();
    return true;
  },
);

export const saveAgentCustomConnectorPermissions$ = command(
  async (
    { get, set },
    args: {
      readonly connectorId: string;
      readonly permissionNames: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const detail = await get(agentDetail$);
    signal.throwIfAborted();
    if (!detail?.agentId) {
      throw new Error("No agent detail loaded");
    }
    const client = get(zeroClient$)(zeroAgentCustomConnectorsContract);
    await withCleanup(
      accept(
        client.update({
          params: { id: detail.agentId },
          body: {
            grants: [
              {
                customConnectorId: args.connectorId,
                permissionNames: [...args.permissionNames],
              },
            ],
            operation: "add",
          },
          fetchOptions: { signal },
        }),
        [200],
      ),
      () => {
        set(clearAgentCustomConnectorDraft$, detail.agentId);
        set(reloadAgentCustomConnectors$);
        set(reloadCustomConnectorAuthorizedAgents$);
      },
    );
    signal.throwIfAborted();
  },
);
