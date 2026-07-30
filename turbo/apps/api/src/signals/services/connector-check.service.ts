import type {
  ConnectorCheckDiagnosticResult,
  ConnectorCheckPolicy,
  ConnectorCheckRequest,
} from "@vm0/api-contracts/contracts/zero-connector-check";
import type { RunContextResponse } from "@vm0/api-contracts/contracts/zero-runs";
import type { ConnectorSlug } from "@vm0/api-contracts/contracts/connector-identity";
import {
  connectorAuthMethodRuntimeMetadata,
  type ConnectorRuntimeBindingEntry,
} from "@vm0/connectors/connector-auth-method";
import {
  matchFirewallBaseUrl,
  matchFirewallRequestDecision,
  type FirewallRequestDecision,
} from "@vm0/connectors/firewall-rule-matcher";
import type { NetworkPolicies } from "@vm0/connectors/firewall-types";
import { getAllFeatureStates } from "@vm0/core/feature-switch";
import { connectors } from "@vm0/db/schema/connector";
import { variables } from "@vm0/db/schema/variable";
import { command } from "ccstate";
import { and, eq, isNotNull, sql } from "drizzle-orm";

import { type Db, writeDb$ } from "../external/db";
import { pgTextDecoder } from "../../lib/db-structured-result";
import {
  buildConnectorDiagnosticBaseCandidates,
  loadConnectorDiagnosticCatalogView,
  parseConnectorDiagnosticRequest,
  publicConnectorDiagnosticBase,
  resolveConnectorDiagnosticBase,
  type ConnectorDiagnosticBaseCandidate,
  type ConnectorDiagnosticCatalogView,
  type ParsedConnectorDiagnosticRequest,
} from "./connector-diagnostic-runtime.service";
import { userFeatureSwitchOverrides } from "./feature-switches.service";
import { zeroRunContext } from "./zero-run-detail.service";
import {
  getConnectorRuntimeConnector,
  listConnectorRuntimeVisibleSlugs,
  loadConnectorRuntimeSnapshot,
  type ConnectorRuntimeSnapshot,
} from "./connector-catalog-runtime.service";
import type { FirewallRoutingRouteMetadata } from "./connector-server-firewall-catalog.service";
import {
  connectorCredentialVariableReadCondition,
  resolveConnectorCredentialAccess,
  type ConnectorCredentialAccess,
} from "./connector-credential-access.service";

type FeatureStates = ReturnType<typeof getAllFeatureStates>;

interface ConnectorCheckIdentity {
  readonly connectorSlug: ConnectorSlug;
  readonly label: string;
  readonly visibility: "available" | "unavailable";
  readonly credentialResolution: "network-boundary" | "none";
}

interface ConnectorCheckRoutingConfig {
  readonly connectorSlug: ConnectorSlug;
  readonly candidates: readonly ConnectorDiagnosticBaseCandidate[];
  readonly hasUnresolvedDynamicBase: boolean;
}

interface StoredRuntimeState {
  readonly baseUrlVarsBySlug: ReadonlyMap<
    ConnectorSlug,
    Readonly<Record<string, string>> | null
  >;
}

interface StoredConnectorRuntimeCandidate {
  readonly connectorId: string;
  readonly connectorSlug: string;
  readonly authMethod: string;
  readonly storageVersion: number;
}

interface PendingStoredConnectorRuntime {
  readonly access: ConnectorCredentialAccess;
  readonly storageNameByRuntimeName: ReadonlyMap<string, string>;
}

type ConnectorCheckTimeline =
  | { readonly kind: "stored"; readonly state: StoredRuntimeState }
  | { readonly kind: "run"; readonly context: RunContextResponse };

interface ResolveConnectorCheckArgs {
  readonly request: ConnectorCheckRequest;
  readonly orgId: string;
  readonly userId: string;
  readonly stateSource:
    | { readonly kind: "stored" }
    | { readonly kind: "run"; readonly runId: string };
}

type ResolveConnectorCheckResult =
  | {
      readonly kind: "ok";
      readonly diagnostic: ConnectorCheckDiagnosticResult;
    }
  | { readonly kind: "not-found" };

interface DecisionPermission {
  readonly name: string;
  readonly rules: readonly string[];
}

type RunContextFirewall = RunContextResponse["firewalls"][number];
type RunContextInlineFirewall = Extract<RunContextFirewall, { apis: unknown }>;
type RunContextInlinePermission =
  RunContextInlineFirewall["apis"][number]["permissions"] extends
    | readonly (infer Permission)[]
    | undefined
    ? Permission
    : never;

interface ConnectorCheckCatalogContext {
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly visibleConnectorSlugs: ReadonlySet<ConnectorSlug>;
}

function isConnectorSlug(
  snapshot: ConnectorRuntimeSnapshot,
  value: string,
): value is ConnectorSlug {
  return snapshot.connectors.has(value);
}

