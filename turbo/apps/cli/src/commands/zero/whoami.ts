import { Command } from "commander";
import chalk from "chalk";
import {
  getApiUrl,
  getActiveOrg,
  getToken,
  decodeZeroTokenPayload,
} from "../../lib/api/config";
import {
  listZeroConnectors,
  getZeroAgent,
  getZeroAgentUserConnectors,
} from "../../lib/api";
import { withErrorHandler } from "../../lib/command";
import {
  isFirewallConnectorType,
  getConnectorFirewall,
  resolveFirewallPolicies,
  type FirewallPolicies,
} from "@vm0/core";

/**
 * Detect if running inside a zero sandbox (agent runtime).
 * Uses ZERO_AGENT_ID (not VM0_RUN_ID) because the zero CLI operates in the
 * zero agent context where ZERO_AGENT_ID is the canonical sandbox indicator.
 */
function isInsideSandbox(): boolean {
  return !!process.env.ZERO_AGENT_ID;
}

function formatConnectorIdentity(connector: {
  externalUsername: string | null;
  externalEmail: string | null;
  needsReconnect: boolean;
}): string {
  let identity = "";
  if (connector.externalUsername && connector.externalEmail) {
    identity = `@${connector.externalUsername} (${connector.externalEmail})`;
  } else if (connector.externalUsername) {
    identity = `@${connector.externalUsername}`;
  } else if (connector.externalEmail) {
    identity = connector.externalEmail;
  }
  if (connector.needsReconnect) {
    identity += ` ${chalk.yellow("(needs reconnect)")}`;
  }
  return identity;
}

function printConnectorPermissions(
  type: string,
  resolvedPolicies: FirewallPolicies | null,
): void {
  if (!isFirewallConnectorType(type)) return;

  const policies = resolvedPolicies?.[type];
  if (!policies || Object.keys(policies).length === 0) {
    console.log(chalk.dim("    full access — no permission rules configured"));
    return;
  }

  const config = getConnectorFirewall(type);
  const permissions = config.apis.flatMap((a) => {
    return a.permissions ?? [];
  });
  if (permissions.length === 0) return;

  const nameWidth = Math.max(
    ...permissions.map((p) => {
      return p.name.length;
    }),
  );

  for (const perm of permissions) {
    const policy = policies[perm.name] ?? "deny";
    const icon =
      policy === "allow"
        ? chalk.green("✓")
        : policy === "ask"
          ? chalk.yellow("?")
          : chalk.dim("✗");
    const desc = perm.description ?? "";
    console.log(`    ${icon} ${perm.name.padEnd(nameWidth)}  ${desc}`);
  }
}

async function showSandboxInfo(showPermissions: boolean): Promise<void> {
  const agentId = process.env.ZERO_AGENT_ID;
  const payload = decodeZeroTokenPayload();

  console.log(`Agent ID:   ${agentId}`);
  console.log(`Run ID:     ${payload?.runId ?? chalk.dim("unavailable")}`);
  console.log(`Org ID:     ${payload?.orgId ?? chalk.dim("unavailable")}`);

  // Capabilities section
  if (payload?.capabilities?.length) {
    console.log();
    console.log(chalk.bold("Capabilities:"));
    console.log(`  ${payload.capabilities.join(", ")}`);
  }

  // Connected Services section
  try {
    if (showPermissions) {
      // Full mode: fetch all 3 APIs for permission details
      const [connectorsResult, agentResult, enabledResult] =
        await Promise.allSettled([
          listZeroConnectors(),
          getZeroAgent(agentId!),
          getZeroAgentUserConnectors(agentId!),
        ]);

      if (connectorsResult.status === "rejected") return;

      const identities = connectorsResult.value.connectors.filter((c) => {
        return c.externalUsername !== null || c.externalEmail !== null;
      });

      if (identities.length === 0) return;

      let resolvedPolicies: FirewallPolicies | null = null;
      const permissionDataAvailable =
        agentResult.status === "fulfilled" &&
        enabledResult.status === "fulfilled";
      if (permissionDataAvailable) {
        resolvedPolicies = resolveFirewallPolicies(
          agentResult.value.permissionPolicies,
          enabledResult.value,
        );
      }

      console.log();
      console.log(chalk.bold("Connectors:"));
      for (const connector of identities) {
        const identity = formatConnectorIdentity(connector);
        console.log(`  ${connector.type.padEnd(14)}${identity}`);

        if (permissionDataAvailable) {
          printConnectorPermissions(connector.type, resolvedPolicies);
        }
      }
    } else {
      // Default mode: only fetch connector identities (1 API call)
      const connectors = await listZeroConnectors();
      const identities = connectors.connectors.filter((c) => {
        return c.externalUsername !== null || c.externalEmail !== null;
      });

      if (identities.length === 0) return;

      console.log();
      console.log(chalk.bold("Connectors:"));
      for (const connector of identities) {
        const identity = formatConnectorIdentity(connector);
        console.log(`  ${connector.type.padEnd(14)}${identity}`);
      }
    }
  } catch {
    // Silently skip — connector info is supplementary
  }
}

async function showLocalInfo(): Promise<void> {
  const token = await getToken();
  const apiUrl = await getApiUrl();
  const activeOrg = await getActiveOrg();

  // Auth section
  console.log(chalk.bold("Auth:"));
  if (token) {
    const tokenSource = process.env.ZERO_TOKEN
      ? "ZERO_TOKEN env var"
      : process.env.VM0_TOKEN
        ? "VM0_TOKEN env var"
        : "config file";
    console.log(
      `  Status:     ${chalk.green("Authenticated")} (via ${tokenSource})`,
    );
  } else {
    console.log(`  Status:     ${chalk.dim("Not authenticated")}`);
  }
  console.log(`  API:        ${apiUrl}`);
  console.log();

  // Org section
  if (activeOrg) {
    console.log(chalk.bold("Org:"));
    console.log(`  Active:     ${activeOrg}`);
  }
}

export const zeroWhoamiCommand = new Command()
  .name("whoami")
  .description("Show agent identity, run ID, and capabilities")
  .option("--permissions", "Show full permission details for each connector")
  .addHelpText(
    "after",
    `
Examples:
  zero whoami
  zero whoami --permissions

Notes:
  - Inside sandbox: shows agent ID, run ID, org ID, and granted capabilities
  - Use --permissions to see detailed permission breakdown per connector
  - Your agent ID is also available as $ZERO_AGENT_ID`,
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
