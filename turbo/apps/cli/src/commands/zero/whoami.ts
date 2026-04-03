import { Command } from "commander";
import chalk from "chalk";
import {
  getApiUrl,
  getActiveOrg,
  getToken,
  decodeZeroTokenPayload,
} from "../../lib/api/config";
import { listZeroConnectors } from "../../lib/api";
import { withErrorHandler } from "../../lib/command";

/**
 * Detect if running inside a zero sandbox (agent runtime).
 * Uses ZERO_AGENT_ID (not VM0_RUN_ID) because the zero CLI operates in the
 * zero agent context where ZERO_AGENT_ID is the canonical sandbox indicator.
 */
function isInsideSandbox(): boolean {
  return !!process.env.ZERO_AGENT_ID;
}

async function showSandboxInfo(): Promise<void> {
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
    const result = await listZeroConnectors();
    const identities = result.connectors.filter((c) => {
      return c.externalUsername !== null || c.externalEmail !== null;
    });

    if (identities.length > 0) {
      console.log();
      console.log(chalk.bold("Connected Services:"));
      for (const connector of identities) {
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
  .addHelpText(
    "after",
    `
Examples:
  zero whoami

Notes:
  - Inside sandbox: shows agent ID, run ID, org ID, and granted capabilities
  - Your agent ID is also available as $ZERO_AGENT_ID`,
  )
  .action(
    withErrorHandler(async () => {
      if (isInsideSandbox()) {
        await showSandboxInfo();
      } else {
        await showLocalInfo();
      }
    }),
  );
