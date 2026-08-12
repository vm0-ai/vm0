// Okou CLI entry point - standalone binary for vm0 platform commands
// Sentry must be initialized before any other imports
import "./instrument.js";
import { Command } from "commander";
import { zeroTranslateCommand } from "./commands/zero/translate";
import { configureGlobalProxyFromEnv } from "./lib/network/proxy.js";
import {
  decodeZeroTokenPayload,
  type ZeroTokenPayload,
} from "./lib/api/zero-token.js";
import { getOkouToken } from "./lib/okou-env.js";

interface ZeroCommandDefinition {
  name: string;
  description: string;
  load: () => Promise<Command>;
}

/**
 * Map of command names to the capability required to see them.
 * Commands not in this map are hidden when OKOU_TOKEN is active.
 * Use an array when a top-level command has subcommands with different
 * capability gates and any one of them should make the command visible.
 * Use `null` for commands that should always be visible in sandbox.
 */
const COMMAND_CAPABILITY_MAP: Record<
  string,
  string | readonly string[] | null
> = {
  "__agent-loop": null,
  agent: "agent:read",
  workflow: "agent:read",
  goal: ["goal:read", "goal:agent-result:write", "goal:user-control:write"],
  connector: ["connector:read", "connector:write"],
  mcp: "connector:read",
  "presentation-template": null,
  mail: "connector:read",
  doctor: null,
  credit: ["billing:read", "billing:write"],
  upgrade: null,
  model: null,
  "model-provider": null,
  logs: "agent-run:read",
  search: "chat-event:read",
  chat: [
    "chat-event:read",
    "chat-event:write",
    "chat-thread:read",
    "chat-thread:write",
  ],
  resource: null,
  github: ["github:read", "github:write"],
  slack: "slack:write",
  feishu: "feishu:write",
  teams: "teams:write",
  telegram: ["telegram:read", "telegram:write"],
  phone: ["phone:read", "phone:write"],
  whoami: null,
  "developer-support": null,
  "computer-use": "computer-use:write",
  browser: ["browser:read", "browser:write"],
  intro: null,
  generate: null,
  web: null,
  video: null,
  host: ["host:read", "host:write"],
  maps: "maps:read",
  weather: "weather:read",
  scrape: "scrape:read",
  "people-search": "people-search:read",
  "web-search": "web-search:read",
  recognize: "image-recognition:write",
  translate: "translation:write",
  finance: "finance:read",
  seo: "seo:read",
  banking: "banking:read",
};

const RUN_ONLY_COMMANDS = new Set([
  "mcp",
  "presentation-template",
  "recognize",
  "translate",
]);

