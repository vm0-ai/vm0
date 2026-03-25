// Zero CLI entry point - standalone binary for zero platform commands
// Sentry must be initialized before any other imports
import "./instrument.js";
import { Command } from "commander";
import { configureGlobalProxyFromEnv } from "./lib/network/proxy.js";
import { zeroOrgCommand } from "./commands/zero/org";
import { zeroAgentCommand } from "./commands/zero/agent";
import { zeroConnectorCommand } from "./commands/zero/connector";
import { zeroPreferenceCommand } from "./commands/zero/preference";
import { zeroScheduleCommand } from "./commands/zero/schedule";
import { zeroSecretCommand } from "./commands/zero/secret";
import { zeroSlackCommand } from "./commands/zero/slack";
import { zeroVariableCommand } from "./commands/zero/variable";
import { zeroWhoamiCommand } from "./commands/zero/whoami";

/**
 * Map of command names to the capability required to see them.
 * Commands not in this map are hidden when ZERO_TOKEN is active.
 * Use `null` for commands that should always be visible in sandbox.
 */
const COMMAND_CAPABILITY_MAP: Record<string, string | null> = {
  agent: "agent:read",
  schedule: "schedule:read",
  whoami: null,
};

/**
 * Decode capabilities from a ZERO_TOKEN JWT without signature verification.
 * Returns null if token is missing, malformed, or not a zero-scoped token.
 *
 * Mirrors the decode logic in src/lib/api/config.ts but kept local
 * to avoid pulling config dependencies into the entry point.
 */
export function decodeCapabilitiesFromZeroToken(
  token: string,
): string[] | null {
  const prefix = "vm0_sandbox_";
  if (!token.startsWith(prefix)) return null;
  const jwt = token.slice(prefix.length);

  const parts = jwt.split(".");
  if (parts.length !== 3) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString(),
    ) as Record<string, unknown>;
    if (payload.scope === "zero" && Array.isArray(payload.capabilities)) {
      return payload.capabilities as string[];
    }
  } catch {
    // Malformed token — fall through
  }
  return null;
}

/**
 * Hide commands that the current ZERO_TOKEN does not grant access to.
 * When no ZERO_TOKEN is present (human user with VM0_TOKEN or config),
 * all commands remain visible.
 */
export function applyCapabilityVisibility(prog: Command): void {
  const token = process.env.ZERO_TOKEN;
  if (!token) return;

  const capabilities = decodeCapabilitiesFromZeroToken(token);
  if (!capabilities) return;

  for (const cmd of prog.commands) {
    const requiredCap = COMMAND_CAPABILITY_MAP[cmd.name()];
    if (requiredCap === undefined) {
      // Command not in map → hide in sandbox
      (cmd as unknown as { _hidden: boolean })._hidden = true;
    } else if (requiredCap !== null && !capabilities.includes(requiredCap)) {
      // Command in map but capability missing → hide
      (cmd as unknown as { _hidden: boolean })._hidden = true;
    }
    // requiredCap === null → always visible (e.g., whoami)
  }
}

const program = new Command();

declare const __CLI_VERSION__: string;

program
  .name("zero")
  .description("Zero CLI - Manage your zero platform")
  .version(__CLI_VERSION__);

// Register all zero commands as top-level
program.addCommand(zeroOrgCommand);
program.addCommand(zeroAgentCommand);
program.addCommand(zeroConnectorCommand);
program.addCommand(zeroPreferenceCommand);
program.addCommand(zeroScheduleCommand);
program.addCommand(zeroSecretCommand);
program.addCommand(zeroSlackCommand);
program.addCommand(zeroVariableCommand);
program.addCommand(zeroWhoamiCommand);

export { program };

if (
  process.argv[1]?.endsWith("zero.js") ||
  process.argv[1]?.endsWith("zero.ts") ||
  process.argv[1]?.endsWith("zero")
) {
  // Handle EPIPE gracefully (e.g., `zero schedule list | head`)
  process.stdout.on("error", (err) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
  process.stderr.on("error", (err) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });

  configureGlobalProxyFromEnv();
  applyCapabilityVisibility(program);
  program.parse();
}
