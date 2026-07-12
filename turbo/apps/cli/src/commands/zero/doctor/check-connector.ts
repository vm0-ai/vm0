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
  type FirewallConnectorIntent,
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
  connector?: string;
  envName?: string;
  url?: string;
  method: string;
  checkPermission?: string;
}

interface DiagContext {
  environmentNames: readonly string[] | null;
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

interface DiagnosticRoutingApi extends FirewallRoutingPermissionApi {
  readonly environmentNames: readonly string[] | null;
}

interface DiagnosticRoutingConfig {
  readonly type: ConnectorType;
  readonly label: string;
  readonly apis: readonly DiagnosticRoutingApi[];
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
  readonly name: string;
  readonly apis: readonly DiagnosticDecisionApi[];
}

type SelectedFirewallRequestDecision = Extract<
  FirewallRequestDecision,
  { readonly kind: "allow" | "block" }
>;

interface UrlDiagnosticResult {
  readonly connectorType: ConnectorType;
  readonly routingConfig: DiagnosticRoutingConfig;
  readonly decision: SelectedFirewallRequestDecision;
  readonly environmentNames: readonly string[] | null;
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
  return Object.hasOwn(CONNECTOR_TYPES, type);
}

async function connectorTypeIsAvailable(type: ConnectorType): Promise<boolean> {
  const catalog = await searchZeroConnectors();
  return catalog.connectors.some((connector) => {
    return connector.id === type;
  });
}

function stripUrlQueryAndFragment(url: string): string {
  const queryIndex = url.indexOf("?");
  const fragmentIndex = url.indexOf("#");
  let end = url.length;
  if (queryIndex !== -1) end = Math.min(end, queryIndex);
  if (fragmentIndex !== -1) end = Math.min(end, fragmentIndex);
  return url.slice(0, end);
}

function shellQuoteArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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

function routingConfigsToDecisionFirewalls(
  configs: readonly DiagnosticRoutingConfig[],
): readonly DiagnosticDecisionFirewall[] {
  return configs.map((config) => {
    return {
      name: config.type,
      apis: config.apis.map((api) => {
        return {
          base: api.base,
          auth: {},
          permissions: routesToDecisionPermissions(api.routes),
        };
      }),
    };
  });
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
        environmentNames: api.environmentNames,
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

function inlineApiEnvironmentNames(
  base: string,
  metadata: FirewallRoutingMetadata | null,
): readonly string[] | null {
  if (!metadata) return null;
  const [first, ...otherApis] = metadata.apis.filter((api) => {
    return api.base === base;
  });
  if (!first) return null;
  for (const api of otherApis) {
    if (
      api.environmentNames.length !== first.environmentNames.length ||
      api.environmentNames.some((name, index) => {
        return name !== first.environmentNames[index];
      })
    ) {
      return null;
    }
  }
  return first.environmentNames;
}

function routingConfigFromInlineRunContext(
  firewall: RunContextInlineFirewall,
  metadata: FirewallRoutingMetadata | null,
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
        environmentNames: inlineApiEnvironmentNames(api.base, metadata),
      };
    }),
  };
}

async function runContextFirewallRoutingConfig(
  firewall: RunContextFirewall,
): Promise<DiagnosticRoutingConfig | null> {
  if ("apis" in firewall) {
    if (!isConnectorType(firewall.name)) return null;
    const metadata = await loadFirewallRoutingMetadata(firewall.name);
    return routingConfigFromInlineRunContext(firewall, metadata);
  }
  if (!isConnectorType(firewall.name)) {
    return null;
  }
  const metadata = await loadFirewallRoutingMetadata(firewall.name);
  if (!metadata) return null;
  return routingConfigFromMetadata(metadata, firewall.baseUrlVars, true);
}

function mergeRoutingConfigs(
  configs: readonly DiagnosticRoutingConfig[],
): DiagnosticRoutingConfig[] {
  const merged = new Map<ConnectorType, DiagnosticRoutingConfig>();
  for (const config of configs) {
    const existing = merged.get(config.type);
    merged.set(config.type, {
      type: config.type,
      label: config.label,
      apis: existing ? [...existing.apis, ...config.apis] : config.apis,
    });
  }
  return [...merged.values()];
}

