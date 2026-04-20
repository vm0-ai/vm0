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
 */
export const DISALLOWED_TOOLS = [
  "CronCreate",
  "CronList",
  "CronDelete",
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
    "- Schedule recurring tasks: `zero schedule --help`. Do NOT use /loop or cron tools (CronCreate, CronList, CronDelete) — they are not available.",
    "- Slack messaging, file uploads, and file downloads: `zero slack --help`. Your replies are automatically sent to the originating thread — only use these commands for different channels/threads. Never use SLACK_TOKEN directly — it's a user OAuth token.",
    "- Download a Slack file attachment to local disk: `zero slack download-file -h` for usage and how to read different file types. Use this whenever a Slack message context includes a `[Slack file]` block.",
    "- Download a web-uploaded file to local disk: `zero web download-file -h` for usage and how to read different file types. Use this whenever a web chat message includes a `[Web file]` block.",
    "- Upload a local file and get a shareable URL: `zero web upload-file -h` for usage. Outputs JSON including a 7-day presigned URL you can share with the user or include in a message.",
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

/**
 * Build behavioral guidance for proactive skill management.
 * Injected when the AutoSkill feature switch is enabled.
 */
export function buildAutoSkillGuidance(): string {
  return [
    "# Skill Management Guidance",
    "",
    "You can create and maintain custom skills — reusable procedures that persist across sessions.",
    "",
    "## When to Create a Skill",
    "- After completing a complex, multi-step task (5+ tool calls) that may recur",
    "- After overcoming errors through a non-obvious workflow",
    "- When the user asks you to remember a procedure",
    "",
    "## When to Update a Skill",
    "- When using a skill and finding it outdated, incomplete, or incorrect — fix it immediately",
    "",
    "## When NOT to Create a Skill",
    "- For simple one-off tasks",
    "- For tasks that are already well-documented in existing skills",
    "",
    "## How to Manage Skills",
    "- Create: `zero skill create <name> --dir <path>` (directory must contain SKILL.md)",
    "- Update: `zero skill edit <name> --dir <path>`",
    "- View: `zero skill view <name>`",
    "- List: `zero skill list`",
    "- Bind to agent: `zero agent edit $ZERO_AGENT_ID --add-skill <name>`",
    "",
    "## Quality Standards",
    "Skills should include: trigger conditions, numbered steps with exact commands, common pitfalls, and verification steps.",
    "",
    "Always confirm with the user before creating or deleting a skill.",
  ].join("\n");
}
