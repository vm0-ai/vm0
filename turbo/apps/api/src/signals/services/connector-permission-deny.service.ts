import type { ConnectorPermissionDenyDiagnosticResult } from "@vm0/api-contracts/contracts/zero-connector-permission-deny";
import type { RunContextResponse } from "@vm0/api-contracts/contracts/zero-runs";
import { getConnectorAuthMethodRuntimeMetadata } from "@vm0/connectors/connector-utils";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { matchFirewallRequestDecision } from "@vm0/connectors/firewall-rule-matcher";
import type { FirewallRoutingRouteMetadata } from "@vm0/connectors/firewall-metadata/routing";
import type { Firewall, NetworkPolicies } from "@vm0/connectors/firewall-types";
import { connectors } from "@vm0/db/schema/connector";
import { variables } from "@vm0/db/schema/variable";
import { command } from "ccstate";
import { and, eq, inArray, sql } from "drizzle-orm";

import { type Db, writeDb$ } from "../external/db";
import {
  buildConnectorDiagnosticBaseCandidates,
  loadConnectorDiagnosticCatalogView,
  mergeConnectorDiagnosticBaseCandidates,
  parseConnectorDiagnosticRequest,
  type ConnectorDiagnosticBaseCandidate,
  type ConnectorDiagnosticCatalogView,
  type ParsedConnectorDiagnosticRequest,
} from "./connector-diagnostic-runtime.service";
import { zeroRunContext } from "./zero-run-detail.service";

interface DiagnosticDecisionPermission {
  readonly name: string;
  readonly rules: string[];
}

type DynamicStateSource =
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "stored" };

interface ResolveConnectorPermissionDenyArgs {
  readonly connectorRef: string;
  readonly method: string;
  readonly url: string;
  readonly orgId: string;
  readonly userId: string;
  readonly stateSource: DynamicStateSource;
}

