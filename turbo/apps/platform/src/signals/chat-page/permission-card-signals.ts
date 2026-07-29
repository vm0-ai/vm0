import type { Computed } from "ccstate";
import type { ZeroAgentResponse } from "@vm0/api-contracts/contracts/zero-agents";
import type { UserPermissionGrantResponse } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import type { PublicConnectorCatalogPermissionDetail } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { agentById } from "../agent.ts";
import { firewallPermissionMetadataByConnector } from "../firewall-permission-metadata.ts";
import { userPermissionGrantsByAgent } from "../permission-allow/permission-allow-signals.ts";
import {
  permissionActionResourceKey,
  type PermissionActionDescriptor,
} from "./permission-action-block.ts";
import {
  getOrCreateCardSignals,
  registeredCardSignals,
} from "./card-signal-map.ts";

/**
 * Reactive resources backing one rendered permission action card. Created once
 * per normalized permission URL and held by the thread-scoped registry, so
 * card components keep stable signal identities across transcript evaluations.
 */
export interface PermissionSignals extends PermissionActionDescriptor {
  readonly href: string;
  readonly agent$: Computed<Promise<ZeroAgentResponse>>;
  readonly grants$: Computed<Promise<readonly UserPermissionGrantResponse[]>>;
  readonly metadata$: Computed<
    Promise<PublicConnectorCatalogPermissionDetail | null>
  >;
}

export interface PermissionCardSignalsRegistry {
  register(descriptor: PermissionActionDescriptor): PermissionSignals;
  resolve(resourceKey: string): PermissionSignals;
}

function createPermissionSignals(
  descriptor: PermissionActionDescriptor,
): PermissionSignals {
  return {
    ...descriptor,
    href: permissionActionResourceKey(descriptor),
    agent$: agentById(descriptor.agentId),
    grants$: userPermissionGrantsByAgent({ agentId: descriptor.agentId }),
    metadata$: firewallPermissionMetadataByConnector({
      connectorSlug: descriptor.connectorSlug,
    }),
  };
}

export function createPermissionCardSignalsRegistry(): PermissionCardSignalsRegistry {
  const signalsByResourceKey = new Map<string, PermissionSignals>();
  return {
    register(descriptor) {
      return getOrCreateCardSignals(
        signalsByResourceKey,
        permissionActionResourceKey(descriptor),
        () => {
          return createPermissionSignals(descriptor);
        },
      );
    },
    resolve(resourceKey) {
      return registeredCardSignals(signalsByResourceKey, resourceKey);
    },
  };
}
