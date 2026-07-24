import { isDeepStrictEqual } from "node:util";

import type { ConnectorRef } from "@vm0/api-contracts/contracts/connector-identity";
import {
  connectorAuthMethodRuntimeMetadata,
  type ConnectorRuntimeBindingEntry,
} from "@vm0/connectors/connector-utils";
import type { ConnectorAuthMethodRuntimeConfig } from "@vm0/connectors/connectors";
import {
  createFirewallMetadataPolicyResolver,
  getFirewallPermissionSummary,
  type FirewallMetadataPolicyResolver,
  type FirewallPermissionDefaultPolicyMetadata,
} from "@vm0/connectors/firewall-metadata";
import {
  getFirewallRoutingIndexMetadata,
  loadFirewallRoutingMetadata,
  type FirewallRoutingApiMetadata,
  type FirewallRoutingIndexApiMetadata,
  type FirewallRoutingRouteMetadata,
} from "@vm0/connectors/firewall-metadata/routing";
import {
  getBuiltinConnectorHostOwner,
  getFirewallExecutionMetadata,
  loadFirewallPermissionIndex,
  normalizeConnectorFixedHost,
} from "@vm0/connectors/firewall-metadata/server";
import {
  extractSecretNamesFromApis,
  UNKNOWN_PERMISSION_GRANT,
  type FirewallBaseHostPolicy,
  type FirewallPolicies,
  type FirewallPolicyValue,
} from "@vm0/connectors/firewall-types";

import type {
  ConnectorCatalogArtifact,
  ConnectorCatalogArtifactConnector,
} from "./connector-catalog-artifacts/artifacts";
import {
  connectorCatalogFirewallConfig,
  deriveConnectorCatalogFirewallPermissions,
  deriveConnectorCatalogFirewallRouting,
  type ConnectorCatalogFirewallRouting,
} from "./connector-catalog-artifacts/relationships";

const POLICY_VALUES = ["allow", "deny", "ask"] as const;
const DEFAULT_FIREWALL_SECRET_PLACEHOLDER =
  "c0ffee5afe10ca1c0ffee5afe10ca1c0ffee5afe";

type AcceptedFirewallConfig = NonNullable<
  ReturnType<typeof connectorCatalogFirewallConfig>
>;
type AcceptedGeneratedFirewall = Extract<
  ConnectorCatalogArtifactConnector["firewall"],
  { readonly kind: "generated" }
>;

interface AcceptedServerFirewall {
  readonly connectorRef: ConnectorRef;
  readonly label: string;
  readonly billable: boolean;
  readonly firewall: AcceptedFirewallConfig;
  readonly routing: ConnectorCatalogFirewallRouting;
  readonly defaultAllowed: AcceptedGeneratedFirewall["defaultAllowed"];
  readonly defaultUnknownPolicy: AcceptedGeneratedFirewall["defaultUnknownPolicy"];
}

export interface ConnectorServerFirewallPermissionIndex {
  readonly connectorRef: ConnectorRef;
  readonly label: string;
  readonly permissionNames: ReadonlySet<string>;
  readonly permissionDescriptions: ReadonlyMap<string, string>;
  readonly defaultPolicy: FirewallPermissionDefaultPolicyMetadata;
  readonly unknownPolicy: FirewallPolicyValue;
  readonly policyResolver: FirewallMetadataPolicyResolver;
  hasPermission(name: string): boolean;
  permissionDescription(name: string): string | null;
}

export interface ConnectorServerFirewallExecutionBaseUrlTemplate {
  readonly base: string;
  readonly credentialed: boolean;
  readonly hostPolicy?: FirewallBaseHostPolicy;
}

export interface ConnectorServerFirewallExecutionMetadata {
  readonly connectorRef: ConnectorRef;
  readonly billable: boolean;
  readonly baseUrlVarNames: readonly string[];
  readonly baseUrlTemplates: readonly ConnectorServerFirewallExecutionBaseUrlTemplate[];
  readonly secretPlaceholderNames: readonly string[];
  readonly placeholderValues: Readonly<Record<string, string>>;
}

