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
import { decodeZeroTokenPayload } from "./lib/api/zero-token.js";

/**
 * Map of command names to the capability required to see them.
 * Commands not in this map are hidden when ZERO_TOKEN is active.
 * Use `null` for commands that should always be visible in sandbox.
 */
const COMMAND_CAPABILITY_MAP: Record<string, string | null> = {
  agent: "agent:read",
  schedule: "schedule:read",
  slack: "slack:write",
  whoami: null,
};

/**
 * Hide commands that the current ZERO_TOKEN does not grant access to.
 * When no ZERO_TOKEN is present (human user with VM0_TOKEN or config),
 * all commands remain visible.
 */
export function applyCapabilityVisibility(prog: Command): void {
  const token = process.env.ZERO_TOKEN;
  if (!token) return;

  const payload = decodeZeroTokenPayload(token);
  if (!payload) return;

  for (const cmd of prog.commands) {
    const requiredCap = COMMAND_CAPABILITY_MAP[cmd.name()];
    if (requiredCap === undefined) {
      (cmd as unknown as { _hidden: boolean })._hidden = true;
    } else if (
      requiredCap !== null &&
      !payload.capabilities.includes(requiredCap)
    ) {
      (cmd as unknown as { _hidden: boolean })._hidden = true;
    }
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
  configureGlobalProxyFromEnv();
  applyCapabilityVisibility(program);
  program.parse();
}
