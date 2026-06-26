import type { ConnectorType } from "../connectors";
import {
  expandFirewallMetadataDefaultPolicy,
  FIREWALL_PERMISSION_METADATA_SUMMARIES,
  type FirewallMetadataConnectorType,
  loadFirewallPermissionMetadata,
} from "../firewall-metadata";
import { expandFirewallPlaceholders } from "../firewall-placeholder-expansion";
import type { FirewallConfig, FirewallPolicy } from "../firewall-types";
import {
  loadConnectorFirewallSourceSet,
  loadGeneratedConnectorFirewallModuleExports,
  loadGeneratedConnectorFirewallSource,
} from "../../../firewalls-generator/src/connector-firewall-sources";

type TestFirewallConnectorType = Extract<
  FirewallMetadataConnectorType,
  ConnectorType
>;

const generatedFirewallCache = new Map<
  TestFirewallConnectorType,
  Promise<FirewallConfig>
>();
let runtimeFirewallEntriesPromise: Promise<
  readonly (readonly [TestFirewallConnectorType, FirewallConfig])[]
> | null = null;

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      return typeof item === "string";
    })
  );
}

export function isStringRecord(
  value: unknown,
): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => {
      return typeof item === "string";
    })
  );
}

export function isNumberRecord(
  value: unknown,
): value is Record<string, number> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => {
      return typeof item === "number";
    })
  );
}

export function isNumberOrStringRecord(
  value: unknown,
): value is Record<string, number | string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => {
      return typeof item === "number" || typeof item === "string";
    })
  );
}

function isTestFirewallConnectorType(
  type: string,
): type is TestFirewallConnectorType {
  return Object.prototype.hasOwnProperty.call(
    FIREWALL_PERMISSION_METADATA_SUMMARIES,
    type,
  );
}

async function loadGeneratedConnectorFirewall(
  type: TestFirewallConnectorType,
): Promise<FirewallConfig> {
  const source = await loadGeneratedConnectorFirewallSource(type);
  return expandFirewallPlaceholders(source.firewall, type);
}

async function loadTestConnectorFirewall(
  type: TestFirewallConnectorType,
): Promise<FirewallConfig> {
  const cached = generatedFirewallCache.get(type);
  if (cached) {
    return await cached;
  }

  const load = loadGeneratedConnectorFirewall(type).catch((error: unknown) => {
    generatedFirewallCache.delete(type);
    throw error;
  });
  generatedFirewallCache.set(type, load);
  return await load;
}

export async function loadRequiredConnectorFirewall(
  type: TestFirewallConnectorType,
): Promise<FirewallConfig>;
export async function loadRequiredConnectorFirewall(
  type: string,
): Promise<FirewallConfig>;
export async function loadRequiredConnectorFirewall(
  type: string,
): Promise<FirewallConfig> {
  if (!isTestFirewallConnectorType(type)) {
    throw new Error(`Missing generated connector firewall: ${type}`);
  }
  return await loadTestConnectorFirewall(type);
}

export async function loadRuntimeFirewallEntries(): Promise<
  readonly (readonly [TestFirewallConnectorType, FirewallConfig])[]
> {
  runtimeFirewallEntriesPromise ??= loadRuntimeFirewallEntriesUncached();
  return await runtimeFirewallEntriesPromise;
}

async function loadRuntimeFirewallEntriesUncached(): Promise<
  readonly (readonly [TestFirewallConnectorType, FirewallConfig])[]
> {
  const sourceSet = await loadConnectorFirewallSourceSet();
  const firewalls: (readonly [TestFirewallConnectorType, FirewallConfig])[] =
    [];
  for (const source of sourceSet.sources) {
    if (!isTestFirewallConnectorType(source.type)) {
      throw new Error(`Missing generated connector firewall: ${source.type}`);
    }
    firewalls.push([
      source.type,
      expandFirewallPlaceholders(source.firewall, source.type),
    ]);
  }
  return firewalls.sort(([a], [b]) => {
    return compareStrings(a, b);
  });
}

export async function loadDefaultFirewallPolicies(
  type: TestFirewallConnectorType,
): Promise<FirewallPolicy>;
export async function loadDefaultFirewallPolicies(
  type: string,
): Promise<FirewallPolicy>;
export async function loadDefaultFirewallPolicies(
  type: string,
): Promise<FirewallPolicy> {
  const metadata = await loadFirewallPermissionMetadata(type);
  if (!metadata) {
    throw new Error(`Missing firewall permission metadata: ${type}`);
  }
  return expandFirewallMetadataDefaultPolicy(metadata);
}

export async function loadRequiredGeneratedConnectorFirewallExport<T>(
  type: TestFirewallConnectorType,
  exportName: string,
  isExpected: (value: unknown) => value is T,
): Promise<T> {
  const generatedModule =
    await loadGeneratedConnectorFirewallModuleExports(type);
  const value = generatedModule[exportName];
  if (!isExpected(value)) {
    throw new Error(
      `Missing generated connector firewall export: ${exportName}`,
    );
  }
  return value;
}