export interface ConnectorServerFirewallRoutingIndexMetadata {
  readonly connectorRef: ConnectorRef;
  readonly label: string;
  readonly apis: readonly FirewallRoutingIndexApiMetadata[];
}

export interface ConnectorServerFirewallRoutingMetadata {
  readonly connectorRef: ConnectorRef;
  readonly label: string;
  readonly apis: readonly FirewallRoutingApiMetadata[];
}

export interface ConnectorServerFirewallHostOwner {
  readonly connectorRef: ConnectorRef;
  readonly label: string;
}

export interface ConnectorServerFirewallCatalog {
  readonly connectorRefs: readonly ConnectorRef[];
  has(connectorRef: string): boolean;
  getExecutionMetadata(
    connectorRef: string,
  ): ConnectorServerFirewallExecutionMetadata | null;
  loadPermissionIndex(
    connectorRef: string,
  ): Promise<ConnectorServerFirewallPermissionIndex | null>;
  getRoutingIndexMetadata(
    connectorRef: string,
  ): ConnectorServerFirewallRoutingIndexMetadata | null;
  loadRoutingMetadata(
    connectorRef: string,
  ): Promise<ConnectorServerFirewallRoutingMetadata | null>;
  getFixedHostOwner(host: string): ConnectorServerFirewallHostOwner | null;
}

interface ExternalConnectorServerFirewallEntry {
  readonly permissionIndex: ConnectorServerFirewallPermissionIndex;
  readonly executionMetadata: ConnectorServerFirewallExecutionMetadata;
  readonly routingIndexMetadata: ConnectorServerFirewallRoutingIndexMetadata;
  readonly routingMetadata: ConnectorServerFirewallRoutingMetadata;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUniqueStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function sortedStringRecord(
  entries: Iterable<readonly [string, string]>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [...entries].sort(([left], [right]) => {
      return compareStrings(left, right);
    }),
  );
}

function choosePermissionDefault(
  policies: Readonly<Record<string, FirewallPolicyValue>>,
): FirewallPolicyValue {
  const counts = new Map<FirewallPolicyValue, number>(
    POLICY_VALUES.map((value) => {
      return [value, 0];
    }),
  );
  for (const value of Object.values(policies)) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return POLICY_VALUES.reduce<FirewallPolicyValue>((best, candidate) => {
    return (counts.get(candidate) ?? 0) > (counts.get(best) ?? 0)
      ? candidate
      : best;
  }, "allow");
}

function compactDefaultPolicy(args: {
  readonly permissionNames: readonly string[];
  readonly defaultAllowed: readonly string[] | null;
  readonly defaultUnknownPolicy: FirewallPolicyValue;
}): FirewallPermissionDefaultPolicyMetadata {
  const allowed = args.defaultAllowed
    ? new Set<string>(args.defaultAllowed)
    : null;
  const policies = Object.fromEntries(
    args.permissionNames.map((permission): [string, FirewallPolicyValue] => {
      return [
        permission,
        allowed === null || allowed.has(permission) ? "allow" : "deny",
      ];
    }),
  );
  const permissionDefault = choosePermissionDefault(policies);
  const permissionOverrides: Partial<
    Record<FirewallPolicyValue, readonly string[]>
  > = {};
  for (const value of POLICY_VALUES) {
    if (value === permissionDefault) {
      continue;
    }
    const permissions = Object.entries(policies)
      .filter(([, policy]) => {
        return policy === value;
      })
      .map(([permission]) => {
        return permission;
      })
      .sort(compareStrings);
    if (permissions.length > 0) {
      permissionOverrides[value] = permissions;
    }
  }
  return {
    permissionDefault,
    ...(Object.keys(permissionOverrides).length > 0
      ? { permissionOverrides }
      : {}),
    unknownPolicy: args.defaultUnknownPolicy,
  };
}

