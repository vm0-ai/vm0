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
 * - AskUserQuestion: agents use `zero ask-user question` instead.
 */
export const DISALLOWED_TOOLS = [
  "CronCreate",
  "CronList",
  "CronDelete",
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
    "- When you need to discover available commands, run `zero --help`.",
    "- When you need to delegate a task to a teammate agent, use `zero agent list` and `zero run --help`.",
    "- When you need to schedule or manage recurring tasks, use `zero schedule --help`. Do NOT use /loop or cron tools (CronCreate, CronList, CronDelete) — they are not available.",
    "- When you need to ask the user a question, use `zero ask-user question --help`.",
    "- Your replies are automatically sent to the originating thread. Only use `zero slack message send` when you need to message a different channel or thread. Never use SLACK_TOKEN to send messages directly — it's a user OAuth token.",
    "- When you encounter a missing token or environment variable error, run `zero doctor missing-token <TOKEN_NAME>` to diagnose the issue and get remediation steps for the user.",
    '- When you encounter a 403 error with "firewall_permission_denied", run `zero doctor firewall-deny <FIREWALL_REF> --method <METHOD> --path <PATH>` using the "firewall", "method", and "path" fields from the JSON error response to get remediation steps for the user.',
    "- When you need to update your own configuration (instructions, skills, tone, etc.), use `zero agent edit --help`. Use `zero agent view $ZERO_AGENT_ID --instructions` to review your current settings first.",
    "- When you need to create or edit custom skill content, use `zero skill --help`.",
  ].join("\n");
}
