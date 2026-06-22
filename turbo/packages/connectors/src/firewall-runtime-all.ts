import { CONNECTOR_TYPES } from "./connectors";
import type { FirewallConfig } from "./firewall-types";
import {
  getConnectorFirewall,
  isFirewallConnectorType,
  type FirewallConnectorType,
} from "./firewalls";

let connectorFirewalls: Readonly<
  Record<FirewallConnectorType, FirewallConfig>
> | null = null;

export function getAllConnectorFirewalls(): Readonly<
  Record<FirewallConnectorType, FirewallConfig>
> {
  if (connectorFirewalls === null) {
    connectorFirewalls = Object.fromEntries(
      Object.keys(CONNECTOR_TYPES)
        .filter(isFirewallConnectorType)
        .map((type) => {
          return [type, getConnectorFirewall(type)];
        }),
    ) as Record<FirewallConnectorType, FirewallConfig>;
  }

  return connectorFirewalls;
}