function baseKey(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function connectorCredentialResolution(
  snapshot: ConnectorRuntimeSnapshot,
  connectorSlug: ConnectorSlug,
): "network-boundary" | "none" {
  return (snapshot.serverFirewalls.getExecutionMetadata(connectorSlug)
    ?.secretPlaceholderNames.length ?? 0) > 0
    ? "network-boundary"
    : "none";
}

function connectorIdentity(
  connectorSlug: ConnectorSlug,
  catalogContext: ConnectorCheckCatalogContext,
): ConnectorCheckIdentity {
  const connector = getConnectorRuntimeConnector(
    catalogContext.snapshot,
    connectorSlug,
  );
  if (!connector) {
    throw new Error(`Missing connector runtime metadata: ${connectorSlug}`);
  }
  return {
    connectorSlug,
    label: connector.catalogConnector.label,
    visibility: catalogContext.visibleConnectorSlugs.has(connectorSlug)
      ? "available"
      : "unavailable",
    credentialResolution: connectorCredentialResolution(
      catalogContext.snapshot,
      connectorSlug,
    ),
  };
}

const connectorCheckFeatureStates$ = command(
  async ({ get }, orgId: string, userId: string): Promise<FeatureStates> => {
    const overrides = await get(userFeatureSwitchOverrides(orgId, userId));
    return getAllFeatureStates({ orgId, userId, overrides });
  },
);

function pendingStoredConnectorRuntimes(
  rows: readonly StoredConnectorRuntimeCandidate[],
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly snapshot: ConnectorRuntimeSnapshot;
  },
): ReadonlyMap<ConnectorSlug, PendingStoredConnectorRuntime | null> {
  const pending = new Map<
    ConnectorSlug,
    PendingStoredConnectorRuntime | null
  >();

  for (const row of rows) {
    if (!isConnectorSlug(args.snapshot, row.connectorSlug)) {
      continue;
    }
    if (pending.has(row.connectorSlug)) {
      throw new Error(
        `Duplicate stored connector state for ${row.connectorSlug}`,
      );
    }
    const accessResult = resolveConnectorCredentialAccess({
      snapshot: args.snapshot,
      stored: {
        authMethodId: row.authMethod,
        connectorId: row.connectorId,
        connectorSlug: row.connectorSlug,
        orgId: args.orgId,
        storageVersion: row.storageVersion,
        userId: args.userId,
      },
    });
    if (accessResult.kind !== "ok") {
      pending.set(row.connectorSlug, null);
      continue;
    }
    const { access } = accessResult;
    const requiredRuntimeNames =
      args.snapshot.serverFirewalls.getExecutionMetadata(row.connectorSlug)
        ?.baseUrlVarNames ?? [];
    if (requiredRuntimeNames.length === 0) {
      pending.set(row.connectorSlug, {
        access,
        storageNameByRuntimeName: new Map(),
      });
      continue;
    }

    const runtimeMetadata = connectorAuthMethodRuntimeMetadata(
      access.runtimeMethod.method,
    );
    const requiredNameSet = new Set(requiredRuntimeNames);
    const storageNameByRuntimeName = new Map<string, string>();
    for (const binding of runtimeMetadata.runtimeBindings) {
      if (
        requiredNameSet.has(binding.envName) &&
        binding.source.kind === "connector-variable"
      ) {
        storageNameByRuntimeName.set(binding.envName, binding.source.name);
      }
    }
    pending.set(
      row.connectorSlug,
      storageNameByRuntimeName.size === requiredNameSet.size
        ? { access, storageNameByRuntimeName }
        : null,
    );
  }

  return pending;
}

