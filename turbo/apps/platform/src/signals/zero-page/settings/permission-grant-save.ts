import type { PublicConnectorCatalogPermissionDetail } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import {
  UNKNOWN_PERMISSION_GRANT,
  type FirewallPolicies,
  type FirewallPolicyValue,
} from "@vm0/connectors/firewall-types";
import {
  expandFirewallMetadataDefaultPolicy,
  resolveFirewallMetadataPolicies,
} from "@vm0/connectors/firewall-metadata/policy";
import type {
  ApplyUserPermissionGrant,
  UserPermissionGrantAction,
  UserPermissionGrantExpiresIn,
  UserPermissionGrantResponse,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import {
  createPermissionDraftContext,
  materializePermissionDraftForLegacySave,
  type PermissionDraftIntent,
} from "./permission-draft-intent.ts";

export type ApplyUserPermissionGrants = (
  params: {
    agentId: string;
    connectorRef: string;
    mode: "patch" | "replace";
    grants: readonly ApplyUserPermissionGrant[];
  },
  signal: AbortSignal,
) => Promise<readonly UserPermissionGrantResponse[]>;

function userGrantAction(
  policy: FirewallPolicyValue,
): UserPermissionGrantAction {
  if (policy === "ask") {
    throw new Error("User permission grants do not support ask");
  }
  return policy;
}

type GrantExpirationSelections = Readonly<
  Record<string, UserPermissionGrantExpiresIn>
>;

interface ChangedUserGrantPolicy {
  readonly permission: string;
  readonly action: UserPermissionGrantAction;
  readonly expiresIn?: UserPermissionGrantExpiresIn;
}

function selectedGrantExpiresIn(
  expiresInByPermission: GrantExpirationSelections,
  permission: string,
  action: UserPermissionGrantAction,
): UserPermissionGrantExpiresIn | undefined {
  if (action !== "allow") {
    return undefined;
  }
  return expiresInByPermission[permission];
}

function setChangedGrantPolicy(
  changes: Map<string, ChangedUserGrantPolicy>,
  permission: string,
  action: UserPermissionGrantAction,
  expiresIn: UserPermissionGrantExpiresIn | undefined,
): void {
  changes.set(permission, {
    permission,
    action,
    ...(action === "allow" && expiresIn ? { expiresIn } : {}),
  });
}

function addNamedPolicyChanges({
  changes,
  initial,
  current,
  expiresInByPermission,
}: {
  changes: Map<string, ChangedUserGrantPolicy>;
  initial: FirewallPolicies[string] | undefined;
  current: FirewallPolicies[string] | undefined;
  expiresInByPermission: GrantExpirationSelections;
}): void {
  for (const [permission, action] of Object.entries(current?.policies ?? {})) {
    if (initial?.policies[permission] !== action) {
      const grantAction = userGrantAction(action);
      setChangedGrantPolicy(
        changes,
        permission,
        grantAction,
        selectedGrantExpiresIn(expiresInByPermission, permission, grantAction),
      );
    }
  }
}

function addUnknownPolicyChange({
  changes,
  initial,
  current,
  expiresInByPermission,
}: {
  changes: Map<string, ChangedUserGrantPolicy>;
  initial: FirewallPolicies[string] | undefined;
  current: FirewallPolicies[string] | undefined;
  expiresInByPermission: GrantExpirationSelections;
}): void {
  const unknownPolicy = current?.unknownPolicy;
  if (unknownPolicy === undefined || initial?.unknownPolicy === unknownPolicy) {
    return;
  }
  const grantAction = userGrantAction(unknownPolicy);
  setChangedGrantPolicy(
    changes,
    UNKNOWN_PERMISSION_GRANT,
    grantAction,
    selectedGrantExpiresIn(
      expiresInByPermission,
      UNKNOWN_PERMISSION_GRANT,
      grantAction,
    ),
  );
}

function addExpirationOnlyChanges({
  changes,
  connectorRef,
  initialGrants,
  current,
  expiresInByPermission,
}: {
  changes: Map<string, ChangedUserGrantPolicy>;
  connectorRef: string;
  initialGrants: readonly UserPermissionGrantResponse[];
  current: FirewallPolicies[string] | undefined;
  expiresInByPermission: GrantExpirationSelections;
}): void {
  for (const grant of initialGrants) {
    if (grant.connectorRef !== connectorRef || changes.has(grant.permission)) {
      continue;
    }
    const expiresIn = expiresInByPermission[grant.permission];
    if (!expiresIn) {
      continue;
    }
    if (expiresIn === "always" && !grant.expiresAt) {
      continue;
    }
    const currentPolicy =
      grant.permission === UNKNOWN_PERMISSION_GRANT
        ? current?.unknownPolicy
        : current?.policies[grant.permission];
    const action = userGrantAction(currentPolicy ?? grant.action);
    if (grant.action !== "allow" || action !== "allow") {
      continue;
    }
    changes.set(grant.permission, {
      permission: grant.permission,
      action,
      expiresIn,
    });
  }
}

function addDefaultAllowExpirationChanges({
  changes,
  connectorRef,
  initialGrants,
  current,
  expiresInByPermission,
}: {
  changes: Map<string, ChangedUserGrantPolicy>;
  connectorRef: string;
  initialGrants: readonly UserPermissionGrantResponse[];
  current: FirewallPolicies[string] | undefined;
  expiresInByPermission: GrantExpirationSelections;
}): void {
  const initialGrantPermissions = new Set(
    initialGrants
      .filter((grant) => {
        return grant.connectorRef === connectorRef;
      })
      .map((grant) => {
        return grant.permission;
      }),
  );
  for (const [permission, expiresIn] of Object.entries(expiresInByPermission)) {
    if (
      expiresIn === "always" ||
      changes.has(permission) ||
      initialGrantPermissions.has(permission)
    ) {
      continue;
    }
    const currentPolicy =
      permission === UNKNOWN_PERMISSION_GRANT
        ? current?.unknownPolicy
        : current?.policies[permission];
    if (currentPolicy === "ask") {
      continue;
    }
    const action = userGrantAction(currentPolicy ?? "allow");
    if (action !== "allow") {
      continue;
    }
    changes.set(permission, {
      permission,
      action,
      expiresIn,
    });
  }
}

function changedUserGrantPolicies({
  connectorRef,
  metadata,
  initialPolicies,
  initialGrants,
  policies,
  expiresInByPermission,
}: {
  connectorRef: string;
  metadata: PublicConnectorCatalogPermissionDetail;
  initialPolicies: FirewallPolicies;
  initialGrants: readonly UserPermissionGrantResponse[];
  policies: FirewallPolicies;
  expiresInByPermission: GrantExpirationSelections;
}): ChangedUserGrantPolicy[] {
  const initial = resolveFirewallMetadataPolicies(initialPolicies, [
    metadata,
  ])?.[connectorRef];
  const current = policies[connectorRef];
  const changes = new Map<string, ChangedUserGrantPolicy>();

  addNamedPolicyChanges({
    changes,
    initial,
    current,
    expiresInByPermission,
  });
  addUnknownPolicyChange({
    changes,
    initial,
    current,
    expiresInByPermission,
  });

  addExpirationOnlyChanges({
    changes,
    connectorRef,
    initialGrants,
    current,
    expiresInByPermission,
  });
  addDefaultAllowExpirationChanges({
    changes,
    connectorRef,
    initialGrants,
    current,
    expiresInByPermission,
  });

  return [...changes.values()];
}

function defaultFirewallPoliciesForConnector(
  metadata: PublicConnectorCatalogPermissionDetail,
): FirewallPolicies {
  return {
    [metadata.connectorRef]: expandFirewallMetadataDefaultPolicy(metadata),
  };
}

function applyGrantFromChangedPolicy(
  policy: ChangedUserGrantPolicy,
): ApplyUserPermissionGrant {
  return policy.action === "allow"
    ? {
        permission: policy.permission,
        action: "allow",
        ...(policy.expiresIn ? { expiresIn: policy.expiresIn } : {}),
      }
    : { permission: policy.permission, action: "deny" };
}

function buildAppliedUserGrantPolicies({
  connectorRef,
  metadata,
  initialPolicies,
  initialGrants,
  policies,
  expiresInByPermission,
  resetPending,
}: {
  connectorRef: string;
  metadata: PublicConnectorCatalogPermissionDetail;
  initialPolicies: FirewallPolicies;
  initialGrants: readonly UserPermissionGrantResponse[];
  policies: FirewallPolicies;
  expiresInByPermission: GrantExpirationSelections;
  resetPending: boolean;
}): readonly ApplyUserPermissionGrant[] {
  const basePolicies = resetPending
    ? defaultFirewallPoliciesForConnector(metadata)
    : initialPolicies;
  const baseGrants = resetPending ? [] : initialGrants;
  return changedUserGrantPolicies({
    connectorRef,
    metadata,
    initialPolicies: basePolicies,
    initialGrants: baseGrants,
    policies,
    expiresInByPermission,
  }).map(applyGrantFromChangedPolicy);
}

async function saveUserGrantPolicies({
  scope,
  connectorRef,
  metadata,
  initialPolicies,
  initialGrants,
  policies,
  expiresInByPermission,
  resetPending,
  pageSignal,
  applyGrantPolicies,
}: {
  scope: { agentId: string };
  connectorRef: string;
  metadata: PublicConnectorCatalogPermissionDetail;
  initialPolicies: FirewallPolicies;
  initialGrants: readonly UserPermissionGrantResponse[];
  policies: FirewallPolicies;
  expiresInByPermission: GrantExpirationSelections;
  resetPending: boolean;
  pageSignal: AbortSignal;
  applyGrantPolicies: ApplyUserPermissionGrants;
}): Promise<void> {
  await applyGrantPolicies(
    {
      ...scope,
      connectorRef,
      mode: resetPending ? "replace" : "patch",
      grants: buildAppliedUserGrantPolicies({
        connectorRef,
        metadata,
        initialPolicies,
        initialGrants,
        policies,
        expiresInByPermission,
        resetPending,
      }),
    },
    pageSignal,
  );
}

export async function savePermissionDraftPolicies({
  scope,
  connectorRef,
  metadata,
  initialPolicies,
  initialGrants,
  intent,
  pageSignal,
  applyGrantPolicies,
}: {
  scope: { agentId: string };
  connectorRef: string;
  metadata: PublicConnectorCatalogPermissionDetail;
  initialPolicies: FirewallPolicies;
  initialGrants: readonly UserPermissionGrantResponse[];
  intent: PermissionDraftIntent;
  pageSignal: AbortSignal;
  applyGrantPolicies: ApplyUserPermissionGrants;
}): Promise<void> {
  const { policies, expiresInByPermission } =
    materializePermissionDraftForLegacySave({
      context: createPermissionDraftContext({ metadata, initialPolicies }),
      draft: intent,
      permissions: metadata.permissions,
    });
  await saveUserGrantPolicies({
    scope,
    connectorRef,
    metadata,
    initialPolicies,
    initialGrants,
    policies,
    expiresInByPermission,
    resetPending: intent.resetPending,
    pageSignal,
    applyGrantPolicies,
  });
}
