// Zero CLI entry point - standalone binary for zero platform commands
// Sentry must be initialized before any other imports
import "./instrument.js";
import { Command } from "commander";
import { configureGlobalProxyFromEnv } from "./lib/network/proxy.js";
import {
  decodeZeroTokenPayload,
  type ZeroTokenPayload,
} from "./lib/api/zero-token.js";

interface ZeroCommandDefinition {
  name: string;
  description: string;
  load: () => Promise<Command>;
}

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
  workflow: "agent:read",
  goal: ["goal:read", "goal:agent-result:write", "goal:user-control:write"],
  connector: "connector:read",
  relationship: "relationship:read",
  // "schedule" is deliberately absent: the rename stub stays out of
  // token-scoped (agent) help but remains invokable and visible to humans.
  automation: "automation:read",
  doctor: null,
  credit: "billing:write",
  model: null,
  "model-provider": null,
  logs: "agent-run:read",
  search: "chat-message:read",
  chat: ["chat-thread:read", "chat-thread:write"],
  resource: null,
  github: ["github:read", "github:write"],
  slack: "slack:write",
  telegram: ["telegram:read", "telegram:write"],
  phone: ["phone:read", "phone:write"],
  whoami: null,
  "developer-support": null,
  "computer-use": "computer-use:write",
  generate: null,
  web: null,
  video: null,
  host: ["host:read", "host:write"],
  maps: "maps:read",
  banking: "banking:read",
};

const ZERO_COMMAND_DEFINITIONS: readonly ZeroCommandDefinition[] = [
  {
    name: "org",
    description: "Manage organization settings, members, and providers",
    load: async () => {
      return (await import("./commands/zero/org")).zeroOrgCommand;
    },
  },
  {
    name: "model",
    description: "List available models and model-switching guidance",
    load: async () => {
      return (await import("./commands/zero/model")).zeroModelCommand;
    },
  },
  {
    name: "model-provider",
    description: "Inspect model provider routing",
    load: async () => {
      return (await import("./commands/zero/model-provider"))
        .zeroModelProviderCommand;
    },
  },
  {
    name: "agent",
    description: "View or manage zero agents",
    load: async () => {
      return (await import("./commands/zero/agent")).zeroAgentCommand;
    },
  },
  {
    name: "connector",
    description: "Check third-party service connections (GitHub, Slack, etc.)",
    load: async () => {
      return (await import("./commands/zero/connector")).zeroConnectorCommand;
    },
  },
  {
    name: "relationship",
    description: "Query relationship memory",
    load: async () => {
      return (await import("./commands/zero/relationship"))
        .zeroRelationshipCommand;
    },
  },
  {
    name: "credit",
    description: "Create a Stripe checkout link to buy credits",
    load: async () => {
      return (await import("./commands/zero/credit")).zeroCreditCommand;
    },
  },
  {
    name: "doctor",
    description:
      "Diagnose runtime issues (connector health, permission denials)",
    load: async () => {
      return (await import("./commands/zero/doctor")).zeroDoctorCommand;
    },
  },
  {
    name: "preference",
    description: "View or update user preferences (timezone, notifications)",
    load: async () => {
      return (await import("./commands/zero/preference")).zeroPreferenceCommand;
    },
  },
  {
    name: "schedule",
    description:
      "(removed: use `zero automation`) Schedules are Automations now",
    load: async () => {
      return (await import("./commands/zero/schedule")).zeroScheduleCommand;
    },
  },
  {
    name: "automation",
    description: "Create or manage scheduled automations",
    load: async () => {
      return (await import("./commands/zero/automation")).zeroAutomationCommand;
    },
  },
  {
    name: "secret",
    description: "Read or write secrets (API keys, tokens)",
    load: async () => {
      return (await import("./commands/zero/secret")).zeroSecretCommand;
    },
  },
  {
    name: "github",
    description: "Upload and download GitHub files",
    load: async () => {
      return (await import("./commands/zero/github")).zeroGithubCommand;
    },
  },
  {
    name: "slack",
    description:
      "Send messages, upload files, and download files from Slack as the bot",
    load: async () => {
      return (await import("./commands/zero/slack")).zeroSlackCommand;
    },
  },
  {
    name: "telegram",
    description:
      "Inspect bots, send messages, upload files, and download files from Telegram",
    load: async () => {
      return (await import("./commands/zero/telegram")).zeroTelegramCommand;
    },
  },
  {
    name: "phone",
    description: "Send AgentPhone messages, upload files, and download media",
    load: async () => {
      return (await import("./commands/zero/phone")).zeroPhoneCommand;
    },
  },
  {
    name: "variable",
    description: "Read or write non-sensitive configuration values",
    load: async () => {
      return (await import("./commands/zero/variable")).zeroVariableCommand;
    },
  },
  {
    name: "logs",
    description: "View and search agent run logs",
    load: async () => {
      return (await import("./commands/zero/logs")).zeroLogsCommand;
    },
  },
  {
    name: "search",
    description: "Search logs, chat, or get a recipe for external sources",
    load: async () => {
      return (await import("./commands/zero/search")).zeroSearchCommand;
    },
  },
  {
    name: "chat",
    description: "Manage the current web chat thread",
    load: async () => {
      return (await import("./commands/zero/chat")).zeroChatCommand;
    },
  },
  {
    name: "resource",
    description: "Pull registry resources from private R2-backed archives",
    load: async () => {
      return (await import("./commands/zero/resource")).zeroResourceCommand;
    },
  },
  {
    name: "whoami",
    description: "Show agent identity, run ID, and capabilities",
    load: async () => {
      return (await import("./commands/zero/whoami")).zeroWhoamiCommand;
    },
  },
  {
    name: "workflow",
    description: "Manage workflows",
    load: async () => {
      return (await import("./commands/zero/workflow")).zeroWorkflowCommand;
    },
  },
  {
    name: "goal",
    description: "Manage the current thread goal",
    load: async () => {
      return (await import("./commands/zero/goal")).zeroGoalCommand;
    },
  },
  {
    name: "developer-support",
    description: "Submit a diagnostic report to the dev team",
    load: async () => {
      return (await import("./commands/zero/developer-support"))
        .zeroDeveloperSupportCommand;
    },
  },
  {
    name: "computer-use",
    description: "Desktop app computer use through Zero CLI",
    load: async () => {
      return (await import("./commands/zero/computer-use"))
        .zeroComputerUseCommand;
    },
  },
  {
    name: "generate",
    description:
      "Generate assets via vm0's built-in pipelines or get connector skill-invocation guidance",
    load: async () => {
      return (await import("./commands/zero/generate")).generateCommand;
    },
  },
  {
    name: "web",
    description: "Upload and download files via the web chat endpoint",
    load: async () => {
      return (await import("./commands/zero/web")).zeroWebCommand;
    },
  },
  {
    name: "video",
    description: "Video processing utilities",
    load: async () => {
      return (await import("./commands/zero/video")).zeroVideoCommand;
    },
  },
  {
    name: "host",
    description: "Publish static sites and clone owned hosted site files",
    load: async () => {
      return (await import("./commands/zero/host")).zeroHostCommand;
    },
  },
  {
    name: "maps",
    description: "Use managed zero maps services",
    load: async () => {
      return (await import("./commands/zero/maps")).zeroMapsCommand;
    },
  },
  {
    name: "banking",
    description: "Use managed zero banking services",
    load: async () => {
      return (await import("./commands/zero/banking")).zeroBankingCommand;
    },
  },
];

