import {
  loadConnectorFirewall,
  loadConnectorFirewalls,
  RUNTIME_FIREWALL_CONNECTOR_TYPES,
  type RuntimeFirewallConnectorType,
} from "../firewall-runtime";
import {
  expandFirewallMetadataDefaultPolicy,
  loadFirewallPermissionMetadata,
} from "../firewall-metadata";
import type { FirewallConfig, FirewallPolicy } from "../firewall-types";

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function loadRequiredConnectorFirewall(
  type: RuntimeFirewallConnectorType,
): Promise<FirewallConfig>;
export async function loadRequiredConnectorFirewall(
  type: string,
): Promise<FirewallConfig>;
export async function loadRequiredConnectorFirewall(
  type: string,
): Promise<FirewallConfig> {
  const firewall = await loadConnectorFirewall(type);
  if (!firewall) {
    throw new Error(`Missing runtime connector firewall: ${type}`);
  }
  return firewall;
}

export async function loadRuntimeFirewallEntries(): Promise<
  readonly (readonly [RuntimeFirewallConnectorType, FirewallConfig])[]
> {
  const firewalls = await loadConnectorFirewalls(
    RUNTIME_FIREWALL_CONNECTOR_TYPES,
  );
  return RUNTIME_FIREWALL_CONNECTOR_TYPES.map((type) => {
    const firewall = firewalls[type];
    if (!firewall) {
      throw new Error(`Missing runtime connector firewall: ${type}`);
    }
    return [type, firewall] as const;
  }).sort(([a], [b]) => {
    return compareStrings(a, b);
  });
}

export async function loadDefaultFirewallPolicies(
  type: RuntimeFirewallConnectorType,
): Promise<FirewallPolicy>;
export async function loadDefaultFirewallPolicies(
  type: string,
): Promise<FirewallPolicy>;
export async function loadDefaultFirewallPolicies(
  type: string,
): Promise<FirewallPolicy> {
  const metadata = await loadFirewallPermissionMetadata(type);
  if (!metadata) {
    throw new Error(`Missing firewall permission metadata: ${type}`);
  }
  return expandFirewallMetadataDefaultPolicy(metadata);
}
