import type {
  UserPermissionGrantExpiresIn,
  UserPermissionGrantResponse,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import {
  createFirewallMetadataPolicyResolver,
  type FirewallMetadataPolicyOverlay,
  type FirewallMetadataPolicyResolver,
  type FirewallPermissionDetailMetadata,
} from "@vm0/connectors/firewall-metadata";
import {
  UNKNOWN_PERMISSION_GRANT,
  type FirewallPolicy,
  type FirewallPolicies,
  type FirewallPolicyValue,
} from "@vm0/connectors/firewall-types";

export interface PermissionDraftIntent {
  readonly connectorPolicy: FirewallPolicyValue | undefined;
  readonly groupPolicies: Readonly<Record<string, FirewallPolicyValue>>;
  readonly permissionPolicies: Readonly<Record<string, FirewallPolicyValue>>;
  readonly restoredGroups: Readonly<Record<string, true>>;
  readonly restoredPermissions: Readonly<Record<string, true>>;
  readonly unknownPolicy: FirewallPolicyValue | undefined;
  readonly resetPending: boolean;
  readonly groupExpirations: Readonly<
    Record<string, UserPermissionGrantExpiresIn>
  >;
  readonly permissionExpirations: Readonly<
    Record<string, UserPermissionGrantExpiresIn>
  >;
  readonly unknownExpiration: UserPermissionGrantExpiresIn | undefined;
}

export interface PermissionDraftContext {
  readonly metadata: FirewallPermissionDetailMetadata;
  readonly defaultResolver: FirewallMetadataPolicyResolver;
  readonly initialResolver: FirewallMetadataPolicyResolver;
}

interface PermissionLike {
  readonly name: string;
}

interface PolicyResolutionParams {
  readonly context: PermissionDraftContext;
  readonly draft: PermissionDraftIntent;
  readonly permissionName: string;
}

interface ExpirationResolutionParams {
  readonly context: PermissionDraftContext;
  readonly draft: PermissionDraftIntent;
  readonly permissionName: string;
}

function firewallPolicyToOverlay(
  policy: FirewallPolicy | undefined,
): FirewallMetadataPolicyOverlay | undefined {
  if (!policy) {
    return undefined;
  }
  const { unknownPolicy } = policy;
  return {
    permissionOverrides: policy.policies,
    ...(unknownPolicy !== undefined ? { unknownPolicy } : {}),
  };
}

function omitKey<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): Record<string, T> {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    return { ...record };
  }
  const next = { ...record };
  delete next[key];
  return next;
}

function omitKeys<T>(
  record: Readonly<Record<string, T>>,
  keys: ReadonlySet<string>,
): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!keys.has(key)) {
      next[key] = value;
    }
  }
  return next;
}

function permissionCategory(
  metadata: FirewallPermissionDetailMetadata,
  permissionName: string,
): string | undefined {
  return metadata.categories?.categories[permissionName];
}

function resolveBasePermissionPolicy({
  context,
  draft,
  permissionName,
}: PolicyResolutionParams): FirewallPolicyValue {
  const resolver = draft.resetPending
    ? context.defaultResolver
    : context.initialResolver;
  return resolver.permission(permissionName);
}

function resolveInitialPermissionPolicy(
  context: PermissionDraftContext,
  permissionName: string,
): FirewallPolicyValue {
  return context.initialResolver.permission(permissionName);
}

export function createEmptyPermissionDraftIntent(): PermissionDraftIntent {
  return {
    connectorPolicy: undefined,
    groupPolicies: {},
    permissionPolicies: {},
    restoredGroups: {},
    restoredPermissions: {},
    unknownPolicy: undefined,
    resetPending: false,
    groupExpirations: {},
    permissionExpirations: {},
    unknownExpiration: undefined,
  };
}

export function createPermissionDraftContext({
  metadata,
  initialPolicies,
}: {
  readonly metadata: FirewallPermissionDetailMetadata;
  readonly initialPolicies: FirewallPolicies;
}): PermissionDraftContext {
  return {
    metadata,
    defaultResolver: createFirewallMetadataPolicyResolver(metadata),
    initialResolver: createFirewallMetadataPolicyResolver(
      metadata,
      firewallPolicyToOverlay(initialPolicies[metadata.type]),
    ),
  };
}

