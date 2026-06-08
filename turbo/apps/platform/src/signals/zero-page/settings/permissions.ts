import type { ConnectorType } from "@vm0/connectors/connectors";
import {
  getConnectorFirewall,
  isFirewallConnectorType,
} from "@vm0/connectors/firewalls";
import type { FirewallPolicyValue } from "@vm0/connectors/firewall-types";

/** Check if a connector has any permissions defined. */
export function hasConnectorPermissions(type: ConnectorType): boolean {
  if (!isFirewallConnectorType(type)) {
    return false;
  }
  const config = getConnectorFirewall(type);
  return config.apis.some((api) => {
    return api.permissions && api.permissions.length > 0;
  });
}

// ---------------------------------------------------------------------------
// Permission policy: allow | deny | ask
// ---------------------------------------------------------------------------

export type PermissionPolicy = FirewallPolicyValue;