function externalPermissionIndex(
  firewall: AcceptedServerFirewall,
): ConnectorServerFirewallPermissionIndex {
  const permissions = new Map(
    deriveConnectorCatalogFirewallPermissions(firewall.firewall.apis).map(
      (permission) => {
        return [permission.name, permission.description] as const;
      },
    ),
  );
  const defaultPolicy = compactDefaultPolicy({
    permissionNames: [...permissions.keys()].sort(compareStrings),
    defaultAllowed: firewall.defaultAllowed,
    defaultUnknownPolicy: firewall.defaultUnknownPolicy,
  });
  permissions.delete(UNKNOWN_PERMISSION_GRANT);
  const permissionNames = [...permissions.keys()].sort(compareStrings);
  const permissionDescriptions = new Map<string, string>();
  for (const [name, description] of permissions) {
    if (description !== undefined) {
      permissionDescriptions.set(name, description);
    }
  }
  const policyResolver = createFirewallMetadataPolicyResolver({
    defaultPolicy,
  });
  const permissionNameSet = new Set(permissionNames);
  return {
    connectorRef: firewall.connectorRef,
    label: firewall.label,
    permissionNames: permissionNameSet,
    permissionDescriptions,
    defaultPolicy,
    unknownPolicy: defaultPolicy.unknownPolicy,
    policyResolver,
    hasPermission: (name) => {
      return permissionNameSet.has(name);
    },
    permissionDescription: (name) => {
      return permissionDescriptions.get(name) ?? null;
    },
  };
}

function runtimeBindingEntries(
  methods: readonly ConnectorAuthMethodRuntimeConfig[],
): readonly ConnectorRuntimeBindingEntry[] {
  return methods.flatMap((method) => {
    return connectorAuthMethodRuntimeMetadata(method).runtimeBindings;
  });
}

function expandedExternalPlaceholders(args: {
  readonly firewall: AcceptedServerFirewall["firewall"];
  readonly methods: readonly ConnectorAuthMethodRuntimeConfig[];
}): Readonly<Record<string, string>> {
  const expanded: Record<string, string> = {
    ...args.firewall.placeholders,
  };
  const bindings = runtimeBindingEntries(args.methods);
  for (const [name, value] of Object.entries(
    args.firewall.placeholders ?? {},
  )) {
    const bindingValueRefs = bindings
      .filter((binding) => {
        return binding.envName === name;
      })
      .map((binding) => {
        return binding.valueRef;
      });
    for (const valueRef of bindingValueRefs) {
      if (!valueRef.startsWith("$secrets.")) {
        continue;
      }
      const rawName = valueRef.slice("$secrets.".length);
      if (!expanded[rawName]) {
        expanded[rawName] = value;
      }
      for (const binding of bindings) {
        if (binding.valueRef === valueRef && !expanded[binding.envName]) {
          expanded[binding.envName] = value;
        }
      }
    }
    const rawValueRef = `$secrets.${name}`;
    for (const binding of bindings) {
      if (binding.valueRef === rawValueRef && !expanded[binding.envName]) {
        expanded[binding.envName] = value;
      }
    }
  }
  return expanded;
}

function externalPlaceholderValues(args: {
  readonly firewall: AcceptedServerFirewall["firewall"];
  readonly methods: readonly ConnectorAuthMethodRuntimeConfig[];
}): Readonly<Record<string, string>> {
  const expanded = expandedExternalPlaceholders(args);
  const placeholderValues: Record<string, string> = {};
  for (const name of extractSecretNamesFromApis(args.firewall.apis)) {
    placeholderValues[name] =
      expanded[name] ?? DEFAULT_FIREWALL_SECRET_PLACEHOLDER;
  }
  for (const [name, value] of Object.entries(expanded)) {
    placeholderValues[name] = value;
  }
  return sortedStringRecord(Object.entries(placeholderValues));
}

