import type { ConnectorType } from "../connectors";
import {
  expandFirewallMetadataDefaultPolicy,
  FIREWALL_PERMISSION_METADATA_SUMMARIES,
  type FirewallMetadataConnectorType,
  loadFirewallPermissionMetadata,
} from "../firewall-metadata";
import { expandFirewallPlaceholders } from "../firewall-placeholder-expansion";
import type { FirewallConfig, FirewallPolicy } from "../firewall-types";

type TestFirewallConnectorType = Extract<
  FirewallMetadataConnectorType,
  ConnectorType
>;

const generatedFirewallCache = new Map<
  TestFirewallConnectorType,
  Promise<FirewallConfig>
>();

interface ImportMetaWithGlob extends ImportMeta {
  glob<T>(
    pattern: string,
    options?: { readonly import?: string },
  ): Record<string, () => Promise<T>>;
}

type GeneratedFirewallModule = Readonly<Record<string, unknown>>;

const generatedFirewallModules = (
  import.meta as ImportMetaWithGlob
).glob<GeneratedFirewallModule>("../firewalls/*.generated.ts");

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isFirewallConfig(value: unknown): value is FirewallConfig {
  return isRecord(value) && Array.isArray(value.apis);
}

function generatedFirewallExportName(type: TestFirewallConnectorType): string {
  return `${type
    .split("-")
    .map((segment, index) => {
      if (index === 0) {
        return segment;
      }
      return `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`;
    })
    .join("")}Firewall`;
}

function isTestFirewallConnectorType(
  type: string,
): type is TestFirewallConnectorType {
  return Object.prototype.hasOwnProperty.call(
    FIREWALL_PERMISSION_METADATA_SUMMARIES,
    type,
  );
}

const TEST_FIREWALL_CONNECTOR_TYPES = Object.keys(
  FIREWALL_PERMISSION_METADATA_SUMMARIES,
)
  .filter(isTestFirewallConnectorType)
  .sort(compareStrings);

async function loadGeneratedConnectorFirewall(
  type: TestFirewallConnectorType,
): Promise<FirewallConfig> {
  const moduleLoader =
    generatedFirewallModules[`../firewalls/${type}.generated.ts`];
  if (!moduleLoader) {
    throw new Error(`Missing generated connector firewall module: ${type}`);
  }
  const generatedModule = await moduleLoader();
  const exportName = generatedFirewallExportName(type);
  const firewall = generatedModule[exportName];
  if (!isFirewallConfig(firewall)) {
    throw new Error(`Missing generated connector firewall: ${type}`);
  }

  return expandFirewallPlaceholders(firewall, type);
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
  const firewalls = await Promise.all(
    TEST_FIREWALL_CONNECTOR_TYPES.map(async (type) => {
      return [type, await loadTestConnectorFirewall(type)] as const;
    }),
  );
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