const ZERO_COMMAND_DEFINITIONS: readonly ZeroCommandDefinition[] = [
  {
    name: "__agent-loop",
    description: "Internal sandbox agent loop",
    load: async () => {
      return (await import("./commands/zero/__agent-loop"))
        .zeroAgentLoopCommand;
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
    description: "View or manage agents",
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
    name: "mcp",
    description: "Use MCP Custom Connectors authorized for this Agent",
    load: async () => {
      return (await import("./commands/zero/mcp")).zeroMcpCommand;
    },
  },
  {
    name: "presentation-template",
    description: "Run-scoped presentation template import I/O",
    load: async () => {
      return (await import("./commands/zero/presentation-template"))
        .zeroPresentationTemplateCommand;
    },
  },
  {
    name: "mail",
    description: "Review and send mail through Gmail or Outlook Mail",
    load: async () => {
      return (await import("./commands/zero/mail")).zeroMailCommand;
    },
  },
  {
    name: "credit",
    description: "View or buy credits",
    load: async () => {
      return (await import("./commands/zero/credit")).zeroCreditCommand;
    },
  },
  {
    name: "upgrade",
    description: "Create a workspace plan upgrade link",
    load: async () => {
      return (await import("./commands/zero/upgrade")).zeroUpgradeCommand;
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
    name: "feishu",
    description: "Send messages to Feishu as an organization bot",
    load: async () => {
      return (await import("./commands/zero/feishu")).zeroFeishuCommand;
    },
  },
  {
    name: "teams",
    description:
      "Send Microsoft Teams messages, upload files, and download files",
    load: async () => {
      return (await import("./commands/zero/teams")).zeroTeamsCommand;
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
    name: "intro",
    description: "Print Okou's self-introduction and capability guide",
    load: async () => {
      return (await import("./commands/zero/intro")).zeroIntroCommand;
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
    description: "Desktop app computer use through Okou CLI",
    load: async () => {
      return (await import("./commands/zero/computer-use"))
        .zeroComputerUseCommand;
    },
  },
  {
    name: "browser",
    description: "Managed remote browser sessions for agent-browser",
    load: async () => {
      return (await import("./commands/zero/browser")).zeroBrowserCommand;
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
    description: "Use managed Okou maps services",
    load: async () => {
      return (await import("./commands/zero/maps")).zeroMapsCommand;
    },
  },
  {
    name: "weather",
    description: "Use managed Okou weather services",
    load: async () => {
      return (await import("./commands/zero/weather")).zeroWeatherCommand;
    },
  },
  {
    name: "scrape",
    description: "Scrape public web pages through managed Okou scrape",
    load: async () => {
      return (await import("./commands/zero/scrape")).zeroScrapeCommand;
    },
  },
  {
    name: "people-search",
    description: "Find professionals through managed Okou people search",
    load: async () => {
      return (await import("./commands/zero/people-search"))
        .zeroPeopleSearchCommand;
    },
  },
  {
    name: "web-search",
    description: "Search the public web through managed Okou web search",
    load: async () => {
      return (await import("./commands/zero/web-search")).zeroWebSearchCommand;
    },
  },
  {
    name: "recognize",
    description: "Recognize one image through a managed multimodal model",
    load: async () => {
      return (await import("./commands/zero/recognize")).zeroRecognizeCommand;
    },
  },
  {
    name: "translate",
    description: "Translate text through a managed translation model",
    load: async () => {
      return zeroTranslateCommand;
    },
  },
  {
    name: "finance",
    description: "Query financial instruments through managed Okou finance",
    load: async () => {
      return (await import("./commands/zero/finance")).zeroFinanceCommand;
    },
  },
  {
    name: "seo",
    description: "Query managed SEO data through DataForSEO",
    load: async () => {
      return (await import("./commands/zero/seo")).zeroSeoCommand;
    },
  },
  {
    name: "banking",
    description: "Use managed Okou banking services",
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
  if (name.startsWith("__")) return true;
  if (!payload) return RUN_ONLY_COMMANDS.has(name);
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

function commandExampleIfVisible(
  name: string,
  example: string,
  payload: ZeroTokenPayload | undefined,
): string[] {
  return shouldHideCommand(name, payload) ? [] : [example];
}

export function buildZeroHelpText(
  payload: ZeroTokenPayload | undefined = decodeZeroTokenPayload(),
): string {
  const canReadHost = !payload || payload.capabilities.includes("host:read");
  const canWriteHost = !payload || payload.capabilities.includes("host:write");
  const examples = [
    "  Check a connector?     okou connector check --env-name <ENV_NAME>",
    ...(payload && !payload.capabilities.includes("billing:read")
      ? []
      : ["  Check credits?         okou credit"]),
    ...(payload && !payload.capabilities.includes("billing:write")
      ? []
      : ["  Buy credits?           okou credit 20000"]),
    ...commandExampleIfVisible(
      "upgrade",
      "  Upgrade plan?         okou upgrade pro",
      payload,
    ),
    "  Send a Slack message?  okou slack message send --help",
    ...commandExampleIfVisible(
      "feishu",
      "  Send Feishu?          okou feishu message send --help",
      payload,
    ),
    ...commandExampleIfVisible(
      "mail",
      "  Link Gmail draft?     okou mail link --help",
      payload,
    ),
    "  Send Teams?           okou teams message send --help",
    "  Upload Teams?         okou teams upload-file --help",
    "  Download Teams?       okou teams download-file --help",
    "  Upload GitHub?        okou github upload-file --help",
    "  Download GitHub?      okou github download-file --help",
    "  List Telegram bots?    okou telegram bot list",
    "  Send Telegram?         okou telegram message send --help",
    "  Upload Telegram?       okou telegram upload-file --help",
    "  Download Telegram?     okou telegram download-file --help",
    "  Send AgentPhone?       okou phone message --help",
    "  Upload AgentPhone?     okou phone upload-file --help",
    "  Download AgentPhone?   okou phone download-file --help",
    "  List models?          okou model ls",
    "  Model routing?        okou model-provider ls",
    "  Update yourself?       okou agent --help",
    "  Manage workflows?     okou workflow --help",
    ...commandExampleIfVisible(
      "chat",
      '  Rename this chat?     okou chat rename "New title"',
      payload,
    ),
    "  Introduce Okou?       okou intro",
    "  List generators?       okou generate --help",
    '  Generate image?        okou generate image --raw-prompt "..."',
    '  Generate website?      okou generate website --prompt "..."',
    '  Generate voice?        okou generate voice --prompt "..."',
    ...(canWriteHost
      ? ["  Host a static site?    okou host ./dist --site my-site --spa"]
      : []),
    ...(canReadHost
      ? ["  Clone hosted site?     okou host clone <public-slug>"]
      : []),
    ...commandExampleIfVisible(
      "maps",
      '  Get directions?       okou maps directions --origin "SFO" --destination "Mountain View" --json',
      payload,
    ),
    ...commandExampleIfVisible(
      "weather",
      "  Check weather?        okou weather current --lat 39.9042 --lng 116.4074 --json",
      payload,
    ),
    ...commandExampleIfVisible(
      "scrape",
      "  Scrape a web page?    okou scrape https://example.com --json",
      payload,
    ),
    ...commandExampleIfVisible(
      "web-search",
      '  Search the public web? okou web-search "latest news" --json',
      payload,
    ),
    ...commandExampleIfVisible(
      "recognize",
      '  Recognize an image?    okou recognize --file ./image.png --prompt "Describe it"',
      payload,
    ),
    ...commandExampleIfVisible(
      "translate",
      '  Translate text?        okou translate "Hello" --to Chinese',
      payload,
    ),
    ...commandExampleIfVisible(
      "finance",
      "  Get a market quote?   okou finance quote AAPL --json",
      payload,
    ),
    ...commandExampleIfVisible(
      "seo",
      '  Research SEO data?    okou seo serp "technical seo" --json',
      payload,
    ),
    ...commandExampleIfVisible(
      "people-search",
      '  Find a professional?   okou people-search "platform engineering leaders" --json',
      payload,
    ),
    ...commandExampleIfVisible(
      "banking",
      "  Read bank data?       okou banking accounts --json",
      payload,
    ),
    "  Check your identity?   okou whoami",
  ];

  return `\nExamples:\n${examples.join("\n")}`;
}

/**
 * Register commands with visibility based on OKOU_TOKEN capabilities.
 * Commands not granted by the token are registered as hidden via
 * Commander's public `addCommand(cmd, { hidden: true })` API.
 * Without OKOU_TOKEN, globally available commands stay visible while
 * run-only commands remain hidden.
 *
 * @param commands - override default commands (used in tests)
 */
export function registerZeroCommands(
  prog: Command,
  commands?: Command[],
): void {
  const token = getOkouToken();
  const payload = token ? decodeZeroTokenPayload(token) : undefined;

  for (const cmd of commands ?? buildDefaultCommands()) {
    addZeroCommand(prog, cmd, payload);
  }
}

const program = new Command();

declare const __CLI_VERSION__: string;

program
  .name("okou")
  .description("Okou CLI — interact with vm0 from inside the sandbox")
  .version(__CLI_VERSION__)
  .addHelpText("after", () => {
    return buildZeroHelpText();
  });

export { program };

if (
  process.argv[1]?.endsWith("okou.js") ||
  process.argv[1]?.endsWith("okou.ts") ||
  process.argv[1]?.endsWith("okou")
) {
  await configureGlobalProxyFromEnv();
  const requestedCommand = await loadZeroCommand(getRequestedZeroCommandName());
  registerZeroCommands(
    program,
    requestedCommand ? [requestedCommand] : undefined,
  );
  program.parse();
}
