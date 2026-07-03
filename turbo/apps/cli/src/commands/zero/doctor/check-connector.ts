import { Command, Option } from "commander";
import {
  CONNECTOR_TYPES,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import {
  getConnectorEnvBindingEntries,
  getDiagnosticConnectorTypeForRuntimeEnvName,
} from "@vm0/connectors/connector-utils";
import {
  type FirewallBaseUrlMatch,
  type FirewallRequestDecision,
  matchFirewallBaseUrl,
  matchFirewallRequestDecision,
  type FirewallRoutingPermissionApi,
  type FirewallRoutingPermissionRoute,
} from "@vm0/connectors/firewall-rule-matcher";
import {
  type FirewallBaseHostPolicy,
  resolveFirewallBaseUrlTemplate,
  UNKNOWN_PERMISSION_GRANT,
  type NetworkPolicies,
} from "@vm0/connectors/firewall-types";
import {
  FIREWALL_ROUTING_METADATA_INDEX,
  loadFirewallRoutingMetadata,
  type FirewallRoutingMetadata,
} from "@vm0/connectors/firewall-metadata/routing";
import { getFirewallExecutionMetadata } from "@vm0/connectors/firewall-metadata/server";
import type { RunContextResponse } from "@vm0/api-contracts/contracts/zero-runs";
import { getApiUrl } from "../../../lib/api/config";
import {
  getZeroConnector,
  searchZeroConnectors,
} from "../../../lib/api/domains/zero-connectors";
import { getZeroAgentUserConnectors } from "../../../lib/api/domains/zero-agents";
import { getZeroRunContext } from "../../../lib/api/domains/zero-runs";
import { withErrorHandler } from "../../../lib/command";
import { toPlatformUrl } from "./platform-url";
import { decodeZeroTokenPayload } from "../../../lib/api/zero-token";

interface CheckConnectorOptions {
  envName?: string;
  url?: string;
  method: string;
  checkPermission?: string;
}

interface DiagContext {
  envName: string;
  connectorType: ConnectorType;
  label: string;
  connectorAvailable: boolean;
  platformOrigin: string;
  agentId: string | undefined;
}

interface RunConnectorState {
  readonly networkPolicies: NetworkPolicies | null;
  readonly configuredForRun: boolean | null;
}

interface DiagnosticRoutingConfig {
  type: ConnectorType;
  label: string;
  apis: readonly FirewallRoutingPermissionApi[];
}

interface DiagnosticDecisionPermission {
  readonly name: string;
  readonly rules: readonly string[];
}

interface DiagnosticDecisionApi {
  readonly base: string;
  readonly auth: Record<string, never>;
  readonly permissions: readonly DiagnosticDecisionPermission[];
}

interface DiagnosticDecisionFirewall {
  readonly name: ConnectorType;
  readonly apis: readonly DiagnosticDecisionApi[];
}

interface UrlLookupResult {
  connectorType: ConnectorType;
  envName: string;
  matchedBase: string;
  relativePath: string;
  routingConfig?: DiagnosticRoutingConfig;
}

type RunContextFirewall = RunContextResponse["firewalls"][number];
type RunContextInlineFirewall = Extract<RunContextFirewall, { apis: unknown }>;
type RunContextInlinePermission =
  RunContextInlineFirewall["apis"][number]["permissions"] extends
    | readonly (infer Permission)[]
    | undefined
    ? Permission
    : never;

function isConnectorType(type: string): type is ConnectorType {
  return type in CONNECTOR_TYPES;
}

async function connectorTypeIsAvailable(type: ConnectorType): Promise<boolean> {
  const catalog = await searchZeroConnectors();
  return catalog.connectors.some((connector) => {
    return connector.id === type;
  });
}

function connectorEnvName(type: ConnectorType): string | null {
  return getConnectorEnvBindingEntries(type)[0]?.envName ?? null;
}

function hasRoutingPermissionRules(config: DiagnosticRoutingConfig): boolean {
  return config.apis.some((api) => {
    return api.routes.length > 0;
  });
}

function routesToDecisionPermissions(
  routes: readonly FirewallRoutingPermissionRoute[],
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

  return [...rulesByPermission.entries()].map(([name, rules]) => {
    return { name, rules };
  });
}

function routingConfigToDecisionFirewalls(
  config: DiagnosticRoutingConfig,
): readonly DiagnosticDecisionFirewall[] {
  return [
    {
      name: config.type,
      apis: config.apis.map((api) => {
        return {
          base: api.base,
          auth: {},
          permissions: routesToDecisionPermissions(api.routes),
        };
      }),
    },
  ];
}

interface RoutingBaseExecutionTemplate {
  readonly credentialed: boolean;
  readonly hostPolicy?: FirewallBaseHostPolicy;
}

function routingBaseExecutionTemplate(
  type: ConnectorType,
  base: string,
): RoutingBaseExecutionTemplate {
  const executionMetadata = getFirewallExecutionMetadata(type);
  const template = executionMetadata?.baseUrlTemplates.find((entry) => {
    return entry.base === base;
  });
  return {
    credentialed: template?.credentialed ?? true,
    ...(template?.hostPolicy !== undefined
      ? { hostPolicy: template.hostPolicy }
      : {}),
  };
}

function routingConfigFromMetadata(
  metadata: FirewallRoutingMetadata,
  baseUrlVars: Record<string, string> | undefined,
  resolveBaseUrlVars: boolean,
): DiagnosticRoutingConfig {
  return {
    type: metadata.type,
    label: metadata.label,
    apis: metadata.apis.map((api) => {
      const template = routingBaseExecutionTemplate(metadata.type, api.base);
      return {
        base: resolveBaseUrlVars
          ? resolveFirewallBaseUrlTemplate({
              serviceName: metadata.type,
              base: api.base,
              vars: baseUrlVars,
              credentialed: template.credentialed,
              ...(template.hostPolicy !== undefined
                ? { hostPolicy: template.hostPolicy }
                : {}),
            })
          : api.base,
        routes: api.routes,
      };
    }),
  };
}

function runContextPermissionRoutes(
  permissions: readonly RunContextInlinePermission[] | undefined,
): FirewallRoutingPermissionApi["routes"] {
  const routes: { permissionName: string; rule: string }[] = [];
  const seenPermissionNames = new Set<string>();
  for (const permission of permissions ?? []) {
    if (seenPermissionNames.has(permission.name)) continue;
    seenPermissionNames.add(permission.name);
    for (const rule of permission.rules) {
      routes.push({
        permissionName: permission.name,
        rule,
      });
    }
  }
  return routes;
}

function routingConfigFromInlineRunContext(
  firewall: RunContextInlineFirewall,
): DiagnosticRoutingConfig | null {
  if (!isConnectorType(firewall.name)) {
    return null;
  }
  return {
    type: firewall.name,
    label: CONNECTOR_TYPES[firewall.name].label,
    apis: firewall.apis.map((api) => {
      return {
        base: api.base,
        routes: runContextPermissionRoutes(api.permissions),
      };
    }),
  };
}

/**
 * Reverse-lookup a full URL to find which connector handles it.
 * Iterates routing index base URLs and checks if the URL
 * starts with any registered base URL (scheme + host + optional path prefix).
 */
function resolveConnectorFromUrl(url: string): UrlLookupResult | null {
  let bestMatch: {
    connectorType: ConnectorType;
    match: FirewallBaseUrlMatch;
  } | null = null;

  for (const metadata of Object.values(FIREWALL_ROUTING_METADATA_INDEX)) {
    for (const api of metadata.apis) {
      const match = matchFirewallBaseUrl(url, api.base);
      if (match !== null) {
        // Pick the longest (most specific) base URL match
        if (!bestMatch || match.score > bestMatch.match.score) {
          bestMatch = { connectorType: metadata.type, match };
        }
      }
    }
  }

  if (!bestMatch) return null;

  // Derive the environment name from the connector's configured env bindings.
  const envName = connectorEnvName(bestMatch.connectorType);
  if (!envName) return null;

  return {
    connectorType: bestMatch.connectorType,
    envName,
    matchedBase: bestMatch.match.displayBase,
    relativePath: bestMatch.match.relativePath,
  };
}

async function runContextFirewallRoutingConfig(
  firewall: RunContextFirewall,
): Promise<DiagnosticRoutingConfig | null> {
  if ("apis" in firewall) {
    return routingConfigFromInlineRunContext(firewall);
  }
  if (!isConnectorType(firewall.name)) {
    return null;
  }
  const metadata = await loadFirewallRoutingMetadata(firewall.name);
  if (!metadata) return null;
  return routingConfigFromMetadata(metadata, firewall.baseUrlVars, true);
}

async function resolveConnectorFromRunContext(
  url: string,
  runContext: RunContextResponse,
): Promise<UrlLookupResult | null> {
  let bestMatch: {
    connectorType: ConnectorType;
    match: FirewallBaseUrlMatch;
    routingConfig: DiagnosticRoutingConfig;
  } | null = null;

  for (const firewall of runContext.firewalls) {
    if (!isConnectorType(firewall.name)) continue;
    const routingConfig = await runContextFirewallRoutingConfig(firewall);
    if (!routingConfig) continue;
    for (const api of routingConfig.apis) {
      const match = matchFirewallBaseUrl(url, api.base);
      if (match === null) continue;
      if (!bestMatch || match.score > bestMatch.match.score) {
        bestMatch = {
          connectorType: firewall.name,
          match,
          routingConfig,
        };
      }
    }
  }

  if (!bestMatch) return null;

  const envName = connectorEnvName(bestMatch.connectorType);
  if (!envName) return null;

  return {
    connectorType: bestMatch.connectorType,
    envName,
    matchedBase: bestMatch.match.displayBase,
    relativePath: bestMatch.match.relativePath,
    ...(hasRoutingPermissionRules(bestMatch.routingConfig)
      ? { routingConfig: bestMatch.routingConfig }
      : {}),
  };
}

async function getCurrentRunContext(): Promise<RunContextResponse | null> {
  const payload = decodeZeroTokenPayload();
  const runId = payload?.runId;
  if (!runId) return null;
  return await getZeroRunContext(runId);
}

function printConnectorConnectionStatus(
  ctx: DiagContext,
  isConnected: boolean,
  isExpired: boolean,
  hasPermission: boolean,
): void {
  console.log(
    `### 2a: Connector status (user must configure via OAuth login or API key)`,
  );
  console.log("");
  if (!ctx.connectorAvailable) {
    console.log(
      `The ${ctx.label} connector is not available for this account.`,
    );
  } else if (!isConnected) {
    console.log(`The ${ctx.label} connector is not connected.`);
    if (ctx.agentId && hasPermission) {
      const connectUrl = `${ctx.platformOrigin}/connectors/${ctx.connectorType}/connect?agentId=${ctx.agentId}`;
      console.log(`Connect it at: [Connect ${ctx.label}](${connectUrl})`);
    } else if (!ctx.agentId) {
      // No agentId: can't scope the authorize page, so fall back to a plain
      // connect link. With agentId, 2b's Authorize link performs the initial
      // OAuth connect before granting permission — one link covers both steps.
      const connectUrl = `${ctx.platformOrigin}/connectors/${ctx.connectorType}/connect`;
      console.log(`Connect it at: [Connect ${ctx.label}](${connectUrl})`);
    }
  } else if (isExpired) {
    const url = `${ctx.platformOrigin}/connectors`;
    console.log(
      `The ${ctx.label} connector is connected but has expired and needs to be reconnected.`,
    );
    console.log(`Reconnect it at: [Reconnect ${ctx.label}](${url})`);
  } else {
    console.log(`The ${ctx.label} connector is connected and active.`);
  }
  console.log("");
}

function printAgentAuthorizationStatus(
  ctx: DiagContext,
  isConnected: boolean,
  isExpired: boolean,
  hasPermission: boolean,
): void {
  if (!ctx.agentId) {
    console.log("ZERO_AGENT_ID is not set — cannot check agent authorization.");
  } else if (isExpired) {
    // The /authorize page treats an expired connector as "already connected"
    // and won't re-trigger OAuth. Defer to 2a's Reconnect link in that case.
    console.log(
      `Skipped — agent authorization can only be checked once the ${ctx.label} connector is reconnected (see 2a).`,
    );
  } else if (hasPermission) {
    console.log(
      isConnected
        ? `The ${ctx.label} connector is authorized for this agent.`
        : `The ${ctx.label} connector is authorized for this agent, but it is not connected.`,
    );
  } else {
    const url = `${ctx.platformOrigin}/connectors/${ctx.connectorType}/authorize?agentId=${ctx.agentId}`;
    console.log(
      isConnected
        ? `The ${ctx.label} connector is not authorized for this agent (${ctx.agentId}).`
        : `The ${ctx.label} connector needs to be connected and authorized for this agent (${ctx.agentId}).`,
    );
    console.log(`Authorize it at: [Authorize ${ctx.label}](${url})`);
  }
}

function printConnectorAuthorizationStatus(
  ctx: DiagContext,
  isConnected: boolean,
  isExpired: boolean,
  hasPermission: boolean,
): void {
  console.log(
    `### 2b: Agent authorization (user must authorize agent to use this connector)`,
  );
  console.log("");
  if (!ctx.connectorAvailable) {
    console.log(
      `Skipped — the ${ctx.label} connector is not available for this account.`,
    );
  } else {
    printAgentAuthorizationStatus(ctx, isConnected, isExpired, hasPermission);
  }
  console.log(
    `This run uses agent-scoped connector authorization for ${ctx.label} access.`,
  );
  console.log("");
}

function checkEnvName(ctx: DiagContext): boolean {
  console.log("## Step 1: Sandbox environment name");
  console.log("");
  const envPresent = Boolean(process.env[ctx.envName]);
  console.log(
    `Checking process.env.${ctx.envName}: ${envPresent ? "present" : "not present"}`,
  );
  if (envPresent) {
    console.log(
      "A placeholder value is present in the sandbox environment. This value is not the real credential — it is a stand-in that gets replaced at the network boundary when requests are sent to registered base URLs.",
    );
  } else {
    console.log(
      "No value found for this environment name. Note: credential replacement at the network boundary is independent of this name — the proxy injects auth headers based on the destination URL.",
    );
  }
  console.log("");
  return envPresent;
}

async function checkConnectorStatus(ctx: DiagContext): Promise<{
  isConnected: boolean;
  isExpired: boolean;
  hasPermission: boolean;
}> {
  console.log("## Step 2: Connector configuration");
  console.log("");
  console.log(
    "A Connector holds the real credentials (OAuth tokens or API keys) for an external service. These credentials are never injected into the sandbox. Instead, when the sandbox sends an HTTP request to a base URL registered by the Connector, the network boundary intercepts the request and replaces the auth headers with real credentials. For this to work, three conditions must be met:",
  );
  console.log("");

  const [connector, enabledTypes] = await Promise.all([
    getZeroConnector(ctx.connectorType),
    ctx.agentId
      ? getZeroAgentUserConnectors(ctx.agentId)
      : Promise.resolve(null),
  ]);

  const isConnected = connector !== null;
  const isExpired = connector?.connectionStatus === "reconnect-required";
  const hasPermission =
    enabledTypes !== null && enabledTypes.includes(ctx.connectorType);

  printConnectorConnectionStatus(ctx, isConnected, isExpired, hasPermission);
  printConnectorAuthorizationStatus(ctx, isConnected, isExpired, hasPermission);

  return { isConnected, isExpired, hasPermission };
}

async function checkConnectorDomains(
  ctx: DiagContext,
  preloadedRunContext?: RunContextResponse | null,
): Promise<RunConnectorState> {
  // 2c: Registered base URLs — connector defines which URL prefixes get credential replacement
  console.log(
    `### 2c: Registered base URLs (credential replacement only applies to URLs matching these prefixes)`,
  );
  console.log("");

  const runContext =
    preloadedRunContext === undefined
      ? await getCurrentRunContext()
      : preloadedRunContext;
  if (!runContext) {
    console.log(
      "Cannot determine run ID from ZERO_TOKEN — skipping base URL check.",
    );
    console.log("");
    return { networkPolicies: null, configuredForRun: null };
  }

  const configuredForRun = await printConnectorDomains(ctx, runContext);
  console.log("");
  return { networkPolicies: runContext.networkPolicies, configuredForRun };
}

async function printConnectorDomains(
  ctx: DiagContext,
  runContext: RunContextResponse,
): Promise<boolean> {
  const matchingEntry = runContext.firewalls.find((fw) => {
    return fw.name === ctx.connectorType;
  });

  if (!matchingEntry) {
    console.log(
      `No configuration found for the ${ctx.label} connector in this run.`,
    );
    console.log(
      "This means no base URLs are registered for credential replacement for this connector.",
    );
    return false;
  }
  const routingConfig = await runContextFirewallRoutingConfig(matchingEntry);
  if (!routingConfig) {
    console.log(
      `No configuration found for the ${ctx.label} connector in this run.`,
    );
    console.log(
      "This means no base URLs are registered for credential replacement for this connector.",
    );
    return false;
  }

  console.log(
    `The ${ctx.label} connector is configured for this run with the following base URLs:`,
  );
  for (const api of routingConfig.apis) {
    console.log(`  - ${api.base}`);
  }
  console.log("");
  console.log(
    "When the sandbox sends an HTTP request matching one of these URL prefixes, the network boundary intercepts the request and injects real credentials into the auth headers.",
  );

  const secretNames =
    getFirewallExecutionMetadata(ctx.connectorType)?.secretPlaceholderNames ??
    [];
  if (secretNames.length > 0) {
    console.log(`Credentials resolved from: ${secretNames.join(", ")}`);
  }
  return true;
}

function checkPermissionPolicy(
  connectorType: ConnectorType,
  label: string,
  permissionName: string,
  networkPolicies: NetworkPolicies | null,
  configuredForRun: boolean | null,
): void {
  console.log("## Step 3: Permission policy check");
  console.log("");
  console.log(
    `Checking permission: "${permissionName}" for the ${label} connector.`,
  );
  console.log(
    `Beyond credential replacement, the ${label} connector enforces permission policies on each API path. A request either matches a named permission or falls through to the unknown-endpoint policy.`,
  );
  console.log("");

  if (!networkPolicies) {
    console.log(
      "Network policies are not available for this run — cannot check permission status.",
    );
    console.log("");
    return;
  }

  const connectorPolicies = networkPolicies[connectorType];

  if (!connectorPolicies) {
    if (configuredForRun === false) {
      console.log(
        `No policy entry found because the ${label} connector is not configured for this run.`,
      );
      console.log(
        "Requests for this connector cannot receive credentials in the current run.",
      );
      console.log("");
      return;
    }
    console.log(
      `No policy entry found for the ${label} connector in this run's network policies.`,
    );
    console.log(
      "When a connector has no policy entry, all requests are fully permissive (allowed).",
    );
    console.log("");
    return;
  }

  console.log(`Permission policies for the ${label} connector:`);
  console.log(`  allow list: [${connectorPolicies.allow.join(", ")}]`);
  console.log(`  deny list:  [${connectorPolicies.deny.join(", ")}]`);
  console.log(`  ask list:   [${connectorPolicies.ask.join(", ")}]`);
  console.log(`  unknown endpoint policy: ${connectorPolicies.unknownPolicy}`);
  console.log("");

  const isInAllow = connectorPolicies.allow.includes(permissionName);
  const isInDeny = connectorPolicies.deny.includes(permissionName);
  const isInAsk = connectorPolicies.ask.includes(permissionName);

  if (isInDeny) {
    console.log(
      `Result: "${permissionName}" is in the deny list. Requests matching this permission are denied.`,
    );
  } else if (isInAsk) {
    console.log(
      `Result: "${permissionName}" is in the ask list. Requests matching this permission are blocked until approval.`,
    );
  } else if (isInAllow) {
    console.log(
      `Result: "${permissionName}" is in the allow list. Requests matching this permission are allowed.`,
    );
  } else {
    console.log(
      `Result: "${permissionName}" is not in the deny or ask list. Requests matching this permission are allowed; the unknown endpoint policy only applies when no named permission matches a request.`,
    );
  }
  console.log("");
}

function unknownPermissionChangeCommand(connectorRef: string): string {
  return `zero doctor permission-change ${connectorRef} --permission ${UNKNOWN_PERMISSION_GRANT} --enable --duration 1h`;
}

function matchedPermissionsFromDecision(
  decision: FirewallRequestDecision,
): string[] {
  if (decision.kind === "allow") {
    return decision.permission === undefined ? [] : [decision.permission];
  }
  if (decision.kind === "block" && decision.reason === "permission_denied") {
    return [...decision.permissions];
  }
  return [];
}

function printMatchedPermissionsSummary(
  method: string,
  relativePath: string,
  decision: FirewallRequestDecision,
): void {
  const matchedPermissions = matchedPermissionsFromDecision(decision);
  if (matchedPermissions.length > 0) {
    console.log(`Matched permissions: [${matchedPermissions.join(", ")}]`);
    return;
  }

  if (
    decision.kind === "allow" ||
    (decision.kind === "block" && decision.reason === "unknown_endpoint")
  ) {
    console.log(
      `No named permission matches ${method} ${relativePath}. This request falls through to the unknown-endpoint policy.`,
    );
    return;
  }

  if (decision.kind === "no_match") {
    console.log(
      "No connector firewall base matched this request during final permission evaluation.",
    );
    return;
  }

  if (decision.reason === "malformed_firewall_config") {
    console.log(
      "Permission matching could not complete because the matched firewall config is malformed.",
    );
    return;
  }

  if (decision.reason === "malformed_network_policy") {
    console.log(
      "Permission matching could not complete because the matched network policy is malformed.",
    );
    return;
  }

  console.log(
    "Permission matching could not complete because the request path contains unsafe path syntax.",
  );
}

function printAllowedPermissionResult(
  permission: string,
  connectorPolicies: NetworkPolicies[string],
): void {
  if (connectorPolicies.allow.includes(permission)) {
    console.log(`Result: "${permission}" is in the allow list — allowed.`);
    return;
  }
  console.log(
    `Result: "${permission}" is not blocked by the deny or ask list — allowed.`,
  );
}

function printDeniedPermissionResult(
  permission: string,
  connectorPolicies: NetworkPolicies[string],
): void {
  if (connectorPolicies.deny.includes(permission)) {
    console.log(`Result: "${permission}" is in the deny list — denied.`);
    return;
  }
  if (connectorPolicies.ask.includes(permission)) {
    console.log(`Result: "${permission}" is in the ask list — blocked.`);
    return;
  }
  console.log(`Result: "${permission}" is blocked by permission policy.`);
}

function printFirewallDecisionResult(
  connectorType: ConnectorType,
  decision: FirewallRequestDecision,
  connectorPolicies: NetworkPolicies[string],
): void {
  if (decision.kind === "allow") {
    if (decision.permission === undefined) {
      console.log(
        "Result: No permission matched. The unknown endpoint policy applies: allow.",
      );
      return;
    }
    printAllowedPermissionResult(decision.permission, connectorPolicies);
    return;
  }

  if (decision.kind === "no_match") {
    console.log("Result: No connector firewall base matched this request.");
    return;
  }

  switch (decision.reason) {
    case "permission_denied":
      for (const permission of decision.permissions) {
        printDeniedPermissionResult(permission, connectorPolicies);
      }
      return;
    case "unknown_endpoint":
      console.log(
        `Result: No permission matched. The unknown endpoint policy applies: ${connectorPolicies.unknownPolicy}.`,
      );
      console.log(
        `To allow unknown endpoints, run: ${unknownPermissionChangeCommand(connectorType)}`,
      );
      return;
    case "malformed_firewall_config":
      console.log(
        "Result: The matched firewall config is malformed, so the request is blocked.",
      );
      return;
    case "malformed_network_policy":
      console.log(
        "Result: The matched network policy is malformed, so the request is blocked.",
      );
      return;
    case "unsafe_path":
      console.log(
        "Result: The request path contains unsafe path syntax, so the request is blocked.",
      );
      return;
  }
}

/**
 * When --url is provided, auto-detect the matching permission by running
 * the URL's relative path against the connector's firewall rules.
 */
async function resolvePermissionFromUrl(
  connectorType: ConnectorType,
  label: string,
  method: string,
  url: string,
  relativePath: string,
  matchedBase: string,
  routingConfig: DiagnosticRoutingConfig | undefined,
  networkPolicies: NetworkPolicies | null,
  configuredForRun: boolean | null,
): Promise<void> {
  console.log("## Step 3: Permission policy check (auto-detected from URL)");
  console.log("");
  console.log(
    `Matching ${method} ${relativePath} (relative to base URL ${matchedBase}) against the ${label} connector's permission rules.`,
  );
  console.log("");

  let config = routingConfig;
  if (!config) {
    const metadata = await loadFirewallRoutingMetadata(connectorType);
    config = metadata
      ? routingConfigFromMetadata(metadata, undefined, false)
      : undefined;
  }
  if (!config) {
    console.log(
      `The ${label} connector does not have permission rules defined.`,
    );
    console.log("");
    return;
  }

  const decision = matchFirewallRequestDecision(
    routingConfigToDecisionFirewalls(config),
    method,
    url,
    networkPolicies,
  );
  printMatchedPermissionsSummary(method, relativePath, decision);
  console.log("");

  if (!networkPolicies) {
    console.log(
      "Network policies are not available for this run — cannot check allow/deny status.",
    );
    console.log("");
    return;
  }

  const connectorPolicies = networkPolicies[connectorType];

  if (!connectorPolicies) {
    if (configuredForRun === false) {
      console.log(
        `No policy entry found because the ${label} connector is not configured for this run.`,
      );
      console.log(
        "Requests for this connector cannot receive credentials in the current run.",
      );
      console.log("");
      return;
    }
    console.log(
      `No policy entry found for the ${label} connector. All requests are fully permissive (allowed).`,
    );
    console.log("");
    return;
  }

  console.log(`Permission policies for the ${label} connector:`);
  console.log(`  allow list: [${connectorPolicies.allow.join(", ")}]`);
  console.log(`  deny list:  [${connectorPolicies.deny.join(", ")}]`);
  console.log(`  ask list:   [${connectorPolicies.ask.join(", ")}]`);
  console.log(`  unknown endpoint policy: ${connectorPolicies.unknownPolicy}`);
  console.log("");

  printFirewallDecisionResult(connectorType, decision, connectorPolicies);
  console.log("");
}

export const checkConnectorCommand = new Command()
  .name("check-connector")
  .description(
    "Diagnose connector health: environment name, connector configuration, and permission policies",
  )
  .addOption(
    new Option(
      "--env-name <ENV_NAME>",
      "The connector environment name to check (e.g. GITHUB_TOKEN)",
    ),
  )
  .addOption(
    new Option(
      "--url <URL>",
      "A full URL to diagnose — auto-detects the connector, environment name, and permission (e.g. https://api.github.com/repos/owner/repo)",
    ),
  )
  .addOption(
    new Option(
      "--method <METHOD>",
      "HTTP method to use when matching permissions with --url (default: GET)",
    ).default("GET"),
  )
  .addOption(
    new Option(
      "--check-permission <name>",
      "Check whether a specific permission is allowed or denied (e.g. contents:read)",
    ),
  )
  .addHelpText(
    "after",
    `
Examples:
  zero doctor check-connector --env-name GITHUB_TOKEN
  zero doctor check-connector --url https://api.github.com/repos/owner/repo
  zero doctor check-connector --url https://slack.com/api/chat.postMessage --method POST
  zero doctor check-connector --env-name SLACK_TOKEN --check-permission chat:write

How connectors work:
  A Connector holds the real credentials for an external service. These credentials
  are never injected into the sandbox. Instead, when the sandbox sends an HTTP
  request to a base URL registered by the Connector, the network boundary intercepts
  the request and replaces the auth headers with real credentials.

  This command checks each part of that pipeline and reports what it finds.`,
  )
  .action(
    withErrorHandler(async (opts: CheckConnectorOptions) => {
      if (!opts.envName && !opts.url) {
        throw new Error(
          "Either --env-name or --url is required. Use --help for usage.",
        );
      }

      let envName: string;
      let connectorType: ConnectorType;
      let urlLookup: UrlLookupResult | null = null;
      let runContext: RunContextResponse | null | undefined;

      if (opts.url) {
        runContext = await getCurrentRunContext();
        if (runContext) {
          urlLookup = await resolveConnectorFromRunContext(
            opts.url,
            runContext,
          );
        }
        if (!urlLookup) {
          urlLookup = await resolveConnectorFromUrl(opts.url);
        }
        if (!urlLookup) {
          throw new Error(
            `No connector found for URL: ${opts.url} — no registered base URL matches this URL`,
          );
        }
        connectorType = urlLookup.connectorType;
        envName = opts.envName ?? urlLookup.envName;
        console.log(
          `URL ${opts.url} matches the ${CONNECTOR_TYPES[connectorType].label} connector (type: ${connectorType}).`,
        );
        console.log(`  Matched base URL: ${urlLookup.matchedBase}`);
        console.log(`  Relative path:    ${urlLookup.relativePath}`);
        console.log(`  Environment name:  ${envName}`);
      } else {
        envName = opts.envName!;
        const resolvedConnectorType =
          getDiagnosticConnectorTypeForRuntimeEnvName(envName);
        if (!resolvedConnectorType) {
          throw new Error(
            `Unknown environment name: ${envName} — not managed by any connector`,
          );
        }
        connectorType = resolvedConnectorType;
        console.log(
          `${envName} is managed by the ${CONNECTOR_TYPES[connectorType].label} connector (type: ${connectorType}).`,
        );
      }
      console.log("");

      const { label } = CONNECTOR_TYPES[connectorType];
      const [apiUrl, connectorAvailable] = await Promise.all([
        getApiUrl(),
        connectorTypeIsAvailable(connectorType),
      ]);
      const platformUrl = toPlatformUrl(apiUrl);

      const ctx: DiagContext = {
        envName,
        connectorType,
        label,
        connectorAvailable,
        platformOrigin: platformUrl.origin,
        agentId: process.env.ZERO_AGENT_ID || undefined,
      };

      checkEnvName(ctx);
      const { isConnected, isExpired, hasPermission } =
        await checkConnectorStatus(ctx);
      const { networkPolicies, configuredForRun } = await checkConnectorDomains(
        ctx,
        runContext,
      );

      // Summary for Step 2
      if (configuredForRun === false) {
        console.log(
          `Steps 1-2 summary: The ${label} connector is not configured for this run. Check the agent authorization settings, then start a new run after updating them.`,
        );
      } else if (isConnected && !isExpired && hasPermission) {
        console.log(
          `Steps 1-2 summary: The ${label} connector is connected, active, and authorized. Outbound requests to the registered base URLs will have credentials injected at the network boundary.`,
        );
      }
      console.log("");

      // Step 3: Permission policy check
      const diagnosedUrl = opts.url;
      if (urlLookup && diagnosedUrl) {
        // --url mode: auto-detect permission from URL path
        await resolvePermissionFromUrl(
          connectorType,
          label,
          opts.method,
          diagnosedUrl,
          urlLookup.relativePath,
          urlLookup.matchedBase,
          urlLookup.routingConfig,
          networkPolicies,
          configuredForRun,
        );
      } else if (opts.checkPermission) {
        // --env-name mode with explicit --check-permission
        checkPermissionPolicy(
          connectorType,
          label,
          opts.checkPermission,
          networkPolicies,
          configuredForRun,
        );
      }

      // Re-diagnose hint
      const args: string[] = [];
      if (opts.url) {
        args.push(`--url ${opts.url}`);
        if (opts.method !== "GET") {
          args.push(`--method ${opts.method}`);
        }
      } else {
        args.push(`--env-name ${envName}`);
      }
      if (opts.checkPermission) {
        args.push(`--check-permission ${opts.checkPermission}`);
      }
      console.log(
        `To re-diagnose after changes, run: zero doctor check-connector ${args.join(" ")}`,
      );
    }),
  );
