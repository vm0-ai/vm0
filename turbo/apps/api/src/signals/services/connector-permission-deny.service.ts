import type { ConnectorPermissionDenyDiagnosticResult } from "@vm0/api-contracts/contracts/zero-connector-permission-deny";
import type { RunContextResponse } from "@vm0/api-contracts/contracts/zero-runs";
import { getConnectorAuthMethodRuntimeMetadata } from "@vm0/connectors/connector-utils";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { matchFirewallRequestDecision } from "@vm0/connectors/firewall-rule-matcher";
import {
  loadFirewallRoutingMetadata,
  type FirewallRoutingRouteMetadata,
} from "@vm0/connectors/firewall-metadata/routing";
import {
  getFirewallExecutionMetadata,
  type FirewallExecutionMetadata,
} from "@vm0/connectors/firewall-metadata/server";
import {
  FirewallBaseUrlResolutionError,
  hasUnsafeFirewallPath,
  resolveFirewallBaseUrlTemplate,
  type Firewall,
  type FirewallBaseHostPolicy,
  type NetworkPolicies,
} from "@vm0/connectors/firewall-types";
import { connectors } from "@vm0/db/schema/connector";
import { variables } from "@vm0/db/schema/variable";
import { command } from "ccstate";
import { and, eq, inArray, sql } from "drizzle-orm";

import { type Db, writeDb$ } from "../external/db";
import { safeSync, safeUrlParse } from "../utils";
import { zeroRunContext } from "./zero-run-detail.service";

