// Zero CLI entry point - standalone binary for zero platform commands
// Sentry must be initialized before any other imports
import "./instrument.js";
import { Command } from "commander";
import { configureGlobalProxyFromEnv } from "./lib/network/proxy.js";
import { zeroOrgCommand } from "./commands/zero/org";
import { zeroAgentCommand } from "./commands/zero/agent";
import { zeroConnectorCommand } from "./commands/zero/connector";
import { zeroCreditCommand } from "./commands/zero/credit";
import { zeroDoctorCommand } from "./commands/zero/doctor";
import { zeroPreferenceCommand } from "./commands/zero/preference";
import { zeroScheduleCommand } from "./commands/zero/schedule";
import { zeroAutomationCommand } from "./commands/zero/automation";
import { zeroSecretCommand } from "./commands/zero/secret";
import { zeroGithubCommand } from "./commands/zero/github";
import { zeroSlackCommand } from "./commands/zero/slack";
import { zeroTelegramCommand } from "./commands/zero/telegram";
import { zeroPhoneCommand } from "./commands/zero/phone";
import { zeroVariableCommand } from "./commands/zero/variable";
import { zeroWhoamiCommand } from "./commands/zero/whoami";
import { zeroSkillCommand } from "./commands/zero/skill";
import { zeroLogsCommand } from "./commands/zero/logs";
import { zeroSearchCommand } from "./commands/zero/search";
import { zeroDeveloperSupportCommand } from "./commands/zero/developer-support";
import { zeroComputerUseCommand } from "./commands/zero/computer-use";
import { generateCommand } from "./commands/zero/generate";
import { zeroWebCommand } from "./commands/zero/web";
import { zeroHostCommand } from "./commands/zero/host";
import { zeroMapsCommand } from "./commands/zero/maps";
import { zeroBankingCommand } from "./commands/zero/banking";
import { zeroModelCommand } from "./commands/zero/model";
import { zeroModelProviderCommand } from "./commands/zero/model-provider";
import {
  decodeZeroTokenPayload,
  type ZeroTokenPayload,
} from "./lib/api/zero-token.js";

/**
 * Map of command names to the capability required to see them.
 * Commands not in this map are hidden when ZERO_TOKEN is active.
 * Use an array when a top-level command has subcommands with different
 * capability gates and any one of them should make the command visible.
 * Use `null` for commands that should always be visible in sandbox.
 */
const COMMAND_CAPABILITY_MAP: Record<
  string,
  string | readonly string[] | null
> = {
  agent: "agent:read",
  skill: "agent:read",
  connector: "connector:read",
  schedule: "schedule:read",
  automation: "schedule:read",
  doctor: null,
  credit: "billing:write",
  model: null,
  "model-provider": null,
  logs: "agent-run:read",
  search: "chat-message:read",
  github: ["github:read", "github:write"],
  slack: "slack:write",
  telegram: ["telegram:read", "telegram:write"],
  phone: ["phone:read", "phone:write"],
  whoami: null,
  "developer-support": null,
  "computer-use": "computer-use:write",
  generate: null,
  web: null,
  host: "host:write",
  maps: "maps:read",
  banking: "banking:read",
};

const DEFAULT_COMMANDS: Command[] = [
  zeroOrgCommand,
  zeroModelCommand,
  zeroModelProviderCommand,
  zeroAgentCommand,
  zeroConnectorCommand,
  zeroCreditCommand,
  zeroDoctorCommand,
  zeroPreferenceCommand,
  zeroScheduleCommand,
  zeroAutomationCommand,
  zeroSecretCommand,
  zeroGithubCommand,
  zeroSlackCommand,
  zeroTelegramCommand,
  zeroPhoneCommand,
  zeroVariableCommand,
  zeroLogsCommand,
  zeroSearchCommand,
  zeroWhoamiCommand,
  zeroSkillCommand,
  zeroDeveloperSupportCommand,
  zeroComputerUseCommand,
  generateCommand,
  zeroWebCommand,
  zeroHostCommand,
  zeroMapsCommand,
  zeroBankingCommand,
];

function shouldHideCommand(
  name: string,
  payload: ZeroTokenPayload | undefined,
): boolean {
  if (!payload) return false;
  const requiredCap = COMMAND_CAPABILITY_MAP[name];
  if (requiredCap === undefined) return true;
  if (requiredCap === null) return false;
  if (typeof requiredCap !== "string") {
    return !requiredCap.some((capability) => {
      return payload.capabilities.includes(capability);
    });
  }
  return !payload.capabilities.includes(requiredCap);
}

export function buildZeroHelpText(
  payload: ZeroTokenPayload | undefined = decodeZeroTokenPayload(),
): string {
  const examples = [
    "  Check a connector?     zero doctor check-connector --env-name <ENV_NAME>",
    ...(payload && !payload.capabilities.includes("billing:read")
      ? []
      : ["  Check credits?         zero doctor credit"]),
    ...(shouldHideCommand("credit", payload)
      ? []
      : ["  Buy credits?           zero credit 20000"]),
    "  Send a Slack message?  zero slack message send --help",
    "  Upload GitHub?        zero github upload-file --help",
    "  Download GitHub?      zero github download-file --help",
    "  List Telegram bots?    zero telegram bot list",
    "  Send Telegram?         zero telegram message send --help",
    "  Upload Telegram?       zero telegram upload-file --help",
    "  Download Telegram?     zero telegram download-file --help",
    "  Send AgentPhone?       zero phone message --help",
    "  Upload AgentPhone?     zero phone upload-file --help",
    "  Download AgentPhone?   zero phone download-file --help",
    "  Set up a schedule?     zero schedule setup --help",
    "  List models?          zero model ls",
    "  Model routing?        zero model-provider ls",
    "  Update yourself?       zero agent --help",
    "  Manage custom skills?  zero skill --help",
    "  List generators?       zero generate --help",
    '  Generate image?        zero generate image --prompt "..."',
    '  Generate website?      zero generate website --prompt "..."',
    '  Generate voice?        zero generate voice --prompt "..."',
    ...(shouldHideCommand("host", payload)
      ? []
      : ["  Host a static site?    zero host ./dist --site my-site --spa"]),
    ...(shouldHideCommand("maps", payload)
      ? []
      : [
          '  Get directions?       zero maps directions --origin "SFO" --destination "Mountain View" --json',
        ]),
    ...(shouldHideCommand("banking", payload)
      ? []
      : ["  Read bank data?       zero banking accounts --json"]),
    "  Check your identity?   zero whoami",
  ];

  return `\nExamples:\n${examples.join("\n")}`;
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
  .addHelpText("after", () => {
    return buildZeroHelpText();
  });

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
