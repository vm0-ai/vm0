import { Command } from "commander";
import chalk from "chalk";
import {
  getApiUrl,
  getActiveOrg,
  getToken,
  decodeSandboxTokenPayload,
} from "../lib/api/config";
import {
  getAgentUserConnectors,
  listUserPermissionGrants,
} from "../lib/api/domains/agents";
import { getOrg } from "../lib/api/domains/orgs";
import { withErrorHandler } from "../lib/command/with-error-handler";
import { getOkouAgentId } from "../lib/okou-env";
import { policyIcon } from "../lib/utils/format-utils";
import {
  loadConnectorPermissionInfos,
  connectorPermissionGrantsToFirewallPolicies,
  type ConnectorPermissionInfo,
} from "./shared/firewall-permissions";
import {
  resolveRunConnectorAccountView,
  runConnectorAccountUnavailableMessage,
  type RunConnectorAccountEntry,
} from "./connector/run-account-context";

/**
 * Detect if running inside an agent sandbox.
 * Uses OKOU_AGENT_ID (not OKOU_RUN_ID) because the Okou CLI operates in the
 * okou agent context where OKOU_AGENT_ID is the canonical sandbox indicator.
 */
function isInsideSandbox(): boolean {
  return !!getOkouAgentId();
}

function formatRunConnectorIdentity(
  connector: RunConnectorAccountEntry,
): string {
  const account = connector.account;
  if (account.state === "not-admitted") {
    return chalk.dim("(unavailable for this run)");
  }
  if (account.state === "metadata-unavailable") {
    return chalk.dim(
      `${account.connectionId} (metadata unavailable or deleted)`,
    );
  }

  const metadata = account.metadata;
  let identity = account.label;
  if (metadata.externalUsername && metadata.externalEmail) {
    identity = `@${metadata.externalUsername} (${metadata.externalEmail})`;
  } else if (metadata.externalUsername) {
    identity = `@${metadata.externalUsername}`;
  } else if (metadata.externalEmail) {
    identity = metadata.externalEmail;
  }
  if (metadata.connectionStatus === "reconnect-required") {
    identity += ` ${chalk.yellow("(needs reconnect)")}`;
  }
  return identity;
}

function printConnectorPermissions(info: ConnectorPermissionInfo): void {
  if (!info.hasPermissions) return;

  if (!info.hasPolicyEntry) {
    console.log(chalk.dim("    full access — no permission rules configured"));
    return;
  }

  if (
    info.permissions.length === 0 &&
    (!info.policies || Object.keys(info.policies).length === 0)
  ) {
    const unknownIcon = policyIcon(info.unknownPolicy);
    console.log(`    ${unknownIcon} unknown endpoints`);
    return;
  }

  const nameWidth = Math.max(
    "unknown endpoints".length,
    ...info.permissions.map((p) => {
      return p.name.length;
    }),
  );

  for (const perm of info.permissions) {
    const policy = info.policies?.[perm.name] ?? "deny";
    const icon = policyIcon(policy);
    const desc = perm.description ?? "";
    console.log(`    ${icon} ${perm.name.padEnd(nameWidth)}  ${desc}`);
  }

  const unknownIcon = policyIcon(info.unknownPolicy);
  console.log(
    `    ${unknownIcon} ${"unknown endpoints".padEnd(nameWidth)}  Endpoints not matching any rule`,
  );
}

/**
 * Workspace identity is supplementary: whoami must still print the agent
 * identity, capabilities, and connectors when the org lookup fails or 404s.
 */
async function printWorkspace(): Promise<void> {
  try {
    const org = await getOrg();
    console.log(`Workspace:  ${org.name}`);
    if (org.tier) {
      console.log(`Tier:       ${org.tier}`);
    }
  } catch {
    // Silently skip — workspace info is supplementary
  }
}

async function resolveSandboxConnectorData(
  showPermissions: boolean,
  agentId: string,
) {
  if (!showPermissions) {
    return {
      view: await resolveRunConnectorAccountView(),
      permissionSources: null,
    };
  }

  const [viewResult, grantsResult, enabledResult] = await Promise.allSettled([
    resolveRunConnectorAccountView(),
    listUserPermissionGrants(agentId),
    getAgentUserConnectors(agentId),
  ]);
  if (viewResult.status === "rejected") {
    throw viewResult.reason;
  }
  return {
    view: viewResult.value,
    permissionSources: [grantsResult, enabledResult] as const,
  };
}

