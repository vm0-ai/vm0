import { command, computed, state, type Command, type Computed } from "ccstate";
import type { ZeroAgentResponse } from "@vm0/api-contracts/contracts/zero-agents";
import type { UserPermissionGrantResponse } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import type { PublicConnectorCatalogPermissionDetail } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { agentById } from "../agent.ts";
import { firewallPermissionMetadataByConnector } from "../firewall-permission-metadata.ts";
import { userPermissionGrantsByAgent } from "../permission-allow/permission-allow-signals.ts";
import type { PermissionActionBlock } from "./permission-action-block.ts";

/**
 * Reactive resources backing one rendered permission action card. Created once
 * per normalized permission URL (`PermissionActionBlock.href`) and held by the
 * thread-scoped registry, so card components keep stable signal identities
 * across transcript re-evaluations.
 */
export interface PermissionCardSignals {
  readonly agent$: Computed<Promise<ZeroAgentResponse>>;
  readonly grants$: Computed<Promise<readonly UserPermissionGrantResponse[]>>;
  readonly metadata$: Computed<
    Promise<PublicConnectorCatalogPermissionDetail | null>
  >;
}

export interface PermissionCardRegistrySignals {
  readonly permissionCardSignalsByUrl$: Computed<
    ReadonlyMap<string, PermissionCardSignals>
  >;
  readonly registerPermissionCardBlocks$: Command<
    void,
    [readonly PermissionActionBlock[]]
  >;
}

/**
 * Thread-scoped registry of permission card signals keyed by normalized
 * permission URL. Entries are inserted by `registerPermissionCardBlocks$` when
 * persistent messages are written; the registry intentionally never removes
 * entries because a URL's signals are immutable for the thread's lifetime.
 */
export function createPermissionCardRegistry(): PermissionCardRegistrySignals {
  const internalSignalsByUrl$ = state<
    ReadonlyMap<string, PermissionCardSignals>
  >(new Map());

  const permissionCardSignalsByUrl$ = computed((get) => {
    return get(internalSignalsByUrl$);
  });

  const registerPermissionCardBlocks$ = command(
    ({ get, set }, blocks: readonly PermissionActionBlock[]) => {
      const current = get(internalSignalsByUrl$);
      let next: Map<string, PermissionCardSignals> | undefined;
      for (const block of blocks) {
        if (current.has(block.href) || next?.has(block.href)) {
          continue;
        }
        next ??= new Map(current);
        next.set(block.href, {
          agent$: agentById(block.agentId),
          grants$: userPermissionGrantsByAgent({ agentId: block.agentId }),
          metadata$: firewallPermissionMetadataByConnector({
            connectorRef: block.connectorRef,
          }),
        });
      }
      if (next !== undefined) {
        set(internalSignalsByUrl$, next);
      }
    },
  );

  return {
    permissionCardSignalsByUrl$,
    registerPermissionCardBlocks$,
  };
}