const BASE_URL_VAR_PATTERN = /\$\{\{\s*vars\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

interface DiagnosticExecutionTemplate {
  readonly credentialed: boolean;
  readonly hostPolicy?: FirewallBaseHostPolicy;
}

interface DiagnosticCatalogApi {
  readonly base: string;
  readonly routes: readonly FirewallRoutingRouteMetadata[];
  readonly executionTemplate: DiagnosticExecutionTemplate | null;
}

interface DiagnosticCatalogView {
  readonly type: ConnectorType;
  readonly label: string;
  readonly baseUrlVarNames: readonly string[];
  readonly apis: readonly DiagnosticCatalogApi[];
}

interface DiagnosticBaseCandidate {
  readonly decisionBase: string;
  readonly displayBase: string;
  readonly routes: readonly FirewallRoutingRouteMetadata[];
}

interface DiagnosticDecisionPermission {
  readonly name: string;
  readonly rules: string[];
}

interface ParsedDiagnosticRequest {
  readonly method: string;
  readonly url: string;
}

function isValidMethod(method: string): boolean {
  return (
    method === "GET" ||
    method === "POST" ||
    method === "PUT" ||
    method === "PATCH" ||
    method === "DELETE" ||
    method === "HEAD" ||
    method === "OPTIONS"
  );
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

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function baseKey(value: string): string {
  return stripTrailingSlash(value);
}

function baseUrlVarNames(base: string): readonly string[] {
  return [
    ...new Set(
      [...base.matchAll(BASE_URL_VAR_PATTERN)].map((match) => {
        return match[1]!;
      }),
    ),
  ];
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  const leftSorted = [...new Set(left)].sort();
  const rightSorted = [...new Set(right)].sort();
  return (
    leftSorted.length === rightSorted.length &&
    leftSorted.every((name, index) => {
      return name === rightSorted[index];
    })
  );
}

function executionTemplatesByBase(
  metadata: FirewallExecutionMetadata,
): ReadonlyMap<string, DiagnosticExecutionTemplate> {
  const templates = new Map<string, DiagnosticExecutionTemplate>();
  for (const template of metadata.baseUrlTemplates) {
    const key = baseKey(template.base);
    if (templates.has(key)) {
      throw new Error(
        `Duplicate firewall execution base template for ${metadata.type}`,
      );
    }
    templates.set(key, {
      credentialed: template.credentialed,
      ...(template.hostPolicy === undefined
        ? {}
        : { hostPolicy: template.hostPolicy }),
    });
  }
  return templates;
}

async function loadDiagnosticCatalogView(
  connectorRef: string,
): Promise<DiagnosticCatalogView | null> {
  const routing = await loadFirewallRoutingMetadata(connectorRef);
  if (!routing) {
    return null;
  }

  const execution = getFirewallExecutionMetadata(routing.type);
  if (!execution || execution.type !== routing.type) {
    throw new Error(`Missing firewall execution metadata for ${routing.type}`);
  }

  const executionTemplates = executionTemplatesByBase(execution);
  const groupedApis = new Map<
    string,
    {
      readonly base: string;
      readonly routes: FirewallRoutingRouteMetadata[];
      readonly executionTemplate: DiagnosticExecutionTemplate | null;
    }
  >();
  const routingBaseUrlVarNames = new Set<string>();

  for (const api of routing.apis) {
    const names = baseUrlVarNames(api.base);
    for (const name of names) {
      routingBaseUrlVarNames.add(name);
    }
    const key = baseKey(api.base);
    const executionTemplate =
      names.length === 0 ? null : (executionTemplates.get(key) ?? null);
    if (names.length > 0 && !executionTemplate) {
      throw new Error(
        `Missing firewall execution base template for ${routing.type}`,
      );
    }

    const existing = groupedApis.get(key);
    if (existing) {
      if (existing.executionTemplate !== executionTemplate) {
        throw new Error(
          `Conflicting firewall base metadata for ${routing.type}`,
        );
      }
      existing.routes.push(...api.routes);
      continue;
    }

    groupedApis.set(key, {
      base: api.base,
      routes: [...api.routes],
      executionTemplate,
    });
  }

  const dynamicApiCount = [...groupedApis.values()].filter((api) => {
    return api.executionTemplate !== null;
  }).length;
  if (
    !sameNames([...routingBaseUrlVarNames], execution.baseUrlVarNames) ||
    executionTemplates.size !== dynamicApiCount
  ) {
    throw new Error(`Mismatched firewall base metadata for ${routing.type}`);
  }

  return {
    type: routing.type,
    label: routing.label,
    baseUrlVarNames: [...routingBaseUrlVarNames].sort(),
    apis: [...groupedApis.values()],
  };
}

function rawAuthorityFromUrl(url: string): string | null {
  const schemeEnd = url.indexOf("://");
  if (schemeEnd === -1) {
    return null;
  }

  const authorityStart = schemeEnd + 3;
  let authorityEnd = url.length;
  for (const delimiter of ["/", "?", "#"]) {
    const index = url.indexOf(delimiter, authorityStart);
    if (index !== -1) {
      authorityEnd = Math.min(authorityEnd, index);
    }
  }
  return url.slice(authorityStart, authorityEnd);
}

function rawAuthorityHasUnsafeSyntax(url: string): boolean {
  const authority = rawAuthorityFromUrl(url);
  if (authority === null) {
    return false;
  }
  return (
    authority === "" ||
    authority.includes("\\") ||
    authority.includes("%") ||
    [...authority].some((character) => {
      return character.charCodeAt(0) > 0x7f;
    })
  );
}

function stripQueryAndFragment(url: string): string {
  const queryIndex = url.indexOf("?");
  const fragmentIndex = url.indexOf("#");
  let end = url.length;
  if (queryIndex !== -1) {
    end = Math.min(end, queryIndex);
  }
  if (fragmentIndex !== -1) {
    end = Math.min(end, fragmentIndex);
  }
  return url.slice(0, end);
}

function rawPathFromUrl(url: string): string {
  const schemeEnd = url.indexOf("://");
  const authorityStart = schemeEnd === -1 ? 0 : schemeEnd + 3;
  const pathStart = url.indexOf("/", authorityStart);
  return pathStart === -1 ? "/" : url.slice(pathStart);
}

function parseDiagnosticRequest(
  method: string,
  url: string,
): ParsedDiagnosticRequest | ConnectorPermissionDenyDiagnosticResult {
  const upperMethod = method.toUpperCase();
  if (!isValidMethod(upperMethod)) {
    return { outcome: "unsafe-input", reason: "invalid-method" };
  }

  if (
    !url.includes("://") ||
    /\s/u.test(url) ||
    rawAuthorityHasUnsafeSyntax(url)
  ) {
    return { outcome: "unsafe-input", reason: "invalid-url" };
  }

  const parsed = safeUrlParse(url);
  if (
    !parsed ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return { outcome: "unsafe-input", reason: "invalid-url" };
  }

  const sanitizedUrl = stripQueryAndFragment(url);
  if (hasUnsafeFirewallPath(rawPathFromUrl(sanitizedUrl))) {
    return { outcome: "unsafe-input", reason: "unsafe-path" };
  }

  return { method: upperMethod, url: sanitizedUrl };
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

function dynamicTemplateToPattern(base: string): string | null {
  const pattern = base.replace(BASE_URL_VAR_PATTERN, (_match, name: string) => {
    return `{${name}}`;
  });
  return pattern.includes("://") ? pattern : null;
}

function buildBaseCandidates(
  view: DiagnosticCatalogView,
  baseUrlVars: Record<string, string> | null,
): {
  readonly candidates: readonly DiagnosticBaseCandidate[];
  readonly hasUnresolvedDynamicBase: boolean;
} {
  const candidates: DiagnosticBaseCandidate[] = [];
  let hasUnresolvedDynamicBase = false;

  for (const api of view.apis) {
    const names = baseUrlVarNames(api.base);
    if (names.length === 0) {
      candidates.push({
        decisionBase: api.base,
        displayBase: stripTrailingSlash(api.base),
        routes: api.routes,
      });
      continue;
    }
    const executionTemplate = api.executionTemplate;
    if (!executionTemplate) {
      throw new Error(`Missing firewall execution base for ${view.type}`);
    }

    if (baseUrlVars) {
      const resolution = safeSync(() => {
        return resolveFirewallBaseUrlTemplate({
          serviceName: view.type,
          base: api.base,
          vars: baseUrlVars,
          credentialed: executionTemplate.credentialed,
          ...(executionTemplate.hostPolicy === undefined
            ? {}
            : { hostPolicy: executionTemplate.hostPolicy }),
        });
      });
      if ("error" in resolution) {
        if (!(resolution.error instanceof FirewallBaseUrlResolutionError)) {
          throw resolution.error;
        }
        hasUnresolvedDynamicBase = true;
        continue;
      }

      candidates.push({
        decisionBase: resolution.ok,
        displayBase: stripTrailingSlash(resolution.ok),
        routes: api.routes,
      });
      continue;
    }

    const pattern = dynamicTemplateToPattern(api.base);
    if (!pattern) {
      hasUnresolvedDynamicBase = true;
      continue;
    }
    candidates.push({
      decisionBase: pattern,
      displayBase: stripTrailingSlash(api.base),
      routes: api.routes,
    });
  }

  const seenDecisionBases = new Set<string>();
  for (const candidate of candidates) {
    const key = baseKey(candidate.decisionBase);
    if (seenDecisionBases.has(key)) {
      throw new Error(`Conflicting resolved firewall bases for ${view.type}`);
    }
    seenDecisionBases.add(key);
  }

  return { candidates, hasUnresolvedDynamicBase };
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

function matchDiagnosticRequest(
  view: DiagnosticCatalogView,
  request: ParsedDiagnosticRequest,
  candidates: readonly DiagnosticBaseCandidate[],
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
    const request = parseDiagnosticRequest(args.method, args.url);
    if (!("method" in request)) {
      return request;
    }

    const view = await loadDiagnosticCatalogView(args.connectorRef);
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

    const candidateResult = buildBaseCandidates(view, baseUrlVars);
    return matchDiagnosticRequest(
      view,
      request,
      candidateResult.candidates,
      candidateResult.hasUnresolvedDynamicBase,
    );
  },
);
