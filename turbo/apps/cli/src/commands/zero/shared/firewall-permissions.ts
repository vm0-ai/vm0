import {
  findFirewallMetadataPermission,
  permissionGrantsToFirewallPolicies,
  resolveFirewallMetadataPolicies,
} from "@vm0/connectors/firewall-metadata/policy";
import type {
  FirewallPolicies,
  FirewallPolicyValue,
} from "@vm0/connectors/firewall-types";
import { getZeroConnectorCatalogPermissions } from "../../../lib/api";
import type { ZeroUserPermissionGrant } from "../../../lib/api/domains/zero-agents";
import type { ZeroConnectorCatalogPermissionDetail } from "../../../lib/api/domains/zero-connectors";

export interface ConnectorPermissionInfo {
  readonly connectorSlug: string;
  readonly hasPermissions: boolean;
  readonly hasPolicyEntry: boolean;
  readonly permissions: readonly ZeroConnectorCatalogPermissionDetail["permissions"][number][];
  readonly policies: Readonly<Record<string, FirewallPolicyValue>> | null;
  readonly unknownPolicy: FirewallPolicyValue;
  readonly allowed: number;
  readonly total: number;
}

type PermissionMetadataBySlug = Map<
  string,
  ZeroConnectorCatalogPermissionDetail | null
>;

async function loadPermissionMetadataBySlug(
  connectorSlugs: readonly string[],
): Promise<PermissionMetadataBySlug> {
  const uniqueConnectorSlugs = [...new Set(connectorSlugs)];
  const entries = await Promise.all(
    uniqueConnectorSlugs.map(async (connectorSlug) => {
      return [
        connectorSlug,
        await getZeroConnectorCatalogPermissions(connectorSlug),
      ] as const;
    }),
  );
  return new Map(entries);
}

function connectorPermissionInfo(args: {
  readonly connectorSlug: string;
  readonly metadata: ZeroConnectorCatalogPermissionDetail | null;
  readonly resolvedPolicies: FirewallPolicies | null;
}): ConnectorPermissionInfo {
  if (!args.metadata) {
    return {
      connectorSlug: args.connectorSlug,
      hasPermissions: false,
      hasPolicyEntry: false,
      permissions: [],
      policies: null,
      unknownPolicy: "allow",
      allowed: 0,
      total: 0,
    };
  }

  const connectorPolicy = args.resolvedPolicies?.[args.metadata.connectorSlug];
  const policies =
    connectorPolicy && Object.keys(connectorPolicy.policies).length > 0
      ? connectorPolicy.policies
      : null;
  const total = args.metadata.permissions.length;
  const allowed = policies
    ? args.metadata.permissions.filter((permission) => {
        return policies[permission.name] === "allow";
      }).length
    : 0;

  return {
    connectorSlug: args.connectorSlug,
    hasPermissions: true,
    hasPolicyEntry: connectorPolicy !== undefined,
    permissions: args.metadata.permissions,
    policies,
    unknownPolicy: connectorPolicy?.unknownPolicy ?? "allow",
    allowed,
    total,
  };
}

export async function loadConnectorPermissionInfos(args: {
  readonly displayConnectorSlugs: readonly string[];
  readonly defaultPolicyConnectorSlugs: readonly string[];
  readonly storedPolicies: FirewallPolicies | null;
}): Promise<ConnectorPermissionInfo[]> {
  const metadataBySlug = await loadPermissionMetadataBySlug([
    ...args.displayConnectorSlugs,
    ...args.defaultPolicyConnectorSlugs,
  ]);
  const defaultPolicyMetadata = args.defaultPolicyConnectorSlugs.flatMap(
    (connectorSlug) => {
      const metadata = metadataBySlug.get(connectorSlug);
      return metadata ? [metadata] : [];
    },
  );
  const resolvedPolicies = resolveFirewallMetadataPolicies(
    args.storedPolicies,
    defaultPolicyMetadata.map(({ connectorSlug, ...metadata }) => {
      return { ...metadata, connectorRef: connectorSlug };
    }),
  );

  return args.displayConnectorSlugs.map((connectorSlug) => {
    return connectorPermissionInfo({
      connectorSlug,
      metadata: metadataBySlug.get(connectorSlug) ?? null,
      resolvedPolicies,
    });
  });
}

export function connectorPermissionGrantsToFirewallPolicies(
  grants: readonly ZeroUserPermissionGrant[],
): FirewallPolicies | null {
  return permissionGrantsToFirewallPolicies(
    grants.map(({ connectorSlug, ...grant }) => {
      return { ...grant, connectorRef: connectorSlug };
    }),
  );
}

export function hasConnectorFirewallMetadataPermission(
  metadata: ZeroConnectorCatalogPermissionDetail,
  permission: string,
): boolean {
  return (
    findFirewallMetadataPermission(
      { ...metadata, connectorRef: metadata.connectorSlug },
      permission,
    ) !== null
  );
}