export function permissionDraftMetadataKey(
  metadata: FirewallPermissionDetailMetadata,
): string {
  return JSON.stringify({
    type: metadata.type,
    permissions: metadata.permissions.map((permission) => {
      return permission.name;
    }),
    permissionCount: metadata.permissionCount,
    defaultPolicy: metadata.defaultPolicy,
    categories: metadata.categories,
  });
}

export function explicitGrantStateKey(
  grants: Map<string, UserPermissionGrantResponse>,
): string {
  return JSON.stringify(
    [...grants.entries()]
      .map(([permission, grant]) => {
        return [permission, grant.action, grant.expiresAt] as const;
      })
      .sort((a, b) => {
        return a[0].localeCompare(b[0]);
      }),
  );
}

export function resolvePermissionDraftPolicy(
  params: PolicyResolutionParams,
): FirewallPolicyValue {
  const explicit = params.draft.permissionPolicies[params.permissionName];
  if (explicit !== undefined) {
    return explicit;
  }

  if (params.draft.restoredPermissions[params.permissionName]) {
    return resolveInitialPermissionPolicy(
      params.context,
      params.permissionName,
    );
  }

  const category = permissionCategory(
    params.context.metadata,
    params.permissionName,
  );
  if (category) {
    if (params.draft.restoredGroups[category]) {
      return resolveInitialPermissionPolicy(
        params.context,
        params.permissionName,
      );
    }

    const groupPolicy = params.draft.groupPolicies[category];
    if (groupPolicy !== undefined) {
      return groupPolicy;
    }
  }

  if (params.draft.connectorPolicy !== undefined) {
    return params.draft.connectorPolicy;
  }

  return resolveBasePermissionPolicy(params);
}

export function resolvePermissionDraftUnknownPolicy({
  context,
  draft,
}: {
  readonly context: PermissionDraftContext;
  readonly draft: PermissionDraftIntent;
}): FirewallPolicyValue {
  if (draft.unknownPolicy !== undefined) {
    return draft.unknownPolicy;
  }
  return draft.resetPending
    ? context.defaultResolver.unknown()
    : context.initialResolver.unknown();
}

export function resolvePermissionDraftListPolicy({
  context,
  draft,
  permissions,
}: {
  readonly context: PermissionDraftContext;
  readonly draft: PermissionDraftIntent;
  readonly permissions: readonly PermissionLike[];
}): FirewallPolicyValue | "mixed" {
  let first: FirewallPolicyValue | null = null;
  for (const permission of permissions) {
    const current = resolvePermissionDraftPolicy({
      context,
      draft,
      permissionName: permission.name,
    });
    if (first === null) {
      first = current;
      continue;
    }
    if (current !== first) {
      return "mixed";
    }
  }
  return first ?? "allow";
}

export function resolvePermissionDraftExpiration(
  params: ExpirationResolutionParams,
): UserPermissionGrantExpiresIn | undefined {
  const explicit = params.draft.permissionExpirations[params.permissionName];
  if (explicit !== undefined) {
    return explicit;
  }
  const category = permissionCategory(
    params.context.metadata,
    params.permissionName,
  );
  return category ? params.draft.groupExpirations[category] : undefined;
}

export function resolvePermissionDraftGroupExpiration({
  context,
  draft,
  category,
  permissions,
}: {
  readonly context: PermissionDraftContext;
  readonly draft: PermissionDraftIntent;
  readonly category: string;
  readonly permissions: readonly PermissionLike[];
}): UserPermissionGrantExpiresIn | undefined {
  const groupExpiration = draft.groupExpirations[category];
  if (groupExpiration !== undefined) {
    return groupExpiration;
  }
  if (permissions.length === 0) {
    return undefined;
  }
  const first = resolvePermissionDraftExpiration({
    context,
    draft,
    permissionName: permissions[0].name,
  });
  if (first === undefined) {
    return undefined;
  }
  for (let i = 1; i < permissions.length; i++) {
    const current = resolvePermissionDraftExpiration({
      context,
      draft,
      permissionName: permissions[i].name,
    });
    if (current !== first) {
      return undefined;
    }
  }
  return first;
}

