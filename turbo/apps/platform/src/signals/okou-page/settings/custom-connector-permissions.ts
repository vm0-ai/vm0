import { command, computed, state } from "ccstate";
import {
  customConnectorByIdContract,
  type CustomConnectorPermissionBundleResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { agentCustomConnectorsContract } from "@okouai/api-contracts/contracts/agent-custom-connectors";

import { apiClient$ } from "../../api-client.ts";
import { accept } from "../../../lib/accept.ts";
import { withCleanup } from "../../utils.ts";
import { reloadCustomConnectorAuthorizedAgents$ } from "./custom-connectors.ts";

type CustomConnectorPermissionSurface = "agent-detail" | "access-management";

interface CustomConnectorPermissionTarget {
  readonly surface: CustomConnectorPermissionSurface;
  readonly agentId: string;
  readonly connectorId: string;
}

export interface CustomConnectorPermissionDraft {
  readonly surface: CustomConnectorPermissionSurface;
  readonly agentId: string;
  readonly connectorId: string;
  readonly initiallyAuthorized: boolean;
  readonly initialPermissionNames: readonly string[];
  readonly permissionNames: readonly string[];
}

const internalPermissionTarget$ = state<CustomConnectorPermissionTarget | null>(
  null,
);
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
      readonly surface: CustomConnectorPermissionSurface;
      readonly agentId: string;
      readonly connectorId: string;
      readonly initiallyAuthorized: boolean;
      readonly permissionNames: readonly string[];
    },
  ): void => {
    set(internalPermissionTarget$, {
      surface: args.surface,
      agentId: args.agentId,
      connectorId: args.connectorId,
    });
    set(internalPermissionDraft$, {
      surface: args.surface,
      agentId: args.agentId,
      connectorId: args.connectorId,
      initiallyAuthorized: args.initiallyAuthorized,
      initialPermissionNames: [...args.permissionNames],
      permissionNames: [...args.permissionNames],
    });
  },
);

export const closeCustomConnectorPermissions$ = command(
  (
    { set },
    args: {
      readonly surface: CustomConnectorPermissionSurface;
      readonly agentId: string;
      readonly connectorId: string;
    },
  ): void => {
    set(internalPermissionTarget$, (current) => {
      return current?.surface === args.surface &&
        current.agentId === args.agentId &&
        current.connectorId === args.connectorId
        ? null
        : current;
    });
    set(internalPermissionDraft$, (current) => {
      return current?.surface === args.surface &&
        current.agentId === args.agentId &&
        current.connectorId === args.connectorId
        ? null
        : current;
    });
  },
);

export const setCustomConnectorPermissionDraftValue$ = command(
  (
    { set },
    args: {
      readonly agentId: string;
      readonly connectorId: string;
      readonly permissionName: string;
      readonly allow: boolean;
    },
  ): void => {
    set(internalPermissionDraft$, (current) => {
      if (
        current?.agentId !== args.agentId ||
        current.connectorId !== args.connectorId
      ) {
        return current;
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

export const customConnectorPermissionBundle$ = computed(
  async (get): Promise<CustomConnectorPermissionBundleResponse | null> => {
    const target = get(internalPermissionTarget$);
    if (!target) {
      return null;
    }
    const client = get(apiClient$)(customConnectorByIdContract);
    const result = await accept(
      client.permissions({ params: { id: target.connectorId } }),
      [200, 404],
    );
    return result.status === 200 ? result.body : null;
  },
);

export const saveCustomConnectorPermissions$ = command(
  async (
    { get, set },
    args: {
      readonly agentId: string;
      readonly connectorId: string;
      readonly permissionNames: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(apiClient$)(agentCustomConnectorsContract);
    await withCleanup(
      accept(
        client.update({
          params: { id: args.agentId },
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
        set(reloadCustomConnectorAuthorizedAgents$);
      },
    );
    signal.throwIfAborted();
  },
);
