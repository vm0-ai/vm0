import { Command, Option } from "commander";
import {
  CONNECTOR_TYPES,
  type ConnectorType,
} from "@vm0/core/contracts/connectors";
import {
  getConnectorEnvironmentMapping,
  getConnectorTypeForSecretName,
} from "@vm0/core/contracts/connector-utils";
import { findMatchingPermissions } from "@vm0/core/contracts/firewall-rule-matcher";
import { extractSecretNamesFromApis } from "@vm0/core/contracts/firewalls";
import {
  getConnectorFirewall,
  isFirewallConnectorType,
} from "@vm0/core/firewalls";
import type {
  FirewallConfig,
  NetworkPolicies,
} from "@vm0/core/contracts/firewalls";
import type { RunContextResponse } from "@vm0/core/contracts/zero-runs";
import { getApiUrl } from "../../../lib/api/config";
import { getZeroConnector } from "../../../lib/api/domains/zero-connectors";
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
  connectorType: string;
  label: string;
  platformOrigin: string;
  agentId: string | undefined;
}

interface UrlLookupResult {
  connectorType: string;
  envName: string;
  matchedBase: string;
  relativePath: string;
}

/**
 * Reverse-lookup a full URL to find which connector handles it.
 * Iterates all connector firewall configs and checks if the URL
 * starts with any registered base URL (scheme + host + optional path prefix).
 */
function resolveConnectorFromUrl(url: string): UrlLookupResult | null {
  const allTypes = Object.keys(CONNECTOR_TYPES) as ConnectorType[];

  // Normalize: strip trailing slash for comparison
  const normalized = url.endsWith("/") ? url.slice(0, -1) : url;

  let bestMatch: {
    connectorType: string;
    base: string;
    config: FirewallConfig;
  } | null = null;

  for (const type of allTypes) {
    if (!isFirewallConnectorType(type)) continue;
    const config = getConnectorFirewall(type);
    for (const api of config.apis) {
      const base = api.base.endsWith("/") ? api.base.slice(0, -1) : api.base;
      // URL must match the base exactly or have the base as a prefix followed by /
      if (normalized === base || normalized.startsWith(base + "/")) {
        // Pick the longest (most specific) base URL match
        if (!bestMatch || base.length > bestMatch.base.length) {
          bestMatch = { connectorType: type, base, config };
        }
      }
    }
  }

  if (!bestMatch) return null;

  // Derive the env var name from the connector's environment mapping
  const mapping = getConnectorEnvironmentMapping(
    bestMatch.connectorType as ConnectorType,
  );
  const envName = Object.keys(mapping)[0];
  if (!envName) return null;

  const relativePath =
    normalized === bestMatch.base
      ? "/"
      : normalized.slice(bestMatch.base.length);

  return {
    connectorType: bestMatch.connectorType,
    envName,
    matchedBase: bestMatch.base,
    relativePath,
  };
}

