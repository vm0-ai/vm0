import type { Computed } from "ccstate";
import type { ZeroAgentResponse } from "@okouai/api-contracts/contracts/zero-agents";
import type {
  PlatformConnectorPermissionMetadata,
  PlatformUserPermissionGrant,
} from "../connector-domain.ts";
import { agentById } from "../agent.ts";
import { firewallPermissionMetadataByConnector } from "../firewall-permission-metadata.ts";
import { userPermissionGrantsByAgent } from "../permission-allow/permission-allow-signals.ts";
import {
  permissionActionResourceKey,
  type PermissionActionDescriptor,
} from "./permission-action-block.ts";
import {
  createCardSignalsRegistry,
  type CardSignalsRegistry,
} from "./card-signal-map.ts";

/**
 * Reactive resources backing one rendered permission action card. Created once
 * per normalized permission URL and held by the thread-scoped registry, so
 * card components keep stable signal identities across transcript evaluations.
 */
export interface PermissionSignals extends PermissionActionDescriptor {
  readonly href: string;
  readonly agent$: Computed<Promise<ZeroAgentResponse>>;
  readonly grants$: Computed<Promise<readonly PlatformUserPermissionGrant[]>>;
  readonly metadata$: Computed<
    Promise<PlatformConnectorPermissionMetadata | null>
  >;
}

type PermissionCardSignalsRegistry = CardSignalsRegistry<
  PermissionActionDescriptor,
  PermissionSignals
>;

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
  return createCardSignalsRegistry(
    permissionActionResourceKey,
    createPermissionSignals,
  );
}