async function loadStoredBaseUrlVars(
  db: Db,
  args: {
    readonly type: ConnectorType;
    readonly orgId: string;
    readonly userId: string;
    readonly requiredNames: readonly string[];
  },
): Promise<Record<string, string> | null> {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`,
    );

    const [connector] = await tx
      .select({ authMethod: connectors.authMethod })
      .from(connectors)
      .where(
        and(
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          eq(connectors.type, args.type),
        ),
      )
      .limit(1);
    if (!connector) {
      return null;
    }

    const runtimeMetadata = getConnectorAuthMethodRuntimeMetadata(
      args.type,
      connector.authMethod,
    );
    if (!runtimeMetadata) {
      throw new Error(`Invalid stored auth method for ${args.type}`);
    }

    const requiredNameSet = new Set(args.requiredNames);
    const storageNameByRuntimeName = new Map<string, string>();
    for (const binding of runtimeMetadata.runtimeBindings) {
      if (
        requiredNameSet.has(binding.envName) &&
        binding.source.kind === "connector-variable"
      ) {
        storageNameByRuntimeName.set(binding.envName, binding.source.name);
      }
    }
    if (storageNameByRuntimeName.size !== requiredNameSet.size) {
      return null;
    }

    const storageNames = [...new Set(storageNameByRuntimeName.values())];
    const rows = await tx
      .select({ name: variables.name, value: variables.value })
      .from(variables)
      .where(
        and(
          eq(variables.orgId, args.orgId),
          eq(variables.userId, args.userId),
          eq(variables.type, "connector"),
          inArray(variables.name, storageNames),
        ),
      );
    const valueByStorageName = new Map(
      rows.map((row) => {
        return [row.name, row.value] as const;
      }),
    );

    const values: Record<string, string> = {};
    for (const [runtimeName, storageName] of storageNameByRuntimeName) {
      const value = valueByStorageName.get(storageName);
      if (!value) {
        return null;
      }
      values[runtimeName] = value;
    }
    return values;
  });
}

function baseUrlVarsFromRunContext(
  firewalls: RunContextResponse["firewalls"],
  connectorRef: string,
  requiredNames: readonly string[],
): Record<string, string> | null {
  for (const firewall of firewalls) {
    if (
      !("kind" in firewall) ||
      firewall.kind !== "builtin" ||
      firewall.name !== connectorRef ||
      !firewall.baseUrlVars
    ) {
      continue;
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
  return null;
}

function decisionPermissions(
  routes: readonly FirewallRoutingRouteMetadata[],
): DiagnosticDecisionPermission[] {
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

function baseKey(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function matchDiagnosticRequest(
  view: ConnectorDiagnosticCatalogView,
  request: ParsedConnectorDiagnosticRequest,
  candidates: readonly ConnectorDiagnosticBaseCandidate[],
  hasUnresolvedDynamicBase: boolean,
): ConnectorPermissionDenyDiagnosticResult {
  if (candidates.length === 0) {
    return hasUnresolvedDynamicBase
      ? { outcome: "unresolved-dynamic-base", label: view.label }
      : { outcome: "no-matching-base", label: view.label };
  }

  const permissionNames = new Set<string>();
  const displayBaseByDecisionBase = new Map<string, string>();
  const apis = candidates.map((candidate) => {
    const permissions = decisionPermissions(candidate.routes);
    for (const permission of permissions) {
      permissionNames.add(permission.name);
    }
    displayBaseByDecisionBase.set(
      baseKey(candidate.decisionBase),
      candidate.displayBase,
    );
    return {
      base: candidate.decisionBase,
      auth: {},
      permissions,
    };
  });
  const firewalls: Firewall[] = [{ name: view.type, apis }];
  const networkPolicies: NetworkPolicies = {
    [view.type]: {
      allow: [],
      deny: [...permissionNames],
      ask: [],
      unknownPolicy: "deny",
    },
  };
  const decision = matchFirewallRequestDecision(
    firewalls,
    request.method,
    request.url,
    networkPolicies,
    { status: "present", value: view.type },
  );

  if (decision.kind === "no_match") {
    return hasUnresolvedDynamicBase
      ? { outcome: "unresolved-dynamic-base", label: view.label }
      : { outcome: "no-matching-base", label: view.label };
  }
  if (decision.kind === "ambiguous") {
    throw new Error(`Ambiguous firewall decision for ${view.type}`);
  }
  if (decision.kind === "allow") {
    throw new Error(`Unexpected allowed firewall decision for ${view.type}`);
  }
  if (decision.reason === "unsafe_path") {
    return { outcome: "unsafe-input", reason: "unsafe-path" };
  }
  if (
    decision.reason === "malformed_firewall_config" ||
    decision.reason === "malformed_network_policy"
  ) {
    throw new Error(`Invalid firewall decision data for ${view.type}`);
  }

  const displayBase = displayBaseByDecisionBase.get(baseKey(decision.base));
  if (!displayBase) {
    throw new Error(`Missing firewall decision base for ${view.type}`);
  }
  if (decision.reason === "unknown_endpoint") {
    return {
      outcome: "unknown-endpoint",
      label: view.label,
      base: displayBase,
      relativePath: decision.relativePath,
    };
  }

  const permissions = [...new Set(decision.permissions)].sort();
  if (permissions.length === 0) {
    throw new Error(`Missing denied firewall permission for ${view.type}`);
  }
  return {
    outcome: "matched",
    label: view.label,
    base: displayBase,
    relativePath: decision.relativePath,
    permissions,
  };
}

export const resolveConnectorPermissionDeny$ = command(
  async (
    { get, set },
    args: ResolveConnectorPermissionDenyArgs,
    signal: AbortSignal,
  ): Promise<ConnectorPermissionDenyDiagnosticResult> => {
    const request = parseConnectorDiagnosticRequest(args.method, args.url);
    if ("outcome" in request) {
      return request;
    }

    const view = await loadConnectorDiagnosticCatalogView(args.connectorRef);
    signal.throwIfAborted();
    if (!view) {
      return { outcome: "unknown-connector" };
    }

    let baseUrlVars: Record<string, string> | null = null;
    if (view.baseUrlVarNames.length > 0) {
      if (args.stateSource.kind === "run") {
        const runContext = await get(
          zeroRunContext(args.stateSource.runId, args.userId, args.orgId),
        );
        signal.throwIfAborted();
        if (runContext.kind === "ok") {
          baseUrlVars = baseUrlVarsFromRunContext(
            runContext.context.firewalls,
            view.type,
            view.baseUrlVarNames,
          );
        }
      } else {
        baseUrlVars = await loadStoredBaseUrlVars(set(writeDb$), {
          type: view.type,
          orgId: args.orgId,
          userId: args.userId,
          requiredNames: view.baseUrlVarNames,
        });
        signal.throwIfAborted();
      }
    }

    const candidateResult = buildConnectorDiagnosticBaseCandidates(
      view,
      baseUrlVars,
    );
    return matchDiagnosticRequest(
      view,
      request,
      mergeConnectorDiagnosticBaseCandidates(candidateResult.candidates),
      candidateResult.hasUnresolvedDynamicBase,
    );
  },
);
