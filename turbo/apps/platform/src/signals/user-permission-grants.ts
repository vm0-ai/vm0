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
import type {
  PlatformConnectorPermissionMetadata,
  PlatformUserPermissionGrant,
} from "./connector-domain.ts";

export function isActiveUserPermissionGrant(
  grant: Pick<PlatformUserPermissionGrant, "expiresAt">,
  checkedAtMs = now(),
): boolean {
  if (grant.expiresAt === null) {
    return true;
  }
  const expiresAtMs = Date.parse(grant.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs > checkedAtMs;
}

function activeUserPermissionGrants(
  grants: readonly PlatformUserPermissionGrant[],
  checkedAtMs = now(),
): readonly PlatformUserPermissionGrant[] {
  return grants.filter((grant) => {
    return isActiveUserPermissionGrant(grant, checkedAtMs);
  });
}

function userPermissionGrantsToActiveFirewallPolicies(
  grants: readonly PlatformUserPermissionGrant[],
  checkedAtMs = now(),
): FirewallPolicies | null {
  return permissionGrantsToFirewallPolicies(
    activeUserPermissionGrants(grants, checkedAtMs).map(
      ({ connectorSlug, ...grant }) => {
        return { ...grant, connectorRef: connectorSlug };
      },
    ),
  );
}

export function activeUserPermissionGrantSnapshot(
  grants: readonly PlatformUserPermissionGrant[],
  checkedAtMs = now(),
): {
  readonly grants: readonly PlatformUserPermissionGrant[];
  readonly policies: FirewallPolicies | null;
} {
  const activeGrants = activeUserPermissionGrants(grants, checkedAtMs);
  return {
    grants: activeGrants,
    policies: permissionGrantsToFirewallPolicies(
      activeGrants.map(({ connectorSlug, ...grant }) => {
        return { ...grant, connectorRef: connectorSlug };
      }),
    ),
  };
}

export function resolveActiveUserPermissionGrantPolicy(
  grants: readonly PlatformUserPermissionGrant[],
  metadata: PlatformConnectorPermissionMetadata,
  permission: string,
  checkedAtMs = now(),
): FirewallPolicyValue | undefined {
  const policies = resolveFirewallMetadataPolicies(
    userPermissionGrantsToActiveFirewallPolicies(grants, checkedAtMs),
    [
      {
        ...metadata,
        connectorRef: metadata.connectorSlug,
      },
    ],
  )?.[metadata.connectorSlug];
  return permission === UNKNOWN_PERMISSION_GRANT
    ? policies?.unknownPolicy
    : policies?.policies[permission];
}
