import { UNKNOWN_PERMISSION_GRANT } from "../firewall-types";
import {
  createFirewallMetadataPolicyResolver,
  type FirewallMetadataPolicyResolver,
} from "./policy-resolver";
import { BUILTIN_FIREWALL_FIXED_HOST_OWNERS } from "./server.generated";
import { FIREWALL_PERMISSION_METADATA_SUMMARIES } from "./summary.generated";
import type {
  FirewallPermissionDefaultPolicyMetadata,
  FirewallPermissionDetailMetadata,
  FirewallPermissionSummaryMetadata,
} from "./types";

export type FirewallServerMetadataConnectorType =
  keyof typeof FIREWALL_PERMISSION_METADATA_SUMMARIES;

export interface BuiltinConnectorHostOwner {
  readonly type: FirewallServerMetadataConnectorType;
  readonly label: string;
}

export interface FirewallPermissionIndex {
  readonly type: FirewallPermissionDetailMetadata["type"];
  readonly label: string;
  readonly permissionNames: ReadonlySet<string>;
  readonly permissionDescriptions: ReadonlyMap<string, string>;
  readonly defaultPolicy: FirewallPermissionDefaultPolicyMetadata;
  readonly unknownPolicy: FirewallPermissionDefaultPolicyMetadata["unknownPolicy"];
  readonly policyResolver: FirewallMetadataPolicyResolver;
  hasPermission(name: string): boolean;
  permissionDescription(name: string): string | null;
}

const permissionIndexCache = new Map<
  FirewallServerMetadataConnectorType,
  Promise<FirewallPermissionIndex>
>();
const builtinFirewallFixedHostOwnerLookup: Readonly<
  Record<string, FirewallPermissionSummaryMetadata["type"]>
> = BUILTIN_FIREWALL_FIXED_HOST_OWNERS;

export function isFirewallServerMetadataConnectorType(
  type: string,
): type is FirewallServerMetadataConnectorType {
  return Object.prototype.hasOwnProperty.call(
    FIREWALL_PERMISSION_METADATA_SUMMARIES,
    type,
  );
}

export function getFirewallServerMetadataSummary(
  type: string,
): FirewallPermissionSummaryMetadata | null {
  if (!isFirewallServerMetadataConnectorType(type)) {
    return null;
  }
  return FIREWALL_PERMISSION_METADATA_SUMMARIES[type];
}

export function getBuiltinConnectorHostOwner(
  host: string,
): BuiltinConnectorHostOwner | null {
  const type = builtinFirewallFixedHostOwnerLookup[host];
  if (!type || !isFirewallServerMetadataConnectorType(type)) {
    return null;
  }
  return {
    type,
    label: FIREWALL_PERMISSION_METADATA_SUMMARIES[type].label,
  };
}

async function loadFirewallPermissionDetail(
  type: FirewallServerMetadataConnectorType,
): Promise<FirewallPermissionDetailMetadata> {
  const { loadGeneratedFirewallPermissionMetadata } =
    await import("./loader.generated");
  const detail = await loadGeneratedFirewallPermissionMetadata(type);
  if (!detail) {
    throw new Error(`Missing firewall permission metadata: ${type}`);
  }
  return detail;
}

function buildFirewallPermissionIndex(
  detail: FirewallPermissionDetailMetadata,
): FirewallPermissionIndex {
  const permissionNames = new Set<string>();
  const permissionDescriptions = new Map<string, string>();

  for (const permission of detail.permissions) {
    if (permission.name === UNKNOWN_PERMISSION_GRANT) {
      continue;
    }
    permissionNames.add(permission.name);
    if (permission.description !== undefined) {
      permissionDescriptions.set(permission.name, permission.description);
    }
  }

  return {
    type: detail.type,
    label: detail.label,
    permissionNames,
    permissionDescriptions,
    defaultPolicy: detail.defaultPolicy,
    unknownPolicy: detail.defaultPolicy.unknownPolicy,
    policyResolver: createFirewallMetadataPolicyResolver(detail),
    hasPermission: (name) => {
      return permissionNames.has(name);
    },
    permissionDescription: (name) => {
      return permissionDescriptions.get(name) ?? null;
    },
  };
}

export async function loadFirewallPermissionIndex(
  type: string,
): Promise<FirewallPermissionIndex | null> {
  if (!isFirewallServerMetadataConnectorType(type)) {
    return null;
  }

  const cached = permissionIndexCache.get(type);
  if (cached) {
    return await cached;
  }

  const load = loadFirewallPermissionDetail(type)
    .then((detail) => {
      return buildFirewallPermissionIndex(detail);
    })
    .catch((error: unknown) => {
      permissionIndexCache.delete(type);
      throw error;
    });
  permissionIndexCache.set(type, load);
  return await load;
}
