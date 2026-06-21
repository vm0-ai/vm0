import {
  UNKNOWN_PERMISSION_GRANT,
  type FirewallPolicies,
  type FirewallPolicyValue,
} from "../firewall-types";
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

function trimTrailingDots(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 46) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function stripHostnameTrailingDot(host: string): string {
  const portStart = host.startsWith("[") ? -1 : host.lastIndexOf(":");
  if (portStart === -1) {
    return trimTrailingDots(host);
  }

  const hostname = trimTrailingDots(host.slice(0, portStart));
  return `${hostname}${host.slice(portStart)}`;
}

function normalizeBuiltinConnectorHostLookupKey(host: string): string | null {
  const trimmedHost = host.trim();
  if (trimmedHost.length === 0) {
    return null;
  }

  try {
    const url = trimmedHost.includes("://")
      ? new URL(trimmedHost)
      : new URL(`https://${trimmedHost}`);
    return stripHostnameTrailingDot(url.host.toLowerCase());
  } catch {
    return stripHostnameTrailingDot(trimmedHost.toLowerCase());
  }
}

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
  const normalizedHost = normalizeBuiltinConnectorHostLookupKey(host);
  if (!normalizedHost) {
    return null;
  }

  const type = Object.prototype.hasOwnProperty.call(
    builtinFirewallFixedHostOwnerLookup,
    normalizedHost,
  )
    ? builtinFirewallFixedHostOwnerLookup[normalizedHost]
    : undefined;
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
  if (detail.type !== type) {
    throw new Error(
      `Mismatched firewall permission metadata: requested ${type}, got ${detail.type}`,
    );
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

function expandDefaultPolicy(index: FirewallPermissionIndex): {
  readonly policies: Record<string, FirewallPolicyValue>;
  readonly unknownPolicy: FirewallPolicyValue;
} {
  const policies: Record<string, FirewallPolicyValue> = {};
  for (const name of index.permissionNames) {
    policies[name] = index.policyResolver.permission(name);
  }
  return {
    policies,
    unknownPolicy: index.policyResolver.unknown(),
  };
}

export async function resolveFirewallServerMetadataPolicies(
  stored: FirewallPolicies | null,
  connectors: readonly string[],
): Promise<FirewallPolicies | null> {
  let resolved: FirewallPolicies | null = stored;

  for (const connector of connectors) {
    const index = await loadFirewallPermissionIndex(connector);
    if (!index) {
      continue;
    }

    const defaults = expandDefaultPolicy(index);
    const existing = resolved?.[index.type];
    resolved = {
      ...(resolved ?? {}),
      [index.type]: {
        policies: { ...defaults.policies, ...existing?.policies },
        ...(existing?.unknownPolicy !== undefined
          ? { unknownPolicy: existing.unknownPolicy }
          : { unknownPolicy: defaults.unknownPolicy }),
      },
    };
  }

  return resolved;
}