function externalBaseUrlTemplates(
  firewall: AcceptedServerFirewall,
): readonly ConnectorServerFirewallExecutionBaseUrlTemplate[] {
  const templates = new Map<
    string,
    ConnectorServerFirewallExecutionBaseUrlTemplate
  >();
  for (const template of firewall.routing.baseUrlTemplates) {
    const existing = templates.get(template.base);
    if (
      existing &&
      !isDeepStrictEqual(existing.hostPolicy, template.hostPolicy)
    ) {
      throw new Error(
        `Accepted connector server firewall base URL host policies conflict: ${firewall.connectorRef} (${template.base})`,
      );
    }
    templates.set(template.base, {
      base: template.base,
      credentialed: (existing?.credentialed ?? false) || template.credentialed,
      ...(template.hostPolicy === undefined
        ? {}
        : { hostPolicy: template.hostPolicy }),
    });
  }
  return [...templates.values()].sort((left, right) => {
    return compareStrings(left.base, right.base);
  });
}

function externalExecutionMetadata(args: {
  readonly firewall: AcceptedServerFirewall;
  readonly methods: readonly ConnectorAuthMethodRuntimeConfig[];
}): ConnectorServerFirewallExecutionMetadata {
  const placeholderValues = externalPlaceholderValues({
    firewall: args.firewall.firewall,
    methods: args.methods,
  });
  return {
    connectorRef: args.firewall.connectorRef,
    billable: args.firewall.billable,
    baseUrlVarNames: args.firewall.routing.baseUrlVarNames,
    baseUrlTemplates: externalBaseUrlTemplates(args.firewall),
    secretPlaceholderNames: Object.keys(placeholderValues),
    placeholderValues,
  };
}

function externalRoutingIndexMetadata(
  firewall: AcceptedServerFirewall,
): ConnectorServerFirewallRoutingIndexMetadata {
  return {
    connectorRef: firewall.connectorRef,
    label: firewall.label,
    apis: firewall.routing.apis.map((api) => {
      return { base: api.base };
    }),
  };
}

function externalRoutingMetadata(
  firewall: AcceptedServerFirewall,
): ConnectorServerFirewallRoutingMetadata {
  return {
    connectorRef: firewall.connectorRef,
    label: firewall.label,
    apis: firewall.routing.apis.map((api) => {
      return {
        base: api.base,
        environmentNames: api.environmentNames,
        routes: api.routes,
      };
    }),
  };
}

function staticPermissionIndex(
  connectorRef: ConnectorRef,
  index: NonNullable<Awaited<ReturnType<typeof loadFirewallPermissionIndex>>>,
): ConnectorServerFirewallPermissionIndex {
  return {
    connectorRef,
    label: index.label,
    permissionNames: index.permissionNames,
    permissionDescriptions: index.permissionDescriptions,
    defaultPolicy: index.defaultPolicy,
    unknownPolicy: index.unknownPolicy,
    policyResolver: index.policyResolver,
    hasPermission: index.hasPermission,
    permissionDescription: index.permissionDescription,
  };
}

function staticExecutionMetadata(
  connectorRef: ConnectorRef,
): ConnectorServerFirewallExecutionMetadata | null {
  const metadata = getFirewallExecutionMetadata(connectorRef);
  if (!metadata) {
    return null;
  }
  return {
    connectorRef,
    billable: metadata.billable,
    baseUrlVarNames: metadata.baseUrlVarNames,
    baseUrlTemplates: metadata.baseUrlTemplates,
    secretPlaceholderNames: metadata.secretPlaceholderNames,
    placeholderValues: metadata.placeholderValues,
  };
}

function staticRoutingIndexMetadata(
  connectorRef: ConnectorRef,
): ConnectorServerFirewallRoutingIndexMetadata | null {
  const metadata = getFirewallRoutingIndexMetadata(connectorRef);
  if (!metadata) {
    return null;
  }
  return {
    connectorRef,
    label: metadata.label,
    apis: metadata.apis,
  };
}

async function staticRoutingMetadata(
  connectorRef: ConnectorRef,
): Promise<ConnectorServerFirewallRoutingMetadata | null> {
  const metadata = await loadFirewallRoutingMetadata(connectorRef);
  if (!metadata) {
    return null;
  }
  return {
    connectorRef,
    label: metadata.label,
    apis: metadata.apis,
  };
}

