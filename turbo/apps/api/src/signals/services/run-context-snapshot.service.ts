import type { RunContextResponse } from "@vm0/api-contracts/contracts/zero-runs";
import type { NetworkPolicies } from "@vm0/connectors/firewall-types";

type UnknownRecord = Record<string, unknown>;
type NetworkPolicy = NetworkPolicies[string];
type NetworkPolicyValue = "allow" | "deny" | "ask";

export interface RunContextEnvironmentEntry {
  readonly name: string;
  readonly value: string;
}

export interface RunContextNetworkPolicyEntry {
  readonly name: string;
  readonly policy: NetworkPolicy;
}

export interface RunContextFeatureFlagEntry {
  readonly name: string;
  readonly enabled: boolean;
}

export type RunContextAxiomSnapshot = Omit<
  RunContextResponse,
  "vars" | "environment" | "networkPolicies" | "featureFlags"
> & {
  readonly _time: string;
  readonly userId: string;
  readonly environmentEntries: readonly RunContextEnvironmentEntry[];
  readonly networkPolicyEntries: readonly RunContextNetworkPolicyEntry[];
  readonly featureFlagEntries: readonly RunContextFeatureFlagEntry[];
};

interface NormalizedRunContextSnapshot {
  readonly runId?: string;
  readonly userId?: string;
  readonly prompt?: string;
  readonly appendSystemPrompt?: string | null;
  readonly sessionId: string | null;
  readonly secretNames: readonly string[];
  readonly environment: Record<string, string>;
  readonly firewalls: RunContextResponse["firewalls"];
  readonly networkPolicies: RunContextResponse["networkPolicies"];
  readonly volumes: RunContextResponse["volumes"];
  readonly artifact: RunContextResponse["artifact"];
  readonly featureFlags: Record<string, boolean> | null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((item): item is string => {
    return typeof item === "string";
  });
  return strings.length === value.length ? strings : undefined;
}

function stringRecordValue(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    },
  );
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

function booleanRecordValue(
  value: unknown,
): Record<string, boolean> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, boolean] => {
      return typeof entry[1] === "boolean";
    },
  );
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

function networkPolicyValue(value: unknown): NetworkPolicyValue | undefined {
  return value === "allow" || value === "deny" || value === "ask"
    ? value
    : undefined;
}

function networkPolicyFromUnknown(value: unknown): NetworkPolicy | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const unknownPolicy = networkPolicyValue(value.unknownPolicy);
  if (!unknownPolicy) {
    return undefined;
  }
  return {
    allow: stringArrayValue(value.allow) ?? [],
    deny: stringArrayValue(value.deny) ?? [],
    ask: stringArrayValue(value.ask) ?? [],
    unknownPolicy,
  };
}

function networkPoliciesFromUnknown(
  value: unknown,
): RunContextResponse["networkPolicies"] {
  if (!isRecord(value)) {
    return null;
  }

  const policies: NetworkPolicies = {};
  for (const [name, rawPolicy] of Object.entries(value)) {
    const policy = networkPolicyFromUnknown(rawPolicy);
    if (policy) {
      policies[name] = policy;
    }
  }

  return Object.keys(policies).length > 0 ? policies : null;
}

function environmentFromEntries(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) {
    return {};
  }
  const entries: [string, string][] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const name = stringValue(item.name);
    const entryValue = stringValue(item.value);
    if (name && entryValue !== undefined) {
      entries.push([name, entryValue]);
    }
  }
  return Object.fromEntries(entries);
}

function networkPoliciesFromEntries(
  value: unknown,
): RunContextResponse["networkPolicies"] {
  if (!Array.isArray(value)) {
    return null;
  }
  const policies: NetworkPolicies = {};
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const name = stringValue(item.name);
    const policy = networkPolicyFromUnknown(item.policy);
    if (name && policy) {
      policies[name] = policy;
    }
  }
  return Object.keys(policies).length > 0 ? policies : null;
}

function featureFlagsFromEntries(
  value: unknown,
): Record<string, boolean> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const entries: [string, boolean][] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const name = stringValue(item.name);
    if (name && typeof item.enabled === "boolean") {
      entries.push([name, item.enabled]);
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function stringArrayFromUnknown(value: unknown): string[] {
  return stringArrayValue(value) ?? [];
}

export function environmentRecordToEntries(
  environment: Record<string, string>,
): RunContextEnvironmentEntry[] {
  return Object.entries(environment).map(([name, value]) => {
    return { name, value };
  });
}

export function networkPoliciesRecordToEntries(
  networkPolicies: NetworkPolicies | null | undefined,
): RunContextNetworkPolicyEntry[] {
  if (!networkPolicies) {
    return [];
  }
  return Object.entries(networkPolicies).map(([name, policy]) => {
    return { name, policy };
  });
}

export function featureFlagsRecordToEntries(
  featureFlags: Record<string, boolean> | null | undefined,
): RunContextFeatureFlagEntry[] {
  if (!featureFlags) {
    return [];
  }
  return Object.entries(featureFlags).map(([name, enabled]) => {
    return { name, enabled };
  });
}

export function normalizeRunContextSnapshot(
  snapshot: Record<string, unknown>,
): NormalizedRunContextSnapshot {
  // Temporary legacy map fallback for #17222; remove after June 18, 2026.
  const environment = Array.isArray(snapshot.environmentEntries)
    ? environmentFromEntries(snapshot.environmentEntries)
    : (stringRecordValue(snapshot.environment) ?? {});
  const networkPolicies = Array.isArray(snapshot.networkPolicyEntries)
    ? networkPoliciesFromEntries(snapshot.networkPolicyEntries)
    : networkPoliciesFromUnknown(snapshot.networkPolicies);
  const featureFlags = Array.isArray(snapshot.featureFlagEntries)
    ? featureFlagsFromEntries(snapshot.featureFlagEntries)
    : (booleanRecordValue(snapshot.featureFlags) ?? null);

  return {
    runId: stringValue(snapshot.runId),
    userId: stringValue(snapshot.userId),
    prompt: stringValue(snapshot.prompt),
    appendSystemPrompt:
      typeof snapshot.appendSystemPrompt === "string" ||
      snapshot.appendSystemPrompt === null
        ? snapshot.appendSystemPrompt
        : undefined,
    sessionId: stringValue(snapshot.sessionId) ?? null,
    secretNames: stringArrayFromUnknown(snapshot.secretNames),
    environment,
    firewalls: Array.isArray(snapshot.firewalls)
      ? (snapshot.firewalls as RunContextResponse["firewalls"])
      : [],
    networkPolicies,
    volumes: Array.isArray(snapshot.volumes)
      ? (snapshot.volumes as RunContextResponse["volumes"])
      : [],
    artifact: isRecord(snapshot.artifact)
      ? (snapshot.artifact as RunContextResponse["artifact"])
      : null,
    featureFlags,
  };
}
