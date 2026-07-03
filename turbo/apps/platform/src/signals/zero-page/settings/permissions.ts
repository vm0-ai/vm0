import type { ConnectorType } from "@vm0/connectors/connectors";
import { hasFirewallMetadataPermissions } from "@vm0/connectors/firewall-metadata";
import type { FirewallPolicyValue } from "@vm0/connectors/firewall-types";

/** Check if a connector has any permissions defined. */
export function hasConnectorPermissions(type: ConnectorType): boolean {
  return hasFirewallMetadataPermissions(type);
}

// ---------------------------------------------------------------------------
// Permission policy: allow | deny | ask
// ---------------------------------------------------------------------------

export type PermissionPolicy = FirewallPolicyValue;