function staticCompactMetadata(connectorRef: ConnectorRef): {
  readonly execution: ConnectorServerFirewallExecutionMetadata;
  readonly routing: ConnectorServerFirewallRoutingIndexMetadata;
} | null {
  const execution = staticExecutionMetadata(connectorRef);
  const routing = staticRoutingIndexMetadata(connectorRef);
  const summary = getFirewallPermissionSummary(connectorRef);
  if (!execution && !routing && !summary) {
    return null;
  }
  if (!execution || !routing || !summary) {
    throw new Error(
      `Static connector server firewall metadata is incomplete: ${connectorRef}`,
    );
  }
  return { execution, routing };
}

export function createStaticConnectorServerFirewallCatalog(
  connectorRefs: readonly ConnectorRef[],
): ConnectorServerFirewallCatalog {
  const compactMetadata = new Map<
    ConnectorRef,
    NonNullable<ReturnType<typeof staticCompactMetadata>>
  >();
  for (const connectorRef of connectorRefs) {
    const metadata = staticCompactMetadata(connectorRef);
    if (metadata) {
      compactMetadata.set(connectorRef, metadata);
    }
  }
  const refs = sortedUniqueStrings(compactMetadata.keys());
  const refSet = new Set<string>(refs);
  return {
    connectorRefs: refs,
    has: (connectorRef) => {
      return refSet.has(connectorRef);
    },
    getExecutionMetadata: (connectorRef) => {
      return compactMetadata.get(connectorRef)?.execution ?? null;
    },
    loadPermissionIndex: async (connectorRef) => {
      if (!refSet.has(connectorRef)) {
        return null;
      }
      const index = await loadFirewallPermissionIndex(connectorRef);
      if (!index) {
        throw new Error(
          `Static connector server firewall permission metadata is missing: ${connectorRef}`,
        );
      }
      return staticPermissionIndex(connectorRef, index);
    },
    getRoutingIndexMetadata: (connectorRef) => {
      return compactMetadata.get(connectorRef)?.routing ?? null;
    },
    loadRoutingMetadata: async (connectorRef) => {
      if (!refSet.has(connectorRef)) {
        return null;
      }
      const metadata = await staticRoutingMetadata(connectorRef);
      if (!metadata) {
        throw new Error(
          `Static connector server firewall routing metadata is missing: ${connectorRef}`,
        );
      }
      return metadata;
    },
    getFixedHostOwner: (host) => {
      const owner = getBuiltinConnectorHostOwner(host);
      return owner && refSet.has(owner.type)
        ? { connectorRef: owner.type, label: owner.label }
        : null;
    },
  };
}

function acceptedServerFirewalls(
  artifact: ConnectorCatalogArtifact,
): readonly AcceptedServerFirewall[] {
  return artifact.connectors.flatMap((connector) => {
    if (connector.firewall.kind === "none") {
      return [];
    }
    const firewall = connectorCatalogFirewallConfig(connector);
    if (firewall === null) {
      throw new Error(
        `Accepted connector server firewall is missing: ${connector.connectorRef}`,
      );
    }
    return [
      {
        connectorRef: connector.connectorRef,
        label: connector.label,
        billable: connector.firewall.billable,
        firewall,
        routing: deriveConnectorCatalogFirewallRouting(firewall),
        defaultAllowed: connector.firewall.defaultAllowed,
        defaultUnknownPolicy: connector.firewall.defaultUnknownPolicy,
      },
    ];
  });
}

function externalEntries(args: {
  readonly firewalls: readonly AcceptedServerFirewall[];
  readonly runtimeMethodsByRef: ReadonlyMap<
    ConnectorRef,
    readonly ConnectorAuthMethodRuntimeConfig[]
  >;
}): ReadonlyMap<ConnectorRef, ExternalConnectorServerFirewallEntry> {
  const entries = new Map<ConnectorRef, ExternalConnectorServerFirewallEntry>();
  for (const firewall of args.firewalls) {
    if (entries.has(firewall.connectorRef)) {
      throw new Error(
        `Duplicate accepted connector server firewall: ${firewall.connectorRef}`,
      );
    }
    const methods = args.runtimeMethodsByRef.get(firewall.connectorRef);
    if (!methods) {
      throw new Error(
        `Accepted connector server firewall runtime is missing: ${firewall.connectorRef}`,
      );
    }
    const permissionIndex = externalPermissionIndex(firewall);
    const executionMetadata = externalExecutionMetadata({
      firewall,
      methods,
    });
    const routingIndexMetadata = externalRoutingIndexMetadata(firewall);
    const routingMetadata = externalRoutingMetadata(firewall);
    entries.set(firewall.connectorRef, {
      permissionIndex,
      executionMetadata,
      routingIndexMetadata,
      routingMetadata,
    });
  }
  return entries;
}

