import { Command } from "commander";
import chalk from "chalk";
import {
  getApiUrl,
  getActiveOrg,
  getToken,
  decodeZeroTokenPayload,
} from "../../lib/api/config";
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

  // Agent section
  console.log(chalk.bold("Agent:"));
  console.log(`  ID:           ${agentId}`);
  console.log();

  // Run section
  console.log(chalk.bold("Run:"));
  console.log(`  ID:           ${payload?.runId ?? chalk.dim("unavailable")}`);
  console.log(`  Org:          ${payload?.orgId ?? chalk.dim("unavailable")}`);

  // Capabilities section
  if (payload?.capabilities?.length) {
    console.log();
    console.log(chalk.bold("Capabilities:"));
    console.log(`  ${payload.capabilities.join(", ")}`);
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
  .description("Show current identity and environment information")
  .action(
    withErrorHandler(async () => {
      if (isInsideSandbox()) {
        await showSandboxInfo();
      } else {
        await showLocalInfo();
      }
    }),
  );
