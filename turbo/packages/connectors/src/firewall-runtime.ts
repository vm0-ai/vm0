import type { ConnectorType } from "./connectors";
import type { FirewallConfig } from "./firewall-types";
import {
  hasGeneratedRuntimeFirewall,
  loadGeneratedRuntimeFirewall,
  RUNTIME_FIREWALL_CONNECTOR_TYPES,
  type GeneratedRuntimeFirewallConnectorType,
} from "./firewalls/runtime-loader.generated";

export { RUNTIME_FIREWALL_CONNECTOR_TYPES };
export type RuntimeFirewallConnectorType =
  GeneratedRuntimeFirewallConnectorType;

export type RuntimeConnectorFirewallMap = Partial<
  Record<RuntimeFirewallConnectorType, FirewallConfig>
>;

const runtimeFirewallCache = new Map<
  RuntimeFirewallConnectorType,
  Promise<FirewallConfig>
>();

export function isRuntimeFirewallConnectorType(
  type: string,
): type is RuntimeFirewallConnectorType {
  return hasGeneratedRuntimeFirewall(type);
}

async function loadExpandedConnectorFirewall(
  type: RuntimeFirewallConnectorType,
): Promise<FirewallConfig> {
  const [firewall, { expandFirewallPlaceholders }] = await Promise.all([
    loadGeneratedRuntimeFirewall(type),
    import("./firewall-placeholder-expansion"),
  ]);
  return expandFirewallPlaceholders(firewall, type as ConnectorType);
}

export async function loadConnectorFirewall(
  type: RuntimeFirewallConnectorType,
): Promise<FirewallConfig>;
export async function loadConnectorFirewall(
  type: string,
): Promise<FirewallConfig | null>;
export async function loadConnectorFirewall(
  type: string,
): Promise<FirewallConfig | null> {
  if (!isRuntimeFirewallConnectorType(type)) {
    return null;
  }

  const cached = runtimeFirewallCache.get(type);
  if (cached) {
    return await cached;
  }

  const load = loadExpandedConnectorFirewall(type).catch((error: unknown) => {
    runtimeFirewallCache.delete(type);
    throw error;
  });
  runtimeFirewallCache.set(type, load);
  return await load;
}

export async function loadConnectorFirewalls(
  types: readonly string[],
): Promise<RuntimeConnectorFirewallMap> {
  const uniqueTypes = [...new Set(types)].filter(
    isRuntimeFirewallConnectorType,
  );
  const firewalls: RuntimeConnectorFirewallMap = {};
  await Promise.all(
    uniqueTypes.map(async (type) => {
      firewalls[type] = await loadConnectorFirewall(type);
    }),
  );
  return firewalls;
}