function checkEnvVariable(ctx: DiagContext): boolean {
  console.log("## Step 1: Sandbox environment variable");
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
      "No value found for this environment variable. Note: credential replacement at the network boundary is independent of this variable — the proxy injects auth headers based on the destination URL, not the presence of this env var.",
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
    getZeroConnector(ctx.connectorType as ConnectorType),
    ctx.agentId
      ? getZeroAgentUserConnectors(ctx.agentId)
      : Promise.resolve(null),
  ]);

  const isConnected = connector !== null;
  const isExpired = connector?.needsReconnect === true;
  const hasPermission =
    enabledTypes !== null && enabledTypes.includes(ctx.connectorType);

  // 2a: Connector status — user must have configured the connector (OAuth or API token)
  console.log(
    `### 2a: Connector status (user must configure via OAuth login or API key)`,
  );
  console.log("");
  if (!isConnected) {
    console.log(`The ${ctx.label} connector is not connected.`);
    if (!ctx.agentId) {
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

  // 2b: Agent authorization — user must authorize the agent to use this connector
  console.log(
    `### 2b: Agent authorization (user must authorize agent to use this connector)`,
  );
  console.log("");
  if (!ctx.agentId) {
    console.log("ZERO_AGENT_ID is not set — cannot check agent authorization.");
  } else if (isExpired) {
    // The /authorize page treats an expired connector as "already connected"
    // and won't re-trigger OAuth. Defer to 2a's Reconnect link in that case.
    console.log(
      `Skipped — agent authorization can only be checked once the ${ctx.label} connector is reconnected (see 2a).`,
    );
  } else if (hasPermission) {
    console.log(`The ${ctx.label} connector is authorized for this agent.`);
  } else {
    const url = `${ctx.platformOrigin}/connectors/${ctx.connectorType}/authorize?agentId=${ctx.agentId}`;
    console.log(
      isConnected
        ? `The ${ctx.label} connector is not authorized for this agent (${ctx.agentId}).`
        : `The ${ctx.label} connector needs to be connected and authorized for this agent (${ctx.agentId}).`,
    );
    console.log(`Authorize it at: [Authorize ${ctx.label}](${url})`);
  }
  console.log("");

  return { isConnected, isExpired, hasPermission };
}

async function checkConnectorDomains(
  ctx: DiagContext,
): Promise<NetworkPolicies | null> {
  // 2c: Registered base URLs — connector defines which URL prefixes get credential replacement
  console.log(
    `### 2c: Registered base URLs (credential replacement only applies to URLs matching these prefixes)`,
  );
  console.log("");

  const payload = decodeZeroTokenPayload();
  const runId = payload?.runId;

  if (!runId) {
    console.log(
      "Cannot determine run ID from ZERO_TOKEN — skipping base URL check.",
    );
    console.log("");
    return null;
  }

  const runContext = await getZeroRunContext(runId);

  printConnectorDomains(ctx, runContext);
  console.log("");
  return runContext.networkPolicies;
}

function printConnectorDomains(
  ctx: DiagContext,
  runContext: RunContextResponse,
): void {
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
    return;
  }

  console.log(
    `The ${ctx.label} connector is configured for this run with the following base URLs:`,
  );
  for (const api of matchingEntry.apis) {
    console.log(`  - ${api.base}`);
  }
  console.log("");
  console.log(
    "When the sandbox sends an HTTP request matching one of these URL prefixes, the network boundary intercepts the request and injects real credentials into the auth headers.",
  );

  if (isFirewallConnectorType(ctx.connectorType)) {
    const firewallConfig = getConnectorFirewall(ctx.connectorType);
    const secretNames = extractSecretNamesFromApis(firewallConfig.apis);
    if (secretNames.length > 0) {
      console.log(`Credentials resolved from: ${secretNames.join(", ")}`);
    }
  }
}

function checkPermissionPolicy(
  connectorType: string,
  label: string,
  permissionName: string,
  networkPolicies: NetworkPolicies | null,
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
  console.log(`  unknown endpoint policy: ${connectorPolicies.unknownPolicy}`);
  console.log("");

  const isInAllow = connectorPolicies.allow.includes(permissionName);
  const isInDeny = connectorPolicies.deny.includes(permissionName);

  if (isInAllow) {
    console.log(
      `Result: "${permissionName}" is in the allow list. Requests matching this permission are allowed.`,
    );
  } else if (isInDeny) {
    console.log(
      `Result: "${permissionName}" is in the deny list. Requests matching this permission are denied.`,
    );
  } else {
    console.log(
      `Result: "${permissionName}" is not in any permission list. It will be handled by the unknown endpoint policy: ${connectorPolicies.unknownPolicy}.`,
    );
  }
  console.log("");
}

/**
 * When --url is provided, auto-detect the matching permission by running
 * the URL's relative path against the connector's firewall rules.
 */