async function showSandboxInfo(showPermissions: boolean): Promise<void> {
  const agentId = getOkouAgentId();
  const payload = decodeSandboxTokenPayload();

  console.log(`Agent ID:   ${agentId}`);
  console.log(`Run ID:     ${payload?.runId ?? chalk.dim("unavailable")}`);
  console.log(`Org ID:     ${payload?.orgId ?? chalk.dim("unavailable")}`);
  await printWorkspace();

  // Capabilities section
  if (payload?.capabilities?.length) {
    console.log();
    console.log(chalk.bold("Capabilities:"));
    console.log(`  ${payload.capabilities.join(", ")}`);
  }

  // Connected Services section
  try {
    const { view, permissionSources } = await resolveSandboxConnectorData(
      showPermissions,
      agentId!,
    );
    if (view.state === "unavailable") {
      console.log();
      console.log(chalk.bold("Connectors:"));
      console.log(
        `  ${chalk.dim(runConnectorAccountUnavailableMessage(view.reason))}`,
      );
      return;
    }
    if (view.connectors.length === 0) return;

    let permissionInfoBySlug = new Map<string, ConnectorPermissionInfo>();
    let permissionDataAvailable = false;
    if (permissionSources) {
      const [grantsResult, enabledResult] = permissionSources;

      if (
        grantsResult.status === "fulfilled" &&
        enabledResult.status === "fulfilled"
      ) {
        permissionDataAvailable = true;
        const permissionInfos = await loadConnectorPermissionInfos({
          displayConnectorSlugs: view.connectors.map((connector) => {
            return connector.slug;
          }),
          defaultPolicyConnectorSlugs: enabledResult.value,
          storedPolicies: connectorPermissionGrantsToFirewallPolicies(
            grantsResult.value,
          ),
        });
        permissionInfoBySlug = new Map(
          permissionInfos.map((info) => {
            return [info.connectorSlug, info];
          }),
        );
      }
    }

    console.log();
    console.log(chalk.bold("Connectors:"));
    for (const connector of view.connectors) {
      const identity = formatRunConnectorIdentity(connector);
      console.log(`  ${connector.slug.padEnd(14)}${identity}`);

      if (permissionDataAvailable) {
        const info = permissionInfoBySlug.get(connector.slug);
        if (info) {
          printConnectorPermissions(info);
        }
      }
    }
  } catch {
    // Silently skip — connector info is supplementary
  }
}

async function showLocalInfo(): Promise<void> {
  const token = await getToken();
  const apiUrl = await getApiUrl();
  const payload = token ? decodeSandboxTokenPayload(token) : undefined;
  const isExpired = payload ? payload.exp * 1000 <= Date.now() : false;
  const activeOrg = !isExpired ? await getActiveOrg() : undefined;

  // Auth section
  console.log(chalk.bold("Auth:"));
  if (!token) {
    console.log(`  Status:     ${chalk.dim("Not authenticated")}`);
  } else if (!payload) {
    console.log(`  Status:     ${chalk.red("Invalid OKOU_TOKEN")}`);
  } else if (isExpired) {
    console.log(`  Status:     ${chalk.red("Expired OKOU_TOKEN")}`);
  } else {
    console.log(
      `  Status:     ${chalk.green("Authenticated")} (via OKOU_TOKEN env var)`,
    );
  }
  console.log(`  API:        ${apiUrl}`);
  console.log();

  // Org section
  if (activeOrg) {
    console.log(chalk.bold("Org:"));
    console.log(`  Active:     ${activeOrg}`);
  }
}

export const whoamiCommand = new Command()
  .name("whoami")
  .description("Show agent identity, run ID, and capabilities")
  .option("--permissions", "Show full permission details for each connector")
  .addHelpText(
    "after",
    `
Examples:
  okou whoami
  okou whoami --permissions

Notes:
  - Inside sandbox: shows agent ID, run ID, org ID, and granted capabilities
  - Use --permissions to see detailed permission breakdown per connector
  - Your agent ID is also available as $OKOU_AGENT_ID`,
  )
  .action(
    withErrorHandler(async (options: { permissions?: boolean }) => {
      if (isInsideSandbox()) {
        await showSandboxInfo(options.permissions ?? false);
      } else {
        await showLocalInfo();
      }
    }),
  );
