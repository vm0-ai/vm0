import { computed, type Computed } from "ccstate";
import { delay } from "signal-timers";
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

const TIMER_POLL_CEILING_MS = 60 * 60 * 1000;

function createUserPermissionGrantExpiryTimerFactory(): (
  nextExpiryMs: number | null,
) => Computed<Promise<number | null>> {
  const cache = new Map<string, Computed<Promise<number | null>>>();
  return (nextExpiryMs) => {
    const key = nextExpiryMs?.toString() ?? "none";
    const existing = cache.get(key);
    if (existing) {
      return existing;
    }

    const atom$ = computed(async () => {
      if (nextExpiryMs === null) {
        return null;
      }
      const delayMs = Math.min(
        Math.max(0, nextExpiryMs - now() + 1),
        TIMER_POLL_CEILING_MS,
      );
      await delay(delayMs);
      cache.delete(key);
      return nextExpiryMs;
    });
    cache.set(key, atom$);
    return atom$;
  };
}

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

export function nextUserPermissionGrantExpiryMs(
  grants: readonly Pick<UserPermissionGrantResponse, "expiresAt">[],
  checkedAtMs = now(),
): number | null {
  let nextExpiryMs: number | null = null;
  for (const grant of grants) {
    if (!grant.expiresAt) {
      continue;
    }
    const expiresAtMs = Date.parse(grant.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= checkedAtMs) {
      continue;
    }
    if (nextExpiryMs === null || expiresAtMs < nextExpiryMs) {
      nextExpiryMs = expiresAtMs;
    }
  }
  return nextExpiryMs;
}

export const userPermissionGrantExpiryTimer =
  createUserPermissionGrantExpiryTimerFactory();

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
