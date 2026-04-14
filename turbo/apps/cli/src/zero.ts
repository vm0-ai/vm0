// Zero CLI entry point - standalone binary for zero platform commands
// Sentry must be initialized before any other imports
import "./instrument.js";
import { Command } from "commander";
import { configureGlobalProxyFromEnv } from "./lib/network/proxy.js";
import { zeroOrgCommand } from "./commands/zero/org";
import { zeroAgentCommand } from "./commands/zero/agent";
import { zeroConnectorCommand } from "./commands/zero/connector";
import { zeroDoctorCommand } from "./commands/zero/doctor";
import { zeroPreferenceCommand } from "./commands/zero/preference";
import { zeroRunCommand } from "./commands/zero/run";
import { zeroScheduleCommand } from "./commands/zero/schedule";
import { zeroSecretCommand } from "./commands/zero/secret";
import { zeroSlackCommand } from "./commands/zero/slack";
import { zeroVariableCommand } from "./commands/zero/variable";
import { zeroWhoamiCommand } from "./commands/zero/whoami";
import { zeroSkillCommand } from "./commands/zero/skill";
import { zeroLogsCommand } from "./commands/zero/logs";
import { zeroDeveloperSupportCommand } from "./commands/zero/developer-support";
import { zeroComputerUseCommand } from "./commands/zero/computer-use";
import { zeroPhoneCommand } from "./commands/zero/phone";
import { zeroVoiceChatCommand } from "./commands/zero/voice-chat";
import {
  decodeZeroTokenPayload,
  type ZeroTokenPayload,
} from "./lib/api/zero-token.js";

/**
 * Map of command names to the capability required to see them.
 * Commands not in this map are hidden when ZERO_TOKEN is active.
 * Use `null` for commands that should always be visible in sandbox.
 */
const COMMAND_CAPABILITY_MAP: Record<string, string | null> = {
  agent: "agent:read",
  skill: "agent:read",
  connector: "connector:read",
  run: "agent-run:write",
  schedule: "schedule:read",
  doctor: null,
  logs: "agent-run:read",
  slack: "slack:write",
  whoami: null,
  "developer-support": null,
  "computer-use": "computer-use:write",
  phone: "phone:write",
  "voice-chat": "voice-chat:write",
};

const DEFAULT_COMMANDS: Command[] = [
  zeroOrgCommand,
  zeroAgentCommand,
  zeroConnectorCommand,
  zeroDoctorCommand,
  zeroPreferenceCommand,
  zeroRunCommand,
  zeroScheduleCommand,
  zeroSecretCommand,
  zeroSlackCommand,
  zeroVariableCommand,
  zeroLogsCommand,
  zeroWhoamiCommand,
  zeroSkillCommand,
  zeroDeveloperSupportCommand,
  zeroComputerUseCommand,
  zeroPhoneCommand,
  zeroVoiceChatCommand,
];

function shouldHideCommand(
  name: string,
  payload: ZeroTokenPayload | undefined,
): boolean {
  if (!payload) return false;
  const requiredCap = COMMAND_CAPABILITY_MAP[name];
  if (requiredCap === undefined) return true;
  return requiredCap !== null && !payload.capabilities.includes(requiredCap);
}

/**
 * Register commands with visibility based on ZERO_TOKEN capabilities.
 * Commands not granted by the token are registered as hidden via
 * Commander's public `addCommand(cmd, { hidden: true })` API.
 * When no ZERO_TOKEN is present, all commands remain visible.
 *
 * @param commands - override default commands (used in tests)
 */
export function registerZeroCommands(
  prog: Command,
  commands?: Command[],
): void {
  const token = process.env.ZERO_TOKEN;
  const payload = token ? decodeZeroTokenPayload(token) : undefined;

  for (const cmd of commands ?? DEFAULT_COMMANDS) {
    const hidden = shouldHideCommand(cmd.name(), payload);
    prog.addCommand(cmd, hidden ? { hidden: true } : {});
  }
}

const program = new Command();

declare const __CLI_VERSION__: string;

program
  .name("zero")
  .description(
    "Zero CLI — interact with the zero platform from inside the sandbox",
  )
  .version(__CLI_VERSION__)
  .addHelpText(
    "after",
    `
Examples:
  Missing a token?       zero doctor missing-token <TOKEN_NAME>
  Send a Slack message?  zero slack message send --help
  Set up a schedule?     zero schedule setup --help
  Update yourself?       zero agent --help
  Manage custom skills?  zero skill --help
  Check your identity?   zero whoami`,
  );

export { program };

if (
  process.argv[1]?.endsWith("zero.js") ||
  process.argv[1]?.endsWith("zero.ts") ||
  process.argv[1]?.endsWith("zero")
) {
  configureGlobalProxyFromEnv();
  registerZeroCommands(program);
  program.parse();
}