async function loadRunContextRoutingConfigs(
  runContext: RunContextResponse,
): Promise<DiagnosticRoutingConfig[]> {
  const configs = await Promise.all(
    runContext.firewalls.map(async (firewall) => {
      return await runContextFirewallRoutingConfig(firewall);
    }),
  );
  return mergeRoutingConfigs(
    configs.filter((config): config is DiagnosticRoutingConfig => {
      return config !== null;
    }),
  );
}

async function loadGeneratedRoutingConfigs(
  url: string,
): Promise<DiagnosticRoutingConfig[]> {
  let bestScore: number | null = null;
  const connectorTypes = new Set<ConnectorType>();
  for (const metadata of Object.values(FIREWALL_ROUTING_METADATA_INDEX)) {
    for (const api of metadata.apis) {
      const match = matchFirewallBaseUrl(url, api.base);
      if (match === null) continue;
      if (bestScore === null || match.score > bestScore) {
        bestScore = match.score;
        connectorTypes.clear();
      }
      if (match.score === bestScore) {
        connectorTypes.add(metadata.type);
      }
    }
  }

  const configs = await Promise.all(
    [...connectorTypes].sort().map(async (type) => {
      const metadata = await loadFirewallRoutingMetadata(type);
      return metadata
        ? routingConfigFromMetadata(metadata, undefined, false)
        : null;
    }),
  );
  return configs.filter((config): config is DiagnosticRoutingConfig => {
    return config !== null;
  });
}

function decisionOwnerNames(
  decision: FirewallRequestDecision,
): readonly string[] {
  if (decision.kind === "ambiguous") return decision.candidates;
  if (decision.kind === "allow" || decision.kind === "block") {
    return [decision.firewallName];
  }
  return [];
}

function environmentNamesForWinningApis(
  config: DiagnosticRoutingConfig,
  method: string,
  url: string,
): readonly string[] | null {
  const apisByOwner = new Map<string, DiagnosticRoutingApi>();
  const firewalls = config.apis.map((api, index) => {
    const name = `diagnostic-api-${index}`;
    apisByOwner.set(name, api);
    return {
      name,
      apis: [
        {
          base: api.base,
          auth: {},
          permissions: routesToDecisionPermissions(api.routes),
        },
      ],
    } satisfies DiagnosticDecisionFirewall;
  });
  const decision = matchFirewallRequestDecision(firewalls, method, url);
  const names = new Set<string>();
  let found = false;
  for (const owner of decisionOwnerNames(decision)) {
    const api = apisByOwner.get(owner);
    if (!api) continue;
    found = true;
    if (api.environmentNames === null) return null;
    for (const name of api.environmentNames) names.add(name);
  }
  return found ? [...names].sort() : null;
}

function connectorSelectionCommand(
  url: string,
  method: string,
  connectorType: string,
): string {
  const args = [
    `--url ${shellQuoteArg(stripUrlQueryAndFragment(url))}`,
    `--connector ${shellQuoteArg(connectorType)}`,
  ];
  if (method !== "GET") args.push(`--method ${shellQuoteArg(method)}`);
  return `zero doctor check-connector ${args.join(" ")}`;
}

function ambiguousConnectorError(
  decision: Extract<FirewallRequestDecision, { readonly kind: "ambiguous" }>,
  url: string,
): Error {
  const candidates = [...decision.candidates].sort();
  const commands = candidates.map((candidate) => {
    return `  ${connectorSelectionCommand(url, decision.method, candidate)}`;
  });
  return new Error(
    `Multiple connectors match ${decision.method} ${stripUrlQueryAndFragment(url)} at the same route specificity: ${candidates.join(", ")}\nSelect one explicitly:\n${commands.join("\n")}`,
  );
}