async function loadStoredRuntimeState(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly snapshot: ConnectorRuntimeSnapshot;
  },
): Promise<StoredRuntimeState> {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`,
    );

    const connectorRows = await tx
      .select({
        connectorId: connectors.id,
        connectorSlug: sql`${connectors.connectorSlug}`
          .mapWith(pgTextDecoder)
          .as("connector_slug"),
        authMethod: connectors.authMethod,
        storageVersion: connectors.storageVersion,
      })
      .from(connectors)
      .where(
        and(
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          isNotNull(connectors.connectorSlug),
        ),
      );

    const pending = pendingStoredConnectorRuntimes(connectorRows, args);

    const readGroups = [...pending.values()].flatMap((value) => {
      return value === null || value.storageNameByRuntimeName.size === 0
        ? []
        : [
            {
              access: value.access,
              names: [...value.storageNameByRuntimeName.values()],
            },
          ];
    });
    const variableRows =
      readGroups.length === 0
        ? []
        : await tx
            .select({ name: variables.name, value: variables.value })
            .from(variables)
            .where(
              connectorCredentialVariableReadCondition({
                db: tx,
                groups: readGroups,
              }),
            );
    const valueByStorageName = new Map(
      variableRows.map((row) => {
        return [row.name, row.value] as const;
      }),
    );
    const baseUrlVarsBySlug = new Map<
      ConnectorSlug,
      Readonly<Record<string, string>> | null
    >();
    for (const [connectorSlug, pendingState] of pending) {
      if (pendingState === null) {
        baseUrlVarsBySlug.set(connectorSlug, null);
        continue;
      }
      const values: Record<string, string> = {};
      let complete = true;
      for (const [
        runtimeName,
        storageName,
      ] of pendingState.storageNameByRuntimeName) {
        const value = valueByStorageName.get(storageName);
        if (!value) {
          complete = false;
          break;
        }
        values[runtimeName] = value;
      }
      baseUrlVarsBySlug.set(connectorSlug, complete ? values : null);
    }

    return { baseUrlVarsBySlug };
  });
}

function routesToDecisionPermissions(
  routes: readonly FirewallRoutingRouteMetadata[],
): DecisionPermission[] {
  const rulesByPermission = new Map<string, string[]>();
  for (const route of routes) {
    const rules = rulesByPermission.get(route.permissionName);
    if (rules) {
      rules.push(route.rule);
    } else {
      rulesByPermission.set(route.permissionName, [route.rule]);
    }
  }
  return [...rulesByPermission].map(([name, rules]) => {
    return { name, rules };
  });
}

function configsToDecisionFirewalls(
  configs: readonly ConnectorCheckRoutingConfig[],
) {
  return configs.map((config) => {
    return {
      name: config.connectorSlug,
      apis: config.candidates.map((candidate) => {
        return {
          base: candidate.decisionBase,
          auth: {},
          permissions: routesToDecisionPermissions(candidate.routes),
        };
      }),
    };
  });
}

function configFromCatalogView(
  view: ConnectorDiagnosticCatalogView,
  baseUrlVars: Readonly<Record<string, string>> | null,
  allowStructuralDynamic: boolean,
): ConnectorCheckRoutingConfig {
  const result = buildConnectorDiagnosticBaseCandidates(view, baseUrlVars, {
    allowStructuralDynamic,
  });
  return {
    connectorSlug: view.connectorSlug,
    candidates: result.candidates,
    hasUnresolvedDynamicBase: result.hasUnresolvedDynamicBase,
  };
}

function runContextPermissionRoutes(
  permissions: readonly RunContextInlinePermission[] | undefined,
): FirewallRoutingRouteMetadata[] {
  const routes: FirewallRoutingRouteMetadata[] = [];
  const seenPermissionNames = new Set<string>();
  for (const permission of permissions ?? []) {
    if (seenPermissionNames.has(permission.name)) {
      continue;
    }
    seenPermissionNames.add(permission.name);
    for (const rule of permission.rules) {
      routes.push({ permissionName: permission.name, rule });
    }
  }
  return routes;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => {
      return value === right[index];
    })
  );
}

function inlineApiEnvironmentNames(
  base: string,
  view: ConnectorDiagnosticCatalogView | null,
): readonly string[] | null {
  if (!view) {
    return null;
  }
  const matches = view.apis.filter((api) => {
    return api.base === base;
  });
  const [first, ...others] = matches;
  if (!first) {
    return null;
  }
  return others.every((api) => {
    return sameStrings(first.environmentNames, api.environmentNames);
  })
    ? first.environmentNames
    : null;
}

function configFromInlineRunContext(
  firewall: RunContextInlineFirewall,
  connectorSlug: ConnectorSlug,
  view: ConnectorDiagnosticCatalogView | null,
): ConnectorCheckRoutingConfig {
  return {
    connectorSlug,
    candidates: firewall.apis.map((api) => {
      return {
        sourceBase: api.base,
        decisionBase: api.base,
        displayBase: baseKey(api.base),
        routes: runContextPermissionRoutes(api.permissions),
        environmentNames: inlineApiEnvironmentNames(api.base, view),
      };
    }),
    hasUnresolvedDynamicBase: false,
  };
}

function completeRunBaseUrlVars(
  firewall: Exclude<RunContextFirewall, { apis: unknown }>,
  requiredNames: readonly string[],
): Readonly<Record<string, string>> | null {
  if (requiredNames.length === 0) {
    return {};
  }
  if (!("baseUrlVars" in firewall) || !firewall.baseUrlVars) {
    return null;
  }
  const values: Record<string, string> = {};
  for (const name of requiredNames) {
    const value = firewall.baseUrlVars[name];
    if (!value) {
      return null;
    }
    values[name] = value;
  }
  return values;
}

async function loadRunRoutingConfigs(
  runContext: RunContextResponse,
  snapshot: ConnectorRuntimeSnapshot,
): Promise<ConnectorCheckRoutingConfig[]> {
  const viewPromises = new Map<
    ConnectorSlug,
    Promise<ConnectorDiagnosticCatalogView | null>
  >();
  const loadView = (
    connectorSlug: ConnectorSlug,
  ): Promise<ConnectorDiagnosticCatalogView | null> => {
    let promise = viewPromises.get(connectorSlug);
    if (!promise) {
      promise = loadConnectorDiagnosticCatalogView(
        snapshot.serverFirewalls,
        connectorSlug,
      );
      viewPromises.set(connectorSlug, promise);
    }
    return promise;
  };

  const configs: ConnectorCheckRoutingConfig[] = [];
  for (const firewall of runContext.firewalls) {
    if (!snapshot.serverFirewalls.has(firewall.name)) {
      continue;
    }
    const connectorSlug = firewall.name;
    const view = await loadView(connectorSlug);
    if ("apis" in firewall) {
      configs.push(configFromInlineRunContext(firewall, connectorSlug, view));
      continue;
    }
    if (!view) {
      throw new Error(`Missing builtin firewall metadata for ${connectorSlug}`);
    }
    const baseUrlVars = completeRunBaseUrlVars(firewall, view.baseUrlVarNames);
    configs.push(configFromCatalogView(view, baseUrlVars, false));
  }

  const merged = new Map<ConnectorSlug, ConnectorCheckRoutingConfig>();
  for (const config of configs) {
    const existing = merged.get(config.connectorSlug);
    merged.set(config.connectorSlug, {
      connectorSlug: config.connectorSlug,
      candidates: existing
        ? [...existing.candidates, ...config.candidates]
        : config.candidates,
      hasUnresolvedDynamicBase:
        (existing?.hasUnresolvedDynamicBase ?? false) ||
        config.hasUnresolvedDynamicBase,
    });
  }
  return [...merged.values()];
}

async function catalogConfig(
  connectorSlug: ConnectorSlug,
  state: StoredRuntimeState,
  snapshot: ConnectorRuntimeSnapshot,
): Promise<ConnectorCheckRoutingConfig | null> {
  const view = await loadConnectorDiagnosticCatalogView(
    snapshot.serverFirewalls,
    connectorSlug,
  );
  if (!view) {
    return null;
  }
  return configFromCatalogView(
    view,
    state.baseUrlVarsBySlug.get(connectorSlug) ?? null,
    true,
  );
}

async function loadGlobalCatalogConfigs(
  request: ParsedConnectorDiagnosticRequest,
  requestedConnectorSlug: ConnectorSlug | undefined,
  state: StoredRuntimeState,
  snapshot: ConnectorRuntimeSnapshot,
): Promise<ConnectorCheckRoutingConfig[]> {
  let bestScore: number | null = null;
  const ownerSlugs = new Set<ConnectorSlug>();

  for (const connectorSlug of snapshot.serverFirewalls.connectorSlugs) {
    const metadata =
      snapshot.serverFirewalls.getRoutingIndexMetadata(connectorSlug);
    const execution =
      snapshot.serverFirewalls.getExecutionMetadata(connectorSlug);
    if (!metadata || !execution) {
      throw new Error(
        `Missing indexed connector server firewall metadata for ${connectorSlug}`,
      );
    }
    const baseUrlVars = state.baseUrlVarsBySlug.get(connectorSlug) ?? null;
    for (const api of metadata.apis) {
      const resolution = resolveConnectorDiagnosticBase(
        execution,
        api.base,
        baseUrlVars,
        { allowStructuralDynamic: true },
      );
      if (!resolution.candidate) {
        continue;
      }
      const match = matchFirewallBaseUrl(
        request.url,
        resolution.candidate.decisionBase,
      );
      if (!match) {
        continue;
      }
      if (bestScore === null || match.score > bestScore) {
        bestScore = match.score;
        ownerSlugs.clear();
      }
      if (match.score === bestScore) {
        ownerSlugs.add(connectorSlug);
      }
    }
  }

  if (ownerSlugs.size === 0 && requestedConnectorSlug) {
    const selected = await catalogConfig(
      requestedConnectorSlug,
      state,
      snapshot,
    );
    return selected ? [selected] : [];
  }

  const configs = await Promise.all(
    [...ownerSlugs].sort().map(async (connectorSlug) => {
      const config = await catalogConfig(connectorSlug, state, snapshot);
      if (!config) {
        throw new Error(
          `Missing indexed firewall metadata for ${connectorSlug}`,
        );
      }
      return config;
    }),
  );
  return configs;
}

function decisionOwnerNames(
  decision: FirewallRequestDecision,
): readonly string[] {
  if (decision.kind === "ambiguous") {
    return decision.candidates;
  }
  if (decision.kind === "allow" || decision.kind === "block") {
    return [decision.firewallName];
  }
  return [];
}

function environmentNamesForWinningCandidates(
  config: ConnectorCheckRoutingConfig,
  request: ParsedConnectorDiagnosticRequest,
): readonly string[] | null {
  const candidateByOwner = new Map<string, ConnectorDiagnosticBaseCandidate>();
  const firewalls = config.candidates.map((candidate, index) => {
    const name = `diagnostic-api-${index}`;
    candidateByOwner.set(name, candidate);
    return {
      name,
      apis: [
        {
          base: candidate.decisionBase,
          auth: {},
          permissions: routesToDecisionPermissions(candidate.routes),
        },
      ],
    };
  });
  const decision = matchFirewallRequestDecision(
    firewalls,
    request.method,
    request.url,
  );
  const names = new Set<string>();
  let found = false;
  for (const owner of decisionOwnerNames(decision)) {
    const candidate = candidateByOwner.get(owner);
    if (!candidate) {
      continue;
    }
    found = true;
    if (candidate.environmentNames === null) {
      return null;
    }
    for (const name of candidate.environmentNames) {
      names.add(name);
    }
  }
  return found ? [...names].sort() : null;
}

function connectorEnvironmentBindings(
  snapshot: ConnectorRuntimeSnapshot,
  connectorSlug: ConnectorSlug,
): readonly ConnectorRuntimeBindingEntry[] {
  const connector = getConnectorRuntimeConnector(snapshot, connectorSlug);
  if (!connector) {
    return [];
  }
  return [...connector.methods.values()]
    .filter((runtimeMethod) => {
      return runtimeMethod.executable;
    })
    .flatMap((runtimeMethod) => {
      return connectorAuthMethodRuntimeMetadata(runtimeMethod.method)
        .runtimeBindings;
    });
}

function environmentValueRefs(
  snapshot: ConnectorRuntimeSnapshot,
  connectorSlug: ConnectorSlug,
  environmentName: string,
): ReadonlySet<string> {
  return new Set(
    connectorEnvironmentBindings(snapshot, connectorSlug)
      .filter((entry) => {
        return entry.envName === environmentName;
      })
      .map((entry) => {
        return entry.valueRef;
      }),
  );
}

function environmentNameSupportsRoute(
  snapshot: ConnectorRuntimeSnapshot,
  connectorSlug: ConnectorSlug,
  environmentName: string,
  routeEnvironmentNames: readonly string[],
): boolean {
  const requestedRefs = environmentValueRefs(
    snapshot,
    connectorSlug,
    environmentName,
  );
  return routeEnvironmentNames.some((routeEnvironmentName) => {
    if (routeEnvironmentName === environmentName) {
      return true;
    }
    const routeRefs = environmentValueRefs(
      snapshot,
      connectorSlug,
      routeEnvironmentName,
    );
    return [...requestedRefs].some((valueRef) => {
      return routeRefs.has(valueRef);
    });
  });
}

function configuredBases(config: ConnectorCheckRoutingConfig): string[] {
  return [
    ...new Set(
      config.candidates.map((candidate) => {
        return publicConnectorDiagnosticBase(candidate.displayBase);
      }),
    ),
  ].sort();
}

function runStatus(
  timeline: ConnectorCheckTimeline,
  config: ConnectorCheckRoutingConfig | undefined,
) {
  if (timeline.kind === "stored") {
    return { status: "not-scoped" as const };
  }
  if (!config) {
    return { status: "not-configured" as const };
  }
  return { status: "configured" as const, bases: configuredBases(config) };
}

function unavailablePolicy(
  timeline: ConnectorCheckTimeline,
  configured: boolean,
): ConnectorCheckPolicy | null {
  if (timeline.kind === "stored") {
    return { outcome: "unavailable", basis: "not-run-scoped" };
  }
  if (!configured) {
    return { outcome: "unavailable", basis: "connector-not-configured" };
  }
  if (timeline.context.networkPolicies === null) {
    return { outcome: "unavailable", basis: "policies-unavailable" };
  }
  return null;
}

function permissionPolicy(
  connectorSlug: ConnectorSlug,
  permission: string,
  timeline: ConnectorCheckTimeline,
  configured: boolean,
): ConnectorCheckPolicy {
  const unavailable = unavailablePolicy(timeline, configured);
  if (unavailable) {
    return unavailable;
  }
  if (timeline.kind !== "run" || timeline.context.networkPolicies === null) {
    throw new Error("Missing resolved run policy timeline");
  }
  const policy = timeline.context.networkPolicies[connectorSlug];
  if (!policy) {
    return { outcome: "allow", basis: "no-policy" };
  }
  if (policy.deny.includes(permission)) {
    return { outcome: "deny", basis: "deny-list" };
  }
  if (policy.ask.includes(permission)) {
    return { outcome: "ask", basis: "ask-list" };
  }
  if (policy.allow.includes(permission)) {
    return { outcome: "allow", basis: "allow-list" };
  }
  return { outcome: "allow", basis: "not-blocked" };
}

function unknownPolicy(
  connectorSlug: ConnectorSlug,
  timeline: ConnectorCheckTimeline,
  configured: boolean,
): ConnectorCheckPolicy {
  const unavailable = unavailablePolicy(timeline, configured);
  if (unavailable) {
    return unavailable;
  }
  if (timeline.kind !== "run" || timeline.context.networkPolicies === null) {
    throw new Error("Missing resolved run policy timeline");
  }
  const policy = timeline.context.networkPolicies[connectorSlug];
  if (!policy) {
    return { outcome: "allow", basis: "no-policy" };
  }
  switch (policy.unknownPolicy) {
    case "allow": {
      return { outcome: "allow", basis: "unknown-policy" };
    }
    case "deny": {
      return { outcome: "deny", basis: "unknown-policy" };
    }
    case "ask": {
      return { outcome: "ask", basis: "unknown-policy" };
    }
  }
}

function decisionPermissionResult(
  connectorSlug: ConnectorSlug,
  decision: Exclude<
    FirewallRequestDecision,
    { readonly kind: "no_match" | "ambiguous" }
  >,
  timeline: ConnectorCheckTimeline,
) {
  if (decision.kind === "allow") {
    if (decision.permission === undefined) {
      return {
        kind: "unknown-endpoint" as const,
        policy: unknownPolicy(connectorSlug, timeline, true),
      };
    }
    return {
      kind: "matched" as const,
      permissions: [
        {
          name: decision.permission,
          policy: permissionPolicy(
            connectorSlug,
            decision.permission,
            timeline,
            true,
          ),
        },
      ],
    };
  }

  if (decision.reason === "unknown_endpoint") {
    return {
      kind: "unknown-endpoint" as const,
      policy: unknownPolicy(connectorSlug, timeline, true),
    };
  }
  if (decision.reason !== "permission_denied") {
    throw new Error(
      `Invalid connector diagnostic decision: ${decision.reason}`,
    );
  }
  const permissions = [...new Set(decision.permissions)].sort().map((name) => {
    const policy = permissionPolicy(connectorSlug, name, timeline, true);
    if (policy.outcome !== "deny" && policy.outcome !== "ask") {
      throw new Error(
        `Inconsistent blocked permission policy for ${connectorSlug}`,
      );
    }
    return { name, policy };
  });
  if (permissions.length === 0) {
    throw new Error(`Missing blocked permissions for ${connectorSlug}`);
  }
  return { kind: "matched" as const, permissions };
}

function displayBaseForDecision(
  config: ConnectorCheckRoutingConfig,
  decisionBase: string,
): string {
  const candidate = config.candidates.find((entry) => {
    return baseKey(entry.decisionBase) === baseKey(decisionBase);
  });
  if (!candidate) {
    throw new Error(
      `Missing diagnostic display base for ${config.connectorSlug}`,
    );
  }
  return publicConnectorDiagnosticBase(candidate.displayBase);
}

function connectorSlugForEnvironmentName(
  snapshot: ConnectorRuntimeSnapshot,
  environmentName: string,
): ConnectorSlug | null {
  const owners = [...snapshot.connectors.keys()].filter((connectorSlug) => {
    return connectorEnvironmentBindings(snapshot, connectorSlug).some(
      (entry) => {
        return entry.envName === environmentName;
      },
    );
  });
  const [owner, ...others] = owners;
  if (!owner) {
    return null;
  }
  if (others.length > 0) {
    throw new Error(`Ambiguous connector environment name: ${environmentName}`);
  }
  return owner;
}

function policyMap(timeline: ConnectorCheckTimeline): NetworkPolicies | null {
  return timeline.kind === "run" ? timeline.context.networkPolicies : null;
}

function noMatchDiagnostic(
  requestedConnectorSlug: ConnectorSlug | undefined,
  configs: readonly ConnectorCheckRoutingConfig[],
  timeline: ConnectorCheckTimeline,
  catalogContext: ConnectorCheckCatalogContext,
): ConnectorCheckDiagnosticResult {
  const selectedConfig = requestedConnectorSlug
    ? configs.find((config) => {
        return config.connectorSlug === requestedConnectorSlug;
      })
    : undefined;
  if (requestedConnectorSlug && selectedConfig?.hasUnresolvedDynamicBase) {
    return {
      outcome: "unresolved-dynamic-base",
      connector: connectorIdentity(requestedConnectorSlug, catalogContext),
    };
  }
  return {
    outcome: "no-match",
    scope: timeline.kind === "run" ? "run" : "catalog",
  };
}

function ambiguousDiagnostic(
  decision: Extract<FirewallRequestDecision, { readonly kind: "ambiguous" }>,
  catalogContext: ConnectorCheckCatalogContext,
): ConnectorCheckDiagnosticResult {
  return {
    outcome: "ambiguous",
    candidates: decision.candidates.map((candidate) => {
      if (!isConnectorSlug(catalogContext.snapshot, candidate)) {
        throw new Error("Matched an unknown connector firewall");
      }
      const connector = getConnectorRuntimeConnector(
        catalogContext.snapshot,
        candidate,
      );
      if (!connector) {
        throw new Error(`Missing connector runtime metadata: ${candidate}`);
      }
      return {
        connectorSlug: candidate,
        label: connector.catalogConnector.label,
      };
    }),
  };
}

type UrlEnvironmentSelection =
  | {
      readonly kind: "selected";
      readonly environmentNames: string[] | null;
    }
  | {
      readonly kind: "diagnostic";
      readonly diagnostic: ConnectorCheckDiagnosticResult;
    };

function selectUrlEnvironmentNames(args: {
  readonly catalogContext: ConnectorCheckCatalogContext;
  readonly connectorSlug: ConnectorSlug;
  readonly config: ConnectorCheckRoutingConfig;
  readonly parsed: ParsedConnectorDiagnosticRequest;
  readonly requestedEnvironmentName: string | undefined;
  readonly identity: ConnectorCheckIdentity;
}): UrlEnvironmentSelection {
  const environmentNames = environmentNamesForWinningCandidates(
    args.config,
    args.parsed,
  );
  if (args.requestedEnvironmentName === undefined) {
    return {
      kind: "selected",
      environmentNames:
        environmentNames === null ? null : [...environmentNames],
    };
  }
  const owned = connectorEnvironmentBindings(
    args.catalogContext.snapshot,
    args.connectorSlug,
  ).some((entry) => {
    return entry.envName === args.requestedEnvironmentName;
  });
  if (!owned) {
    return {
      kind: "diagnostic",
      diagnostic: {
        outcome: "environment-not-owned",
        connector: args.identity,
      },
    };
  }
  if (
    environmentNames !== null &&
    !environmentNameSupportsRoute(
      args.catalogContext.snapshot,
      args.connectorSlug,
      args.requestedEnvironmentName,
      environmentNames,
    )
  ) {
    return {
      kind: "diagnostic",
      diagnostic: {
        outcome: "environment-not-used",
        connector: args.identity,
        environmentNames: [...environmentNames],
      },
    };
  }
  return {
    kind: "selected",
    environmentNames: [args.requestedEnvironmentName],
  };
}

interface ResolvedUrlDiagnosticArgs {
  readonly request: Extract<ConnectorCheckRequest, { readonly mode: "url" }>;
  readonly parsed: ParsedConnectorDiagnosticRequest;
  readonly decision: Exclude<
    FirewallRequestDecision,
    { readonly kind: "no_match" | "ambiguous" }
  >;
  readonly configs: readonly ConnectorCheckRoutingConfig[];
  readonly timeline: ConnectorCheckTimeline;
  readonly catalogContext: ConnectorCheckCatalogContext;
}

function resolvedUrlDiagnostic(
  args: ResolvedUrlDiagnosticArgs,
): ConnectorCheckDiagnosticResult {
  const { request, parsed, decision, configs, timeline, catalogContext } = args;
  if (decision.kind === "block" && decision.reason === "unsafe_path") {
    return { outcome: "unsafe-input", reason: "unsafe-path" };
  }
  if (
    decision.kind === "block" &&
    (decision.reason === "malformed_firewall_config" ||
      decision.reason === "malformed_network_policy")
  ) {
    throw new Error(
      `Invalid connector diagnostic decision: ${decision.reason}`,
    );
  }
  if (!isConnectorSlug(catalogContext.snapshot, decision.firewallName)) {
    throw new Error("Matched an unknown connector firewall");
  }
  const connectorSlug = decision.firewallName;
  if (
    request.connectorSlug !== undefined &&
    connectorSlug !== request.connectorSlug
  ) {
    return {
      outcome: "connector-mismatch",
      connector: connectorIdentity(connectorSlug, catalogContext),
    };
  }
  const config = configs.find((entry) => {
    return entry.connectorSlug === connectorSlug;
  });
  if (!config) {
    throw new Error(
      `Missing selected connector routing config for ${connectorSlug}`,
    );
  }

  const identity = connectorIdentity(connectorSlug, catalogContext);
  const environmentSelection = selectUrlEnvironmentNames({
    catalogContext,
    connectorSlug,
    config,
    parsed,
    requestedEnvironmentName: request.environmentName,
    identity,
  });
  if (environmentSelection.kind === "diagnostic") {
    return environmentSelection.diagnostic;
  }
  return {
    outcome: "resolved",
    mode: "url",
    connector: identity,
    environmentNames: environmentSelection.environmentNames,
    run: runStatus(timeline, config),
    method: parsed.method,
    base: displayBaseForDecision(config, decision.base),
    relativePath: decision.relativePath,
    permission: decisionPermissionResult(connectorSlug, decision, timeline),
  };
}

async function resolveUrlMode(
  request: Extract<ConnectorCheckRequest, { readonly mode: "url" }>,
  parsed: ParsedConnectorDiagnosticRequest,
  timeline: ConnectorCheckTimeline,
  catalogContext: ConnectorCheckCatalogContext,
): Promise<ConnectorCheckDiagnosticResult> {
  const requestedConnectorSlug = request.connectorSlug;
  if (
    requestedConnectorSlug !== undefined &&
    !isConnectorSlug(catalogContext.snapshot, requestedConnectorSlug)
  ) {
    return { outcome: "unknown-connector" };
  }

  const configs =
    timeline.kind === "run"
      ? await loadRunRoutingConfigs(timeline.context, catalogContext.snapshot)
      : await loadGlobalCatalogConfigs(
          parsed,
          requestedConnectorSlug,
          timeline.state,
          catalogContext.snapshot,
        );
  const decision = matchFirewallRequestDecision(
    configsToDecisionFirewalls(configs),
    parsed.method,
    parsed.url,
    policyMap(timeline),
    requestedConnectorSlug
      ? { status: "present", value: requestedConnectorSlug }
      : { status: "absent" },
  );

  if (decision.kind === "no_match") {
    return noMatchDiagnostic(
      requestedConnectorSlug,
      configs,
      timeline,
      catalogContext,
    );
  }
  if (decision.kind === "ambiguous") {
    return ambiguousDiagnostic(decision, catalogContext);
  }
  return resolvedUrlDiagnostic({
    request,
    parsed,
    decision,
    configs,
    timeline,
    catalogContext,
  });
}

async function resolveEnvironmentMode(
  request: Extract<ConnectorCheckRequest, { readonly mode: "environment" }>,
  timeline: ConnectorCheckTimeline,
  catalogContext: ConnectorCheckCatalogContext,
): Promise<ConnectorCheckDiagnosticResult> {
  const connectorSlug = connectorSlugForEnvironmentName(
    catalogContext.snapshot,
    request.environmentName,
  );
  if (!connectorSlug) {
    return { outcome: "unknown-environment" };
  }
  const configs =
    timeline.kind === "run"
      ? await loadRunRoutingConfigs(timeline.context, catalogContext.snapshot)
      : [];
  const config = configs.find((entry) => {
    return entry.connectorSlug === connectorSlug;
  });
  return {
    outcome: "resolved",
    mode: "environment",
    connector: connectorIdentity(connectorSlug, catalogContext),
    environmentName: request.environmentName,
    run: runStatus(timeline, config),
    permission:
      request.permission === undefined
        ? null
        : permissionPolicy(
            connectorSlug,
            request.permission,
            timeline,
            config !== undefined,
          ),
  };
}

export const resolveConnectorCheck$ = command(
  async (
    { get, set },
    args: ResolveConnectorCheckArgs,
    signal: AbortSignal,
  ): Promise<ResolveConnectorCheckResult> => {
    let parsed: ParsedConnectorDiagnosticRequest | null = null;
    if (args.request.mode === "url") {
      const parseResult = parseConnectorDiagnosticRequest(
        args.request.method,
        args.request.url,
      );
      if ("outcome" in parseResult) {
        return { kind: "ok", diagnostic: parseResult };
      }
      parsed = parseResult;
    }

    const db = set(writeDb$);
    const snapshot = await loadConnectorRuntimeSnapshot(db);
    signal.throwIfAborted();

    let timeline: ConnectorCheckTimeline;
    if (args.stateSource.kind === "run") {
      const runContext = await get(
        zeroRunContext(args.stateSource.runId, args.userId, args.orgId),
      );
      signal.throwIfAborted();
      if (runContext.kind === "not-found") {
        return { kind: "not-found" };
      }
      if (runContext.kind === "no-snapshot") {
        return {
          kind: "ok",
          diagnostic: { outcome: "run-context-unavailable" },
        };
      }
      timeline = { kind: "run", context: runContext.context };
    } else {
      const state =
        args.request.mode === "url"
          ? await loadStoredRuntimeState(db, {
              orgId: args.orgId,
              userId: args.userId,
              snapshot,
            })
          : { baseUrlVarsBySlug: new Map() };
      signal.throwIfAborted();
      timeline = { kind: "stored", state };
    }

    const featureStates = await set(
      connectorCheckFeatureStates$,
      args.orgId,
      args.userId,
    );
    signal.throwIfAborted();
    const visibleConnectorSlugs = listConnectorRuntimeVisibleSlugs({
      snapshot,
      featureStates,
    });
    signal.throwIfAborted();
    const catalogContext: ConnectorCheckCatalogContext = {
      snapshot,
      visibleConnectorSlugs: new Set(visibleConnectorSlugs),
    };
    let diagnostic: ConnectorCheckDiagnosticResult;
    if (args.request.mode === "url") {
      if (!parsed) {
        throw new Error("Missing parsed connector diagnostic request");
      }
      diagnostic = await resolveUrlMode(
        args.request,
        parsed,
        timeline,
        catalogContext,
      );
    } else {
      diagnostic = await resolveEnvironmentMode(
        args.request,
        timeline,
        catalogContext,
      );
    }
    signal.throwIfAborted();
    return { kind: "ok", diagnostic };
  },
);
