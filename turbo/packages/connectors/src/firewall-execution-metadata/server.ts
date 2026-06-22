import { FIREWALL_EXECUTION_METADATA_SUMMARIES } from "./summary.generated";
import type {
  FirewallExecutionMetadataDetail,
  FirewallExecutionMetadataSummary,
} from "./types";

export type {
  FirewallExecutionMetadataDetail,
  FirewallExecutionMetadataSummary,
} from "./types";

export type FirewallExecutionMetadataConnectorType =
  keyof typeof FIREWALL_EXECUTION_METADATA_SUMMARIES;

const executionMetadataCache = new Map<
  FirewallExecutionMetadataConnectorType,
  Promise<FirewallExecutionMetadataDetail>
>();

export function isFirewallExecutionMetadataConnectorType(
  type: string,
): type is FirewallExecutionMetadataConnectorType {
  return Object.prototype.hasOwnProperty.call(
    FIREWALL_EXECUTION_METADATA_SUMMARIES,
    type,
  );
}

export function getFirewallExecutionMetadataSummary(
  type: string,
): FirewallExecutionMetadataSummary | null {
  if (!isFirewallExecutionMetadataConnectorType(type)) {
    return null;
  }
  return FIREWALL_EXECUTION_METADATA_SUMMARIES[type];
}

async function loadFirewallExecutionMetadataDetail(
  type: FirewallExecutionMetadataConnectorType,
): Promise<FirewallExecutionMetadataDetail> {
  const { loadGeneratedFirewallExecutionMetadata } =
    await import("./loader.generated");
  const detail = await loadGeneratedFirewallExecutionMetadata(type);
  if (!detail) {
    throw new Error(`Missing firewall execution metadata: ${type}`);
  }
  if (detail.type !== type) {
    throw new Error(
      `Mismatched firewall execution metadata: requested ${type}, got ${detail.type}`,
    );
  }
  return detail;
}

export async function loadFirewallExecutionMetadata(
  type: string,
): Promise<FirewallExecutionMetadataDetail | null> {
  if (!isFirewallExecutionMetadataConnectorType(type)) {
    return null;
  }

  const cached = executionMetadataCache.get(type);
  if (cached) {
    return await cached;
  }

  const load = loadFirewallExecutionMetadataDetail(type).catch(
    (error: unknown) => {
      executionMetadataCache.delete(type);
      throw error;
    },
  );
  executionMetadataCache.set(type, load);
  return await load;
}
