import { command, computed, state } from "ccstate";
import {
  CONNECTOR_TYPES,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { zeroClient$ } from "../../api-client.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import { accept } from "../../../lib/accept.ts";
import { reloadAgentConnectorAuthorizations$ } from "../agent-connector-authorizations.ts";

// ---------------------------------------------------------------------------
// Agent selection
// ---------------------------------------------------------------------------

const internalSelected$ = state<Set<string>>(new Set());
export const permissionDialogSelected$ = computed((get) => {
  return get(internalSelected$);
});
export const togglePermissionDialogAgent$ = command(
  ({ get, set }, id: string) => {
    const prev = get(internalSelected$);
    const next = new Set(prev);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    set(internalSelected$, next);
  },
);

// ---------------------------------------------------------------------------
// Search filter
// ---------------------------------------------------------------------------

const internalSearch$ = state("");
export const permissionDialogSearch$ = computed((get) => {
  return get(internalSearch$);
});
export const setPermissionDialogSearch$ = command(({ set }, v: string) => {
  set(internalSearch$, v);
});

// ---------------------------------------------------------------------------
// Confirm (save) command
// ---------------------------------------------------------------------------

export const confirmPermissionDialog$ = command(
  async (
    { get, set },
    connectorType: ConnectorType,
    onClose: () => void,
    signal: AbortSignal,
  ): Promise<void> => {
    const selected = get(internalSelected$);
    if (selected.size === 0) {
      onClose();
      return;
    }
    const createClient = get(zeroClient$);
    const client = createClient(zeroUserConnectorsContract);
    await Promise.allSettled(
      [...selected].map(async (agentId) => {
        signal.throwIfAborted();
        const existing = await accept(
          client.get({
            params: { id: agentId },
            fetchOptions: { signal },
          }),
          [200],
        );
        signal.throwIfAborted();
        const current = existing.body.enabledTypes;
        if (current.includes(connectorType)) {
          return;
        }
        await accept(
          client.update({
            params: { id: agentId },
            body: { enabledTypes: [...current, connectorType] },
            fetchOptions: { signal },
          }),
          [200],
        );
      }),
    );
    signal.throwIfAborted();
    const config = CONNECTOR_TYPES[connectorType];
    toast.success(
      `${config.label} enabled for ${selected.size} agent${selected.size > 1 ? "s" : ""}`,
    );
    set(reloadAgentConnectorAuthorizations$);
    onClose();
  },
);

// ---------------------------------------------------------------------------
// Reset (called when dialog opens/closes)
// ---------------------------------------------------------------------------

export const resetPermissionDialog$ = command(({ set }) => {
  set(internalSelected$, new Set());
  set(internalSearch$, "");
});
