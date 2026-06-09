import type {
  UserPermissionGrantExpiresIn,
  UserPermissionGrantResponse,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import {
  UNKNOWN_PERMISSION_GRANT,
  type FirewallPolicyValue,
} from "@vm0/connectors/firewall-types";

import type { PermissionPolicy } from "../../../../signals/zero-page/settings/permissions.ts";

interface PermissionGrantFingerprint {
  readonly permission: string;
  readonly action: UserPermissionGrantResponse["action"];
  readonly expiration: string;
}

function permissionPoliciesEqual(
  a: Record<string, PermissionPolicy>,
  b: Record<string, PermissionPolicy>,
): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) {
    return false;
  }
  for (const key of aKeys) {
    if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}

export function connectorDraftDiffersFromDefault({
  currentPolicies,
  defaultPolicies,
  currentUnknownPolicy,
  defaultUnknownPolicy,
}: {
  currentPolicies: Record<string, PermissionPolicy> | undefined;
  defaultPolicies: Record<string, PermissionPolicy>;
  currentUnknownPolicy: FirewallPolicyValue;
  defaultUnknownPolicy: FirewallPolicyValue;
}): boolean {
  if (currentPolicies === undefined) {
    return false;
  }
  if (currentUnknownPolicy !== defaultUnknownPolicy) {
    return true;
  }
  return !permissionPoliciesEqual(currentPolicies, defaultPolicies);
}

function grantExpirationFingerprint(
  grant: UserPermissionGrantResponse,
): string {
  return grant.action === "allow" && grant.expiresAt
    ? `at:${grant.expiresAt}`
    : "always";
}

function selectedExpirationFingerprint(
  action: UserPermissionGrantResponse["action"],
  expirationEnabled: boolean,
  selected: UserPermissionGrantExpiresIn | undefined,
): string {
  return action === "allow" &&
    expirationEnabled &&
    selected !== undefined &&
    selected !== "always"
    ? `duration:${selected}`
    : "always";
}

function grantAction(
  policy: FirewallPolicyValue,
): UserPermissionGrantResponse["action"] | null {
  switch (policy) {
    case "allow":
    case "deny": {
      return policy;
    }
    case "ask": {
      return null;
    }
  }
}

function comparePermissionGrantFingerprints(
  a: PermissionGrantFingerprint,
  b: PermissionGrantFingerprint,
): number {
  const permissionCompare = a.permission.localeCompare(b.permission);
  if (permissionCompare !== 0) {
    return permissionCompare;
  }
  const actionCompare = a.action.localeCompare(b.action);
  if (actionCompare !== 0) {
    return actionCompare;
  }
  return a.expiration.localeCompare(b.expiration);
}

function currentPermissionGrantFingerprint({
  permission,
  currentPolicy,
  defaultPolicy,
  selected,
  expirationEnabled,
}: {
  permission: string;
  currentPolicy: FirewallPolicyValue;
  defaultPolicy: FirewallPolicyValue;
  selected: UserPermissionGrantExpiresIn | undefined;
  expirationEnabled: boolean;
}): PermissionGrantFingerprint | null {
  const currentAction = grantAction(currentPolicy);
  const defaultAction = grantAction(defaultPolicy);
  if (!currentAction || !defaultAction) {
    return null;
  }
  const hasExpiringDefaultAllowGrant =
    currentAction === "allow" &&
    currentAction === defaultAction &&
    expirationEnabled &&
    selected !== undefined &&
    selected !== "always";
  if (currentAction === defaultAction && !hasExpiringDefaultAllowGrant) {
    return null;
  }
  return {
    permission,
    action: currentAction,
    expiration: selectedExpirationFingerprint(
      currentAction,
      expirationEnabled,
      selected,
    ),
  };
}

function currentConnectorGrantFingerprints({
  permissionNames,
  policies,
  unknownPolicy,
  defaultPolicies,
  defaultUnknownPolicy,
  expirationEnabled,
  selections,
}: {
  permissionNames: readonly string[];
  policies: Record<string, PermissionPolicy>;
  unknownPolicy: FirewallPolicyValue;
  defaultPolicies: Record<string, PermissionPolicy>;
  defaultUnknownPolicy: FirewallPolicyValue;
  expirationEnabled: boolean;
  selections: Readonly<Record<string, UserPermissionGrantExpiresIn>>;
}): readonly PermissionGrantFingerprint[] {
  const fingerprints: PermissionGrantFingerprint[] = [];
  for (const name of permissionNames) {
    const fingerprint = currentPermissionGrantFingerprint({
      permission: name,
      currentPolicy: policies[name] ?? defaultPolicies[name] ?? "allow",
      defaultPolicy: defaultPolicies[name] ?? "allow",
      selected: selections[name],
      expirationEnabled,
    });
    if (fingerprint) {
      fingerprints.push(fingerprint);
    }
  }
  const unknownFingerprint = currentPermissionGrantFingerprint({
    permission: UNKNOWN_PERMISSION_GRANT,
    currentPolicy: unknownPolicy,
    defaultPolicy: defaultUnknownPolicy,
    selected: selections[UNKNOWN_PERMISSION_GRANT],
    expirationEnabled,
  });
  if (unknownFingerprint) {
    fingerprints.push(unknownFingerprint);
  }
  return fingerprints.sort(comparePermissionGrantFingerprints);
}

function explicitGrantFingerprints(
  explicitGrants: Map<string, UserPermissionGrantResponse>,
): readonly PermissionGrantFingerprint[] {
  return [...explicitGrants.entries()]
    .map(([permission, grant]) => {
      return {
        permission,
        action: grant.action,
        expiration: grantExpirationFingerprint(grant),
      };
    })
    .sort(comparePermissionGrantFingerprints);
}

function permissionGrantFingerprintsEqual(
  a: readonly PermissionGrantFingerprint[],
  b: readonly PermissionGrantFingerprint[],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((item, index) => {
    const other = b[index];
    return (
      item.permission === other.permission &&
      item.action === other.action &&
      item.expiration === other.expiration
    );
  });
}

export function hasConnectorResetPersistedEffect({
  resetPending,
  explicitGrants,
  permissionNames,
  policies,
  unknownPolicy,
  defaultPolicies,
  defaultUnknownPolicy,
  expirationEnabled,
  selections,
}: {
  resetPending: boolean;
  explicitGrants: Map<string, UserPermissionGrantResponse>;
  permissionNames: readonly string[];
  policies: Record<string, PermissionPolicy>;
  unknownPolicy: FirewallPolicyValue;
  defaultPolicies: Record<string, PermissionPolicy>;
  defaultUnknownPolicy: FirewallPolicyValue;
  expirationEnabled: boolean;
  selections: Readonly<Record<string, UserPermissionGrantExpiresIn>>;
}): boolean {
  if (!resetPending) {
    return false;
  }
  const initialFingerprints = explicitGrantFingerprints(explicitGrants);
  const currentFingerprints = currentConnectorGrantFingerprints({
    permissionNames,
    policies,
    unknownPolicy,
    defaultPolicies,
    defaultUnknownPolicy,
    expirationEnabled,
    selections,
  });
  return !permissionGrantFingerprintsEqual(
    initialFingerprints,
    currentFingerprints,
  );
}