const ZERO_COMMAND_DEFINITION_BY_NAME = new Map(
  ZERO_COMMAND_DEFINITIONS.map((definition) => {
    return [definition.name, definition];
  }),
);

function createZeroCommandStub(definition: ZeroCommandDefinition): Command {
  return new Command(definition.name).description(definition.description);
}

function buildDefaultCommands(): Command[] {
  return ZERO_COMMAND_DEFINITIONS.map(createZeroCommandStub);
}

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

function addZeroCommand(
  prog: Command,
  cmd: Command,
  payload: ZeroTokenPayload | undefined,
): void {
  const hidden = shouldHideCommand(cmd.name(), payload);
  prog.addCommand(cmd, hidden ? { hidden: true } : {});
}

function getNonOptionArgs(argv: string[]): string[] {
  const args: string[] = [];

  for (const arg of argv.slice(2)) {
    if (arg === "--") {
      break;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    args.push(arg);
  }

  return args;
}

function getRequestedZeroCommandName(argv = process.argv): string | undefined {
  const [firstArg, secondArg] = getNonOptionArgs(argv);

  if (!firstArg) {
    return undefined;
  }

  if (firstArg === "help") {
    return secondArg;
  }

  return firstArg;
}

async function loadZeroCommand(
  name: string | undefined,
): Promise<Command | undefined> {
  if (!name) {
    return undefined;
  }

  return ZERO_COMMAND_DEFINITION_BY_NAME.get(name)?.load();
}

export function buildZeroHelpText(
  payload: ZeroTokenPayload | undefined = decodeZeroTokenPayload(),
): string {
  const canReadHost = !payload || payload.capabilities.includes("host:read");
  const canWriteHost = !payload || payload.capabilities.includes("host:write");
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
    "  Automate a task?       zero automation create --help",
    "  List models?          zero model ls",
    "  Model routing?        zero model-provider ls",
    "  Update yourself?       zero agent --help",
    "  Manage workflows?     zero workflow --help",
    ...(shouldHideCommand("chat", payload)
      ? []
      : ['  Rename this chat?     zero chat rename "New title"']),
    "  List generators?       zero generate --help",
    '  Generate image?        zero generate image --prompt "..."',
    '  Generate website?      zero generate website --prompt "..."',
    '  Generate voice?        zero generate voice --prompt "..."',
    ...(canWriteHost
      ? ["  Host a static site?    zero host ./dist --site my-site --spa"]
      : []),
    ...(canReadHost
      ? ["  Clone hosted site?     zero host clone <public-slug>"]
      : []),
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

  for (const cmd of commands ?? buildDefaultCommands()) {
    addZeroCommand(prog, cmd, payload);
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
  await configureGlobalProxyFromEnv();
  const requestedCommand = await loadZeroCommand(getRequestedZeroCommandName());
  registerZeroCommands(
    program,
    requestedCommand ? [requestedCommand] : undefined,
  );
  program.parse();
}
