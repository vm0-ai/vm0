interface AgentIdentity {
  displayName: string | null;
  description: string | null;
  sound: string | null;
}

const TONE_INSTRUCTIONS: Readonly<Record<string, string>> = {
  professional:
    "Communicate in a clear, polished, and business-appropriate tone. Be thorough yet concise.",
  friendly:
    "Communicate in a warm, approachable, and conversational tone. Feel free to be casual while still being helpful.",
  direct:
    "Be brief and to the point. Skip pleasantries and filler — just deliver the information or action needed.",
  supportive:
    "Be encouraging and empathetic. Show that you're in the user's corner and proactively offer help.",
};

/**
 * Build the agent system prompt: identity + tools.
 */
export function buildAgentPrompt(identity: AgentIdentity): string {
  const parts: string[] = [];
  if (identity.displayName || identity.description || identity.sound) {
    parts.push(buildAgentIdentityPrompt(identity));
  }
  parts.push(buildAgentToolsPrompt());
  return parts.join("\n\n");
}

function buildAgentIdentityPrompt(identity: AgentIdentity): string {
  const parts: string[] = [];

  if (identity.displayName) {
    parts.push(`Your name is ${identity.displayName}.`);
  }

  if (identity.description) {
    parts.push(`Your role: ${identity.description}`);
  }

  if (identity.sound) {
    const instruction = TONE_INSTRUCTIONS[identity.sound];
    if (instruction) {
      parts.push(instruction);
    }
  }

  return `# Agent Identity\n${parts.join("\n")}`;
}

/**
 * Tools to disallow for all zero agent runs.
 * - Cron tools: agents use `zero schedule` instead.
 * - ScheduleWakeup: powers /loop dynamic (self-paced) mode; agents use `zero schedule` instead.
 * - AskUserQuestion: zero agents run unattended and cannot block on interactive input.
 */
export const DISALLOWED_TOOLS = [
  "CronCreate",
  "CronList",
  "CronDelete",
  "ScheduleWakeup",
  "AskUserQuestion",
] as const;

/**
 * Build Agent Tools prompt so sandbox agents know how to use the Zero CLI.
 * Injected by createZeroRun() for all trigger paths.
 */
function buildAgentToolsPrompt(): string {
  return [
    "# Agent Tools",
    "You have access to the Zero CLI. Run commands with: `npx -p @vm0/cli zero <command>`",
    "- Discover available commands: `zero --help`.",
    "- Search agent run logs, web chat messages, or external services via connectors: `zero search --help`.",
    "- Schedule recurring tasks: `zero schedule --help`. Do NOT use /loop, cron tools (CronCreate, CronList, CronDelete), or ScheduleWakeup — they are not available.",
    "- Slack messaging, file uploads, and file downloads: `zero slack --help`. Your replies are automatically sent to the originating thread — only use these commands for different channels/threads. Never use SLACK_TOKEN directly — it's a user OAuth token.",
    "- Download a Slack file attachment to local disk: `zero slack download-file -h` for usage and how to read different file types. Use this whenever a Slack message context includes a `[Slack file]` block.",
    "- Download a Telegram file attachment to local disk: `zero telegram download-file -h` for usage and how to read different file types. Use this whenever a Telegram message context includes a `[Telegram file]` block; pass the block's `[Bot ID]` value with `--bot-id`.",
    "- Telegram messaging, file uploads, and file downloads: `zero telegram --help`. Use `zero telegram bot list` to inspect available bots in the active org, and use `zero telegram message send --help` to send a Telegram message. When sending, explicitly choose the bot with `--bot-id`; if you do not know which bot to use, ask the user before sending. Your replies are automatically sent to the originating chat — only use these commands for different chats, topics, or reply targets.",
    "- Upload a local file to Telegram: `zero telegram upload-file -h` for usage. Pass the Telegram message context's Bot ID and Chat ID with `--bot-id` and `--chat-id`.",
    "- Download a web-uploaded file to local disk: `zero web download-file -h` for usage and how to read different file types. Use this whenever a web chat message includes a `[Web file]` block.",
    '- Generate a billed WAV speech file from text for web chat: `zero web voice --text "Hello"`. It returns a shareable `/f/` URL and metadata; use `zero web voice -h` for voice and style options.',
    "- The user cannot see files on your local filesystem. If the user needs to view or download a local file, upload it through the appropriate integration first: use `zero web upload-file` for web chat, `zero slack upload-file` for Slack, or `zero telegram upload-file` for Telegram, then share the returned URL or platform file reference. Do not present a local path as something the user can open.",
    "- Third-party services (GitHub, Slack, Notion, 100+ more) are accessed via connectors that expose env vars like `GH_TOKEN`. Find: `zero connector search <keyword>`. List connected: `zero connector list`. Inspect: `zero connector status <type>`.",
    "- Diagnose connector health (token presence, firewall rules, permission policies): `zero doctor check-connector --help`.",
    "- Troubleshoot permission denials: `zero doctor permission-deny --help` to identify which permission covers a blocked request.",
    "- Request permission changes: `zero doctor permission-change --help` to enable or disable a permission.",
    "- Inspect yourself: `zero whoami` for identity and permissions, `zero agent view $ZERO_AGENT_ID --instructions` for your current settings.",
    "- When the user asks to change your behavior, update your own configuration (instructions, tone, description): `zero agent edit --help`.",
    "- Manage custom skills: `zero skill --help`.",
    "- Send a direct message to the user via web chat: `zero chat message send --help`.",
    "- Report issues to the dev team: `zero developer-support --help`. Requires a two-step consent flow: (1) call without --consent-code to get a code, (2) ask the user to type it, (3) call again with --consent-code. Never submit without the user typing the consent code.",
  ].join("\n");
}