export function setPermissionDraftPolicy({
  draft,
  permissionName,
  policy,
}: {
  readonly draft: PermissionDraftIntent;
  readonly permissionName: string;
  readonly policy: FirewallPolicyValue;
}): PermissionDraftIntent {
  return {
    ...draft,
    permissionPolicies: {
      ...draft.permissionPolicies,
      [permissionName]: policy,
    },
    restoredPermissions: omitKey(draft.restoredPermissions, permissionName),
  };
}

export function setPermissionDraftConnectorPolicy({
  draft,
  policy,
  includeUnknown,
}: {
  readonly draft: PermissionDraftIntent;
  readonly policy: FirewallPolicyValue;
  readonly includeUnknown: boolean;
}): PermissionDraftIntent {
  return {
    ...draft,
    connectorPolicy: policy,
    groupPolicies: {},
    permissionPolicies: {},
    restoredGroups: {},
    restoredPermissions: {},
    ...(includeUnknown ? { unknownPolicy: policy } : {}),
    ...(policy === "deny"
      ? {
          groupExpirations: {},
          permissionExpirations: {},
          unknownExpiration: undefined,
        }
      : {}),
  };
}

export function setPermissionDraftGroupPolicy({
  draft,
  category,
  permissions,
  policy,
}: {
  readonly draft: PermissionDraftIntent;
  readonly category: string;
  readonly permissions: readonly PermissionLike[];
  readonly policy: FirewallPolicyValue;
}): PermissionDraftIntent {
  const permissionNames = new Set(
    permissions.map((permission) => {
      return permission.name;
    }),
  );
  const nextPermissionExpirations =
    policy === "deny"
      ? Object.fromEntries(
          Object.entries(draft.permissionExpirations).filter(([name]) => {
            return !permissionNames.has(name);
          }),
        )
      : draft.permissionExpirations;

  return {
    ...draft,
    groupPolicies: {
      ...draft.groupPolicies,
      [category]: policy,
    },
    permissionPolicies: omitKeys(draft.permissionPolicies, permissionNames),
    restoredGroups: omitKey(draft.restoredGroups, category),
    restoredPermissions: omitKeys(draft.restoredPermissions, permissionNames),
    groupExpirations:
      policy === "deny"
        ? omitKey(draft.groupExpirations, category)
        : draft.groupExpirations,
    permissionExpirations: nextPermissionExpirations,
  };
}

export function restorePermissionDraftGroup({
  draft,
  category,
  permissions,
}: {
  readonly draft: PermissionDraftIntent;
  readonly category: string;
  readonly permissions: readonly PermissionLike[];
}): PermissionDraftIntent {
  const permissionNames = new Set(
    permissions.map((permission) => {
      return permission.name;
    }),
  );
  return {
    ...draft,
    groupPolicies: omitKey(draft.groupPolicies, category),
    permissionPolicies: omitKeys(draft.permissionPolicies, permissionNames),
    restoredGroups: {
      ...draft.restoredGroups,
      [category]: true,
    },
    groupExpirations: omitKey(draft.groupExpirations, category),
    permissionExpirations: omitKeys(
      draft.permissionExpirations,
      permissionNames,
    ),
    restoredPermissions: omitKeys(draft.restoredPermissions, permissionNames),
  };
}

export function restorePermissionDraftPermission({
  draft,
  permissionName,
}: {
  readonly draft: PermissionDraftIntent;
  readonly permissionName: string;
}): PermissionDraftIntent {
  return {
    ...draft,
    permissionPolicies: omitKey(draft.permissionPolicies, permissionName),
    restoredPermissions: {
      ...draft.restoredPermissions,
      [permissionName]: true,
    },
    permissionExpirations: omitKey(draft.permissionExpirations, permissionName),
  };
}