function resolvePermissionFromUrl(
  connectorType: string,
  label: string,
  method: string,
  relativePath: string,
  matchedBase: string,
  networkPolicies: NetworkPolicies | null,
): void {
  console.log("## Step 3: Permission policy check (auto-detected from URL)");
  console.log("");
  console.log(
    `Matching ${method} ${relativePath} (relative to base URL ${matchedBase}) against the ${label} connector's permission rules.`,
  );
  console.log("");

  if (!isFirewallConnectorType(connectorType)) {
    console.log(
      `The ${label} connector does not have permission rules defined.`,
    );
    console.log("");
    return;
  }

  const config = getConnectorFirewall(connectorType);
  const matchedPermissions = findMatchingPermissions(
    method,
    relativePath,
    config,
  );

  if (matchedPermissions.length === 0) {
    console.log(
      `No named permission matches ${method} ${relativePath}. This request falls through to the unknown-endpoint policy.`,
    );
  } else {
    console.log(`Matched permissions: [${matchedPermissions.join(", ")}]`);
  }
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
    console.log(
      `No policy entry found for the ${label} connector. All requests are fully permissive (allowed).`,
    );
    console.log("");
    return;
  }

  console.log(`Permission policies for the ${label} connector:`);
  console.log(`  allow list: [${connectorPolicies.allow.join(", ")}]`);
  console.log(`  deny list:  [${connectorPolicies.deny.join(", ")}]`);
  console.log(`  unknown endpoint policy: ${connectorPolicies.unknownPolicy}`);
  console.log("");

  if (matchedPermissions.length === 0) {
    console.log(
      `Result: No permission matched. The unknown endpoint policy applies: ${connectorPolicies.unknownPolicy}.`,
    );
  } else {
    for (const perm of matchedPermissions) {
      const isInAllow = connectorPolicies.allow.includes(perm);
      const isInDeny = connectorPolicies.deny.includes(perm);
      if (isInAllow) {
        console.log(`Result: "${perm}" is in the allow list — allowed.`);
      } else if (isInDeny) {
        console.log(`Result: "${perm}" is in the deny list — denied.`);
      } else {
        console.log(
          `Result: "${perm}" is not in any list — falls through to unknown endpoint policy: ${connectorPolicies.unknownPolicy}.`,
        );
      }
    }
  }
  console.log("");
}

export const checkConnectorCommand = new Command()
  .name("check-connector")
  .description(
    "Diagnose connector health: environment variable, connector configuration, and permission policies",
  )
  .addOption(
    new Option(
      "--env-name <ENV_NAME>",
      "The environment variable name to check (e.g. GITHUB_TOKEN)",
    ),
  )
  .addOption(
    new Option(
      "--url <URL>",
      "A full URL to diagnose — auto-detects the connector, env var, and permission (e.g. https://api.github.com/repos/owner/repo)",
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
      let connectorType: string;
      let urlLookup: UrlLookupResult | null = null;

      if (opts.url) {
        urlLookup = resolveConnectorFromUrl(opts.url);
        if (!urlLookup) {
          throw new Error(
            `No connector found for URL: ${opts.url} — no registered base URL matches this URL`,
          );
        }
        connectorType = urlLookup.connectorType;
        envName = opts.envName ?? urlLookup.envName;
        console.log(
          `URL ${opts.url} matches the ${CONNECTOR_TYPES[connectorType as ConnectorType].label} connector (type: ${connectorType}).`,
        );
        console.log(`  Matched base URL: ${urlLookup.matchedBase}`);
        console.log(`  Relative path:    ${urlLookup.relativePath}`);
        console.log(`  Environment var:  ${envName}`);
      } else {
        connectorType = getConnectorTypeForSecretName(
          (envName = opts.envName!),
        )!;
        if (!connectorType) {
          throw new Error(
            `Unknown environment variable: ${envName} — not managed by any connector`,
          );
        }
        console.log(
          `${envName} is managed by the ${CONNECTOR_TYPES[connectorType as ConnectorType].label} connector (type: ${connectorType}).`,
        );
      }
      console.log("");

      const { label } = CONNECTOR_TYPES[connectorType as ConnectorType];
      const apiUrl = await getApiUrl();
      const platformUrl = toPlatformUrl(apiUrl);

      const ctx: DiagContext = {
        envName,
        connectorType,
        label,
        platformOrigin: platformUrl.origin,
        agentId: process.env.ZERO_AGENT_ID || undefined,
      };

      checkEnvVariable(ctx);
      const { isConnected, isExpired, hasPermission } =
        await checkConnectorStatus(ctx);
      const networkPolicies = await checkConnectorDomains(ctx);

      // Summary for Step 2
      if (isConnected && !isExpired && hasPermission) {
        console.log(
          `Steps 1-2 summary: The ${label} connector is connected, active, and authorized. Outbound requests to the registered base URLs will have credentials injected at the network boundary.`,
        );
      }
      console.log("");

      // Step 3: Permission policy check
      if (urlLookup) {
        // --url mode: auto-detect permission from URL path
        resolvePermissionFromUrl(
          connectorType,
          label,
          opts.method,
          urlLookup.relativePath,
          urlLookup.matchedBase,
          networkPolicies,
        );
      } else if (opts.checkPermission) {
        // --env-name mode with explicit --check-permission
        checkPermissionPolicy(
          connectorType,
          label,
          opts.checkPermission,
          networkPolicies,
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
