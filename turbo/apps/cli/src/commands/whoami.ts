import { Command } from "commander";
import chalk from "chalk";
import { getApiUrl, getActiveOrg, getToken } from "../lib/api/config";
import { withErrorHandler } from "../lib/command";

/**
 * Detect if running inside a VM0 sandbox (agent runtime).
 * Presence of VM0_RUN_ID indicates sandbox execution.
 */
function isInsideSandbox(): boolean {
  return !!process.env.VM0_RUN_ID;
}

/**
 * Display agent identity and run information when inside a sandbox.
 */
async function showSandboxInfo(): Promise<void> {
  const agentId = process.env.ZERO_AGENT_ID;
  const cliAgentType = process.env.CLI_AGENT_TYPE;

  const runId = process.env.VM0_RUN_ID;
  const activeOrg = await getActiveOrg();
  const apiUrl = process.env.VM0_API_URL;

  // Agent section
  const hasAgentInfo = agentId || cliAgentType;
  if (hasAgentInfo) {
    console.log(chalk.bold("Agent:"));
    if (agentId) console.log(`  ID:         ${agentId}`);
    if (cliAgentType) console.log(`  Framework:  ${cliAgentType}`);
    console.log();
  }

  // Run section
  console.log(chalk.bold("Run:"));
  if (runId) console.log(`  ID:         ${runId}`);
  if (activeOrg) console.log(`  Org:        ${activeOrg}`);
  if (apiUrl) console.log(`  API:        ${apiUrl}`);
}

/**
 * Display authentication and org information when running outside a sandbox.
 */
async function showLocalInfo(): Promise<void> {
  const token = await getToken();
  const apiUrl = await getApiUrl();
  const activeOrg = await getActiveOrg();

  // Auth section
  console.log(chalk.bold("Auth:"));
  if (token) {
    const tokenSource = process.env.VM0_TOKEN
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

export const whoamiCommand = new Command()
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