export function setPermissionDraftUnknownPolicy({
  draft,
  policy,
}: {
  readonly draft: PermissionDraftIntent;
  readonly policy: FirewallPolicyValue;
}): PermissionDraftIntent {
  return {
    ...draft,
    unknownPolicy: policy,
    ...(policy === "deny" ? { unknownExpiration: undefined } : {}),
  };
}

export function restorePermissionDraftUnknown({
  draft,
}: {
  readonly draft: PermissionDraftIntent;
}): PermissionDraftIntent {
  return {
    ...draft,
    unknownPolicy: undefined,
    unknownExpiration: undefined,
  };
}

export function stagePermissionDraftConnectorRestore({
  draft,
}: {
  readonly draft: PermissionDraftIntent;
}): PermissionDraftIntent {
  return {
    ...draft,
    connectorPolicy: undefined,
    groupPolicies: {},
    permissionPolicies: {},
    restoredGroups: {},
    restoredPermissions: {},
    unknownPolicy: undefined,
    resetPending: true,
    groupExpirations: {},
    permissionExpirations: {},
    unknownExpiration: undefined,
  };
}

export function setPermissionDraftExpiration({
  draft,
  permissionName,
  expiresIn,
}: {
  readonly draft: PermissionDraftIntent;
  readonly permissionName: string;
  readonly expiresIn: UserPermissionGrantExpiresIn | null;
}): PermissionDraftIntent {
  return {
    ...draft,
    permissionExpirations:
      expiresIn === null
        ? omitKey(draft.permissionExpirations, permissionName)
        : {
            ...draft.permissionExpirations,
            [permissionName]: expiresIn,
          },
  };
}

export function setPermissionDraftGroupExpiration({
  draft,
  category,
  expiresIn,
}: {
  readonly draft: PermissionDraftIntent;
  readonly category: string;
  readonly expiresIn: UserPermissionGrantExpiresIn | null;
}): PermissionDraftIntent {
  return {
    ...draft,
    groupExpirations:
      expiresIn === null
        ? omitKey(draft.groupExpirations, category)
        : {
            ...draft.groupExpirations,
            [category]: expiresIn,
          },
  };
}

export function setPermissionDraftUnknownExpiration({
  draft,
  expiresIn,
}: {
  readonly draft: PermissionDraftIntent;
  readonly expiresIn: UserPermissionGrantExpiresIn | null;
}): PermissionDraftIntent {
  return {
    ...draft,
    unknownExpiration: expiresIn ?? undefined,
  };
}

export function isPermissionDraftPristine(
  draft: PermissionDraftIntent,
): boolean {
  return (
    draft.connectorPolicy === undefined &&
    draft.unknownPolicy === undefined &&
    !draft.resetPending &&
    Object.keys(draft.groupPolicies).length === 0 &&
    Object.keys(draft.permissionPolicies).length === 0 &&
    Object.keys(draft.restoredGroups).length === 0 &&
    Object.keys(draft.restoredPermissions).length === 0 &&
    Object.keys(draft.groupExpirations).length === 0 &&
    Object.keys(draft.permissionExpirations).length === 0 &&
    draft.unknownExpiration === undefined
  );
}

export function hasPermissionDraftPermissionChange({
  context,
  draft,
  permissionName,
  selected,
  grant,
}: {
  readonly context: PermissionDraftContext;
  readonly draft: PermissionDraftIntent;
  readonly permissionName: string;
  readonly selected: UserPermissionGrantExpiresIn | undefined;
  readonly grant: UserPermissionGrantResponse | undefined;
}): boolean {
  const policy = resolvePermissionDraftPolicy({
    context,
    draft,
    permissionName,
  });
  if (policy !== resolveInitialPermissionPolicy(context, permissionName)) {
    return true;
  }
  if (selected === undefined || policy !== "allow") {
    return false;
  }
  if (grant?.action === "allow") {
    return selected !== "always" || Boolean(grant.expiresAt);
  }
  return selected !== "always";
}

