import { Command } from "commander";
import chalk from "chalk";
import { getApiUrl, getActiveOrg, getToken } from "../../lib/api/config";
import { withErrorHandler } from "../../lib/command";

interface ZeroTokenPayload {
  userId: string;
  runId: string;
  orgId: string;
  scope: string;
  capabilities: string[];
  iat: number;
  exp: number;
}

/**
 * Detect if running inside a zero sandbox (agent runtime).
 * Uses ZERO_AGENT_ID (not VM0_RUN_ID) because the zero CLI operates in the
 * zero agent context where ZERO_AGENT_ID is the canonical sandbox indicator.
 */
function isInsideSandbox(): boolean {
  return !!process.env.ZERO_AGENT_ID;
}

function decodeZeroToken(): ZeroTokenPayload | undefined {
  const token = process.env.ZERO_TOKEN;
  if (!token) return undefined;

  const prefix = "vm0_sandbox_";
  if (!token.startsWith(prefix)) return undefined;
  const jwt = token.slice(prefix.length);

  const parts = jwt.split(".");
  if (parts.length !== 3) return undefined;

  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString(),
    ) as ZeroTokenPayload;
    if (payload.scope === "zero") return payload;
  } catch {
    // Malformed token
  }
  return undefined;
}

async function showSandboxInfo(): Promise<void> {
  const agentId = process.env.ZERO_AGENT_ID;
  const payload = decodeZeroToken();

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