async function resolveUrlDiagnostic(
  url: string,
  method: string,
  requestedConnector: ConnectorType | undefined,
  runContext: RunContextResponse | null,
): Promise<UrlDiagnosticResult> {
  const routingConfigs = runContext
    ? await loadRunContextRoutingConfigs(runContext)
    : await loadGeneratedRoutingConfigs(url);
  const connectorIntent: FirewallConnectorIntent = requestedConnector
    ? { status: "present", value: requestedConnector }
    : { status: "absent" };
  const decision = matchFirewallRequestDecision(
    routingConfigsToDecisionFirewalls(routingConfigs),
    method,
    url,
    runContext?.networkPolicies,
    connectorIntent,
  );

  if (decision.kind === "ambiguous") {
    throw ambiguousConnectorError(decision, url);
  }
  if (decision.kind === "no_match") {
    throw new Error(
      runContext
        ? "No connector found for provided URL — no firewall in the current run matches this URL"
        : "No connector found for provided URL — no registered base URL matches this URL",
    );
  }
  if (decision.kind === "block" && decision.reason === "unsafe_path") {
    throw new Error(
      `Cannot diagnose ${method} ${stripUrlQueryAndFragment(url)} because the request path contains unsafe syntax`,
    );
  }
  if (!isConnectorType(decision.firewallName)) {
    throw new Error("The matched firewall is not a registered connector");
  }
  if (
    requestedConnector !== undefined &&
    decision.firewallName !== requestedConnector
  ) {
    throw new Error(
      `Connector ${requestedConnector} does not own ${method} ${stripUrlQueryAndFragment(url)}; the matching connector is ${decision.firewallName}\nRun: ${connectorSelectionCommand(url, method, decision.firewallName)}`,
    );
  }

  const routingConfig = routingConfigs.find((config) => {
    return config.type === decision.firewallName;
  });
  if (!routingConfig) {
    throw new Error("The matched connector routing metadata is unavailable");
  }

  return {
    connectorType: decision.firewallName,
    routingConfig,
    decision,
    environmentNames: environmentNamesForWinningApis(
      routingConfig,
      method,
      url,
    ),
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

function connectorEnvironmentValueRefs(
  connectorType: ConnectorType,
  environmentName: string,
): ReadonlySet<string> {
  const refs = new Set<string>();
  for (const entry of getConnectorEnvBindingEntries(connectorType)) {
    if (entry.envName === environmentName) refs.add(entry.valueRef);
  }
  return refs;
}

function environmentNameSupportsRoute(
  connectorType: ConnectorType,
  environmentName: string,
  routeEnvironmentNames: readonly string[],
): boolean {
  const explicitRefs = connectorEnvironmentValueRefs(
    connectorType,
    environmentName,
  );
  return routeEnvironmentNames.some((routeEnvironmentName) => {
    if (routeEnvironmentName === environmentName) return true;
    const routeRefs = connectorEnvironmentValueRefs(
      connectorType,
      routeEnvironmentName,
    );
    return [...explicitRefs].some((ref) => {
      return routeRefs.has(ref);
    });
  });
}

function resolveUrlEnvironmentNames(
  connectorType: ConnectorType,
  routeEnvironmentNames: readonly string[] | null,
  requestedEnvironmentName: string | undefined,
): readonly string[] | null {
  if (requestedEnvironmentName === undefined) return routeEnvironmentNames;
  const ownedByConnector = getConnectorEnvBindingEntries(connectorType).some(
    (entry) => {
      return entry.envName === requestedEnvironmentName;
    },
  );
  if (!ownedByConnector) {
    throw new Error(
      `${requestedEnvironmentName} is not an environment name for the ${CONNECTOR_TYPES[connectorType].label} connector. Remove --env-name to use the matched route metadata.`,
    );
  }
  if (
    routeEnvironmentNames !== null &&
    !environmentNameSupportsRoute(
      connectorType,
      requestedEnvironmentName,
      routeEnvironmentNames,
    )
  ) {
    throw new Error(
      `${requestedEnvironmentName} is not used by the matched API route. Expected one of: ${routeEnvironmentNames.join(", ") || "none"}. Remove --env-name to use the matched route metadata.`,
    );
  }
  return [requestedEnvironmentName];
}

function checkEnvironmentNames(ctx: DiagContext): void {
  console.log("## Step 1: Sandbox environment name");
  console.log("");
  if (ctx.environmentNames === null) {
    console.log(
      "Environment metadata is unavailable for this run's sanitized firewall entry, so no environment name was guessed.",
    );
    console.log("");
    return;
  }
  if (ctx.environmentNames.length === 0) {
    console.log(
      "The matched API route does not use a sandbox environment name.",
    );
    console.log("");
    return;
  }

  let environmentPresent = false;
  for (const environmentName of ctx.environmentNames) {
    const present = Boolean(process.env[environmentName]);
    environmentPresent ||= present;
    console.log(
      `Checking process.env.${environmentName}: ${present ? "present" : "not present"}`,
    );
  }
  if (environmentPresent) {
    console.log(
      "At least one connector value is present in the sandbox environment. These values may be non-secret connector settings or credential placeholders; real credentials are never injected and are resolved at the network boundary for registered base URLs.",
    );
  } else {
    console.log(
      "No value found for these environment names. Note: credential replacement at the network boundary is independent of these names — the proxy injects auth headers based on the destination URL.",
    );
  }
  console.log("");
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
  decision: SelectedFirewallRequestDecision,
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
  decision: SelectedFirewallRequestDecision,
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
  decision: SelectedFirewallRequestDecision,
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

function resolvePermissionFromUrl(
  connectorType: ConnectorType,
  label: string,
  method: string,
  relativePath: string,
  matchedBase: string,
  decision: SelectedFirewallRequestDecision,
  networkPolicies: NetworkPolicies | null,
  configuredForRun: boolean | null,
): void {
  console.log("## Step 3: Permission policy check (auto-detected from URL)");
  console.log("");
  console.log(
    `Matching ${method} ${relativePath} (relative to base URL ${matchedBase}) against the ${label} connector's permission rules.`,
  );
  console.log("");

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

type ResolvedCheckConnectorInput =
  | {
      readonly mode: "url";
      readonly method: string;
      readonly connectorType: ConnectorType;
      readonly environmentNames: readonly string[] | null;
      readonly urlDiagnostic: UrlDiagnosticResult;
      readonly runContext: RunContextResponse | null;
    }
  | {
      readonly mode: "environment";
      readonly method: string;
      readonly connectorType: ConnectorType;
      readonly environmentNames: readonly string[];
    };

function validateCheckConnectorOptions(
  opts: CheckConnectorOptions,
  command: Command,
): void {
  if (opts.connector && !opts.url) {
    throw new Error(
      "--connector can only be used with --url. Add --url <URL> or remove --connector.",
    );
  }
  if (opts.checkPermission && opts.url) {
    throw new Error(
      "--check-permission cannot be used with --url because the permission is derived from the request. Remove --check-permission.",
    );
  }
  if (!opts.url && command.getOptionValueSource("method") === "cli") {
    throw new Error(
      "--method can only be used with --url. Add --url <URL> or remove --method.",
    );
  }
  if (!opts.envName && !opts.url) {
    throw new Error(
      "Either --env-name or --url is required. Use --help for usage.",
    );
  }
}

function requestedConnectorType(
  value: string | undefined,
): ConnectorType | undefined {
  if (value === undefined) return undefined;
  if (!isConnectorType(value)) {
    throw new Error(
      `Unknown connector type: ${value}\nRun: zero connector search ${shellQuoteArg(value)}`,
    );
  }
  return value;
}

function printUrlDiagnosticSummary(
  url: string,
  diagnostic: UrlDiagnosticResult,
  environmentNames: readonly string[] | null,
): void {
  const { connectorType, decision } = diagnostic;
  console.log(
    `URL ${stripUrlQueryAndFragment(url)} matches the ${CONNECTOR_TYPES[connectorType].label} connector (type: ${connectorType}).`,
  );
  console.log(`  Matched base URL: ${decision.base}`);
  console.log(`  Relative path:    ${decision.relativePath}`);
  if (environmentNames === null) {
    console.log("  Environment names: unavailable");
  } else {
    console.log(`  Environment names: [${environmentNames.join(", ")}]`);
  }
}

async function resolveCheckConnectorInput(
  opts: CheckConnectorOptions,
): Promise<ResolvedCheckConnectorInput> {
  const method = opts.method.toUpperCase();
  if (opts.url) {
    const requestedConnector = requestedConnectorType(opts.connector);
    const runContext = await getCurrentRunContext();
    const urlDiagnostic = await resolveUrlDiagnostic(
      opts.url,
      method,
      requestedConnector,
      runContext,
    );
    const environmentNames = resolveUrlEnvironmentNames(
      urlDiagnostic.connectorType,
      urlDiagnostic.environmentNames,
      opts.envName,
    );
    printUrlDiagnosticSummary(opts.url, urlDiagnostic, environmentNames);
    return {
      mode: "url",
      method,
      connectorType: urlDiagnostic.connectorType,
      environmentNames,
      urlDiagnostic,
      runContext,
    };
  }

  const environmentName = opts.envName;
  if (!environmentName) {
    throw new Error(
      "Either --env-name or --url is required. Use --help for usage.",
    );
  }
  const connectorType =
    getDiagnosticConnectorTypeForRuntimeEnvName(environmentName);
  if (!connectorType) {
    throw new Error(
      `Unknown environment name: ${environmentName} — not managed by any connector`,
    );
  }
  console.log(
    `${environmentName} is managed by the ${CONNECTOR_TYPES[connectorType].label} connector (type: ${connectorType}).`,
  );
  return {
    mode: "environment",
    method,
    connectorType,
    environmentNames: [environmentName],
  };
}

function printRediagnoseHint(
  opts: CheckConnectorOptions,
  method: string,
): void {
  const args: string[] = [];
  if (opts.url) {
    args.push(`--url ${shellQuoteArg(stripUrlQueryAndFragment(opts.url))}`);
    if (opts.connector) {
      args.push(`--connector ${shellQuoteArg(opts.connector)}`);
    }
    if (opts.envName) {
      args.push(`--env-name ${shellQuoteArg(opts.envName)}`);
    }
    if (method !== "GET") {
      args.push(`--method ${shellQuoteArg(method)}`);
    }
  } else if (opts.envName) {
    args.push(`--env-name ${shellQuoteArg(opts.envName)}`);
  }
  if (opts.checkPermission) {
    args.push(`--check-permission ${shellQuoteArg(opts.checkPermission)}`);
  }
  console.log(
    `To re-diagnose after changes, run: zero doctor check-connector ${args.join(" ")}`,
  );
}

export const checkConnectorCommand = new Command()
  .name("check-connector")
  .description(
    "Diagnose connector health: environment names, connector configuration, and permission policies",
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
      "A full URL to diagnose — matches connector ownership, route environment names, and permission (e.g. https://api.github.com/repos/owner/repo)",
    ),
  )
  .addOption(
    new Option(
      "--connector <type>",
      "Select the connector when multiple connectors own the same URL route",
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
  zero doctor check-connector --url https://api.accounts.nintendo.com/2.0.0/users/me --connector nintendo-store
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
    withErrorHandler(async (opts: CheckConnectorOptions, command: Command) => {
      validateCheckConnectorOptions(opts, command);
      const input = await resolveCheckConnectorInput(opts);
      console.log("");

      const { connectorType, environmentNames, method } = input;
      const { label } = CONNECTOR_TYPES[connectorType];
      const [apiUrl, connectorAvailable] = await Promise.all([
        getApiUrl(),
        connectorTypeIsAvailable(connectorType),
      ]);
      const platformUrl = toPlatformUrl(apiUrl);

      const ctx: DiagContext = {
        environmentNames,
        connectorType,
        label,
        connectorAvailable,
        platformOrigin: platformUrl.origin,
        agentId: process.env.ZERO_AGENT_ID || undefined,
      };

      checkEnvironmentNames(ctx);
      const { isConnected, isExpired, hasPermission } =
        await checkConnectorStatus(ctx);
      const { networkPolicies, configuredForRun } = await checkConnectorDomains(
        ctx,
        input.mode === "url" ? input.runContext : undefined,
      );

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

      if (input.mode === "url") {
        resolvePermissionFromUrl(
          connectorType,
          label,
          method,
          input.urlDiagnostic.decision.relativePath,
          input.urlDiagnostic.decision.base,
          input.urlDiagnostic.decision,
          networkPolicies,
          configuredForRun,
        );
      } else if (opts.checkPermission) {
        checkPermissionPolicy(
          connectorType,
          label,
          opts.checkPermission,
          networkPolicies,
          configuredForRun,
        );
      }

      printRediagnoseHint(opts, method);
    }),
  );