export function hasPermissionDraftUnknownChange({
  context,
  draft,
  selected,
  grant,
}: {
  readonly context: PermissionDraftContext;
  readonly draft: PermissionDraftIntent;
  readonly selected: UserPermissionGrantExpiresIn | undefined;
  readonly grant: UserPermissionGrantResponse | undefined;
}): boolean {
  const policy = resolvePermissionDraftUnknownPolicy({ context, draft });
  if (policy !== context.initialResolver.unknown()) {
    return true;
  }
  if (selected === undefined || policy !== "allow") {
    return false;
  }
  if (grant?.action === "allow") {
    return selected !== "always" || Boolean(grant.expiresAt);
  }
  return selected !== "always";
}

export function hasPermissionDraftGroupChange({
  context,
  draft,
  permissions,
  explicitGrants,
}: {
  readonly context: PermissionDraftContext;
  readonly draft: PermissionDraftIntent;
  readonly permissions: readonly PermissionLike[];
  readonly explicitGrants: ReadonlyMap<string, UserPermissionGrantResponse>;
}): boolean {
  return permissions.some((permission) => {
    return hasPermissionDraftPermissionChange({
      context,
      draft,
      permissionName: permission.name,
      selected: resolvePermissionDraftExpiration({
        context,
        draft,
        permissionName: permission.name,
      }),
      grant: explicitGrants.get(permission.name),
    });
  });
}

export function hasAnyPermissionDraftChange({
  context,
  draft,
  permissions,
  explicitGrants,
}: {
  readonly context: PermissionDraftContext;
  readonly draft: PermissionDraftIntent;
  readonly permissions: readonly PermissionLike[];
  readonly explicitGrants: ReadonlyMap<string, UserPermissionGrantResponse>;
}): boolean {
  if (
    hasPermissionDraftUnknownChange({
      context,
      draft,
      selected: draft.unknownExpiration,
      grant: explicitGrants.get(UNKNOWN_PERMISSION_GRANT),
    })
  ) {
    return true;
  }
  return hasPermissionDraftGroupChange({
    context,
    draft,
    permissions,
    explicitGrants,
  });
}

export function hasPermissionDraftDefaultDifference({
  context,
  draft,
  permissions,
}: {
  readonly context: PermissionDraftContext;
  readonly draft: PermissionDraftIntent;
  readonly permissions: readonly PermissionLike[];
}): boolean {
  if (
    resolvePermissionDraftUnknownPolicy({ context, draft }) !==
    context.defaultResolver.unknown()
  ) {
    return true;
  }
  return permissions.some((permission) => {
    return (
      resolvePermissionDraftPolicy({
        context,
        draft,
        permissionName: permission.name,
      }) !== context.defaultResolver.permission(permission.name)
    );
  });
}

export function materializePermissionDraftForLegacySave({
  context,
  draft,
  permissions,
}: {
  readonly context: PermissionDraftContext;
  readonly draft: PermissionDraftIntent;
  readonly permissions: readonly PermissionLike[];
}): {
  readonly policies: FirewallPolicies;
  readonly expiresInByPermission: Readonly<
    Record<string, UserPermissionGrantExpiresIn>
  >;
} {
  const connectorPolicies: Record<string, FirewallPolicyValue> = {};
  const expiresInByPermission: Record<string, UserPermissionGrantExpiresIn> =
    {};
  for (const permission of permissions) {
    connectorPolicies[permission.name] = resolvePermissionDraftPolicy({
      context,
      draft,
      permissionName: permission.name,
    });
    const expiresIn = resolvePermissionDraftExpiration({
      context,
      draft,
      permissionName: permission.name,
    });
    if (expiresIn !== undefined) {
      expiresInByPermission[permission.name] = expiresIn;
    }
  }
  if (draft.unknownExpiration !== undefined) {
    expiresInByPermission[UNKNOWN_PERMISSION_GRANT] = draft.unknownExpiration;
  }

  return {
    policies: {
      [context.metadata.type]: {
        policies: connectorPolicies,
        unknownPolicy: resolvePermissionDraftUnknownPolicy({ context, draft }),
      },
    },
    expiresInByPermission,
  };
}
