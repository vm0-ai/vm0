import {
  loadFirewallPermissionMetadata,
  resolveFirewallMetadataPolicies,
  type FirewallPermissionDetailMetadata,
} from "@vm0/connectors/firewall-metadata";
import type {
  FirewallPolicies,
  FirewallPolicyValue,
} from "@vm0/connectors/firewall-types";

export interface ConnectorPermissionInfo {
  readonly type: string;
  readonly hasPermissions: boolean;
  readonly hasPolicyEntry: boolean;
  readonly permissions: readonly FirewallPermissionDetailMetadata["permissions"][number][];
  readonly policies: Readonly<Record<string, FirewallPolicyValue>> | null;
  readonly unknownPolicy: FirewallPolicyValue;
  readonly allowed: number;
  readonly total: number;
}

type PermissionMetadataByType = Map<
  string,
  FirewallPermissionDetailMetadata | null
>;

async function loadPermissionMetadataByType(
  types: readonly string[],
): Promise<PermissionMetadataByType> {
  const uniqueTypes = [...new Set(types)];
  const entries = await Promise.all(
    uniqueTypes.map(async (type) => {
      return [type, await loadFirewallPermissionMetadata(type)] as const;
    }),
  );
  return new Map(entries);
}

function connectorPermissionInfo(args: {
  readonly type: string;
  readonly metadata: FirewallPermissionDetailMetadata | null;
  readonly resolvedPolicies: FirewallPolicies | null;
}): ConnectorPermissionInfo {
  if (!args.metadata) {
    return {
      type: args.type,
      hasPermissions: false,
      hasPolicyEntry: false,
      permissions: [],
      policies: null,
      unknownPolicy: "allow",
      allowed: 0,
      total: 0,
    };
  }

  const refPolicy = args.resolvedPolicies?.[args.metadata.type];
  const policies =
    refPolicy && Object.keys(refPolicy.policies).length > 0
      ? refPolicy.policies
      : null;
  const total = args.metadata.permissions.length;
  const allowed = policies
    ? args.metadata.permissions.filter((permission) => {
        return policies[permission.name] === "allow";
      }).length
    : 0;

  return {
    type: args.type,
    hasPermissions: true,
    hasPolicyEntry: refPolicy !== undefined,
    permissions: args.metadata.permissions,
    policies,
    unknownPolicy: refPolicy?.unknownPolicy ?? "allow",
    allowed,
    total,
  };
}

export async function loadConnectorPermissionInfos(args: {
  readonly displayTypes: readonly string[];
  readonly defaultPolicyTypes: readonly string[];
  readonly storedPolicies: FirewallPolicies | null;
}): Promise<ConnectorPermissionInfo[]> {
  const metadataByType = await loadPermissionMetadataByType([
    ...args.displayTypes,
    ...args.defaultPolicyTypes,
  ]);
  const defaultPolicyMetadata = args.defaultPolicyTypes.flatMap((type) => {
    const metadata = metadataByType.get(type);
    return metadata ? [metadata] : [];
  });
  const resolvedPolicies = resolveFirewallMetadataPolicies(
    args.storedPolicies,
    defaultPolicyMetadata,
  );

  return args.displayTypes.map((type) => {
    return connectorPermissionInfo({
      type,
      metadata: metadataByType.get(type) ?? null,
      resolvedPolicies,
    });
  });
}