function externalFixedHostOwners(
  firewalls: readonly AcceptedServerFirewall[],
): ReadonlyMap<string, ConnectorServerFirewallHostOwner> {
  const owners = new Map<string, ConnectorServerFirewallHostOwner>();
  for (const firewall of firewalls) {
    for (const rawHost of firewall.routing.fixedHosts) {
      const host = normalizeConnectorFixedHost(rawHost);
      if (!host) {
        throw new Error(
          `Accepted connector server firewall fixed host is invalid: ${firewall.connectorRef}`,
        );
      }
      const existing = owners.get(host);
      if (
        existing &&
        compareStrings(existing.connectorRef, firewall.connectorRef) <= 0
      ) {
        continue;
      }
      owners.set(host, {
        connectorRef: firewall.connectorRef,
        label: firewall.label,
      });
    }
  }
  return owners;
}

export function createExternalConnectorServerFirewallCatalog(args: {
  readonly artifact: ConnectorCatalogArtifact;
  readonly runtimeMethodsByRef: ReadonlyMap<
    ConnectorRef,
    readonly ConnectorAuthMethodRuntimeConfig[]
  >;
}): ConnectorServerFirewallCatalog {
  const firewalls = acceptedServerFirewalls(args.artifact);
  const entries = externalEntries({
    firewalls,
    runtimeMethodsByRef: args.runtimeMethodsByRef,
  });
  const connectorRefs = [...entries.keys()].sort(compareStrings);
  const fixedHostOwners = externalFixedHostOwners(firewalls);
  return {
    connectorRefs,
    has: (connectorRef) => {
      return entries.has(connectorRef);
    },
    getExecutionMetadata: (connectorRef) => {
      return entries.get(connectorRef)?.executionMetadata ?? null;
    },
    loadPermissionIndex: (connectorRef) => {
      return Promise.resolve(
        entries.get(connectorRef)?.permissionIndex ?? null,
      );
    },
    getRoutingIndexMetadata: (connectorRef) => {
      return entries.get(connectorRef)?.routingIndexMetadata ?? null;
    },
    loadRoutingMetadata: (connectorRef) => {
      return Promise.resolve(
        entries.get(connectorRef)?.routingMetadata ?? null,
      );
    },
    getFixedHostOwner: (host) => {
      const normalized = normalizeConnectorFixedHost(host);
      return normalized ? (fixedHostOwners.get(normalized) ?? null) : null;
    },
  };
}

export async function expandConnectorServerFirewallPolicies(args: {
  readonly catalog: ConnectorServerFirewallCatalog;
  readonly stored: FirewallPolicies | null;
  readonly connectorRefs: readonly string[];
}): Promise<FirewallPolicies | null> {
  const indexes = await Promise.all(
    args.connectorRefs.map((connectorRef) => {
      return args.catalog.loadPermissionIndex(connectorRef);
    }),
  );
  let resolved = args.stored;
  for (const index of indexes) {
    if (!index) {
      continue;
    }
    const policies = Object.fromEntries(
      [...index.permissionNames].map((permission) => {
        return [permission, index.policyResolver.permission(permission)];
      }),
    );
    const existing = resolved?.[index.connectorRef];
    resolved = {
      ...resolved,
      [index.connectorRef]: {
        policies: { ...policies, ...existing?.policies },
        ...(existing?.unknownPolicy !== undefined
          ? { unknownPolicy: existing.unknownPolicy }
          : { unknownPolicy: index.policyResolver.unknown() }),
      },
    };
  }
  return resolved;
}

export type { FirewallRoutingRouteMetadata };
