import type { PublicConnectorCatalogPermissionDetail } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import type { UserPermissionGrantResponse } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import {
  UNKNOWN_PERMISSION_GRANT,
  type FirewallPolicies,
  type FirewallPolicyValue,
} from "@vm0/connectors/firewall-types";
import {
  permissionGrantsToFirewallPolicies,
  resolveFirewallMetadataPolicies,
} from "@vm0/connectors/firewall-metadata/policy";
import { now } from "../lib/time.ts";

export function isActiveUserPermissionGrant(
  grant: Pick<UserPermissionGrantResponse, "expiresAt">,
  checkedAtMs = now(),
): boolean {
  if (grant.expiresAt === null) {
    return true;
  }
  const expiresAtMs = Date.parse(grant.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs > checkedAtMs;
}

function activeUserPermissionGrants(
  grants: readonly UserPermissionGrantResponse[],
  checkedAtMs = now(),
): readonly UserPermissionGrantResponse[] {
  return grants.filter((grant) => {
    return isActiveUserPermissionGrant(grant, checkedAtMs);
  });
}

function userPermissionGrantsToActiveFirewallPolicies(
  grants: readonly UserPermissionGrantResponse[],
  checkedAtMs = now(),
): FirewallPolicies | null {
  return permissionGrantsToFirewallPolicies(
    activeUserPermissionGrants(grants, checkedAtMs),
  );
}

export function activeUserPermissionGrantSnapshot(
  grants: readonly UserPermissionGrantResponse[],
  checkedAtMs = now(),
): {
  readonly grants: readonly UserPermissionGrantResponse[];
  readonly policies: FirewallPolicies | null;
} {
  const activeGrants = activeUserPermissionGrants(grants, checkedAtMs);
  return {
    grants: activeGrants,
    policies: permissionGrantsToFirewallPolicies(activeGrants),
  };
}

export function resolveActiveUserPermissionGrantPolicy(
  grants: readonly UserPermissionGrantResponse[],
  metadata: PublicConnectorCatalogPermissionDetail,
  permission: string,
  checkedAtMs = now(),
): FirewallPolicyValue | undefined {
  const policies = resolveFirewallMetadataPolicies(
    userPermissionGrantsToActiveFirewallPolicies(grants, checkedAtMs),
    [metadata],
  )?.[metadata.connectorRef];
  return permission === UNKNOWN_PERMISSION_GRANT
    ? policies?.unknownPolicy
    : policies?.policies[permission];
}
