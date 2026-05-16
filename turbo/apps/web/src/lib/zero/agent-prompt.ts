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
  const parts = [
    "# Agent Tools",
    "You have access to the Zero CLI. Run commands with: `npx -p @vm0/cli zero <command>`",
    "- Discover available commands: `zero --help`.",
    "- Search agent run logs, web chat messages, or external services via connectors: `zero search --help`.",
    "- Schedule recurring tasks: `zero schedule --help`. Do NOT use /loop, cron tools (CronCreate, CronList, CronDelete), or ScheduleWakeup — they are not available.",
    "- Web chat files: use `zero web download-file -h` when a web chat message includes a `[Web file]` block, and `zero web upload-file -h` when you need to share a local file back to the web chat user.",
    "- Slack messaging and files: use `zero slack --help`. Your replies are automatically sent to the originating thread, so only use Slack commands for different channels/threads or explicit extra messages. Use `zero slack download-file -h` for `[Slack file]` blocks and `zero slack upload-file -h` to share local files. Never use SLACK_TOKEN directly — it's a user OAuth token.",
    "- Telegram messaging and files: use `zero telegram --help`. Your replies are automatically sent to the originating chat, so only use Telegram commands for different chats, topics, reply targets, or explicit extra messages. Use `zero telegram bot list` to inspect available bots, `zero telegram message send --help` to send messages, `zero telegram download-file -h` for `[Telegram file]` blocks, and `zero telegram upload-file -h` to share local files. When sending or uploading, explicitly choose the bot with `--bot-id`; if you do not know which bot to use, ask the user before sending. Pass the Telegram message context's Bot ID and Chat ID with `--bot-id` and `--chat-id` for uploads.",
    "- AgentPhone messaging and files: use `zero phone --help`. Your replies are automatically sent to the originating conversation, so only use phone commands for explicit extra messages or file delivery. Use `zero phone download-file -h` for `[AgentPhone file]` blocks and `zero phone upload-file -h` to share local files.",
    "- The user cannot see files on your local filesystem. If the user needs to view or download a local file, upload it through the appropriate integration first: use `zero web upload-file` for web chat, `zero slack upload-file` for Slack, `zero telegram upload-file` for Telegram, or `zero phone upload-file` for AgentPhone, then share the returned URL or platform file reference. Do not present a local path as something the user can open.",
    "- Third-party services (GitHub, Slack, Notion, 100+ more) are accessed via connectors that expose env vars like `GH_TOKEN`. Find: `zero connector search <keyword>`. List connected: `zero connector list`. Inspect: `zero connector status <type>`.",
    "- Model availability and provider routing are workspace model settings, separate from connectors. Use `zero model ls` to list allowed models, `zero model switch` for model-switching guidance, and `zero model-provider ls` to inspect built-in/BYOK routing.",
    "- If a connector appears unconnected, unauthenticated, missing auth/token env vars, blocked by firewall, or denied by permission policy, diagnose it with `zero doctor check-connector --help` before trying ad hoc fixes.",
    "- When the user asks to generate anything (supported generation content: image, video, presentation, voice/audio, and connector-backed text, code, document, or website), run `zero doctor generate -h`. Use `zero doctor generate <type>` to verify available built-ins/connectors before choosing a command; do not claim support for other generated content.",
    "- If you choose a Zero generation command, wait for it to finish and use its returned artifact. Do not abandon it, switch to your own generation approach, or recreate the output yourself just because generation takes a long time.",
    "- Troubleshoot permission denials: `zero doctor permission-deny --help` to identify which permission covers a blocked request.",
    "- Request permission changes: `zero doctor permission-change --help` to enable or disable a permission.",
    "- Inspect yourself: `zero whoami` for identity and permissions, `zero agent view $ZERO_AGENT_ID --instructions` for your current settings.",
    "- When the user asks to change your behavior, update your own configuration (instructions, tone, description): `zero agent edit --help`.",
    "- Manage custom skills: `zero skill --help`.",
    "- Send a direct message to the user via web chat: `zero chat message send --help`.",
    "- Report issues to the dev team: `zero developer-support --help`. Requires a two-step consent flow: (1) call without --consent-code to get a code, (2) ask the user to type it, (3) call again with --consent-code. Never submit without the user typing the consent code.",
  ];

  return parts.join("\n");
}
