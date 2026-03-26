/**
 * The platform (integration) an agent run originates from.
 * Used to inject context so the agent knows which channel it is operating in.
 */
type IntegrationPlatform = "Email" | "GitHub" | "Slack" | "Telegram";

/**
 * Build the integration context header prepended to agent run prompts.
 */
export function buildIntegrationContext(
  platform: IntegrationPlatform,
  options?: {
    botUserId?: string;
    channelId?: string;
    channelType?: "channel" | "dm" | "group_dm";
  },
): string {
  let context = `# Current Integration\nYou are currently running inside: ${platform}`;
  if (options?.botUserId) {
    context += `\nYour bot user ID: ${options.botUserId}`;
  }
  if (options?.channelId) {
    context += `\nChannel ID: ${options.channelId}`;
  }
  if (options?.channelType) {
    const typeLabel =
      options.channelType === "dm"
        ? "Direct message"
        : options.channelType === "group_dm"
          ? "Group direct message"
          : "Channel";
    context += `\nChannel type: ${typeLabel}`;
  }
  return context;
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
export function buildAgentToolsPrompt(): string {
  return [
    "# Agent Tools",
    "You have access to the Zero CLI. Run commands with: `npx -p @vm0/cli zero <command>`",
    "- When you need to discover available commands, run `zero --help`.",
    "- When you need to schedule or manage recurring tasks, use `zero schedule`. Do NOT use /loop or cron tools (CronCreate, CronList, CronDelete) — they are not available.",
    '- When you need to ask the user a question, use `zero ask-user question` with at least one `--option` flag. Do NOT use the AskUserQuestion tool — it is not available. Example: `zero ask-user question "Pick one" --option "Yes" --option "No"`',
    "- When you need to send a Slack message, use `zero slack message send`. Never use SLACK_TOKEN directly — it's a user token.",
    "- When you encounter a missing token or environment variable error, run `zero doctor missing-token <TOKEN_NAME>` to diagnose the issue and get remediation steps for the user.",
    "- When you need to update your own configuration (description, tone, or instructions), use `zero agent edit $ZERO_AGENT_ID`. Use `zero agent view $ZERO_AGENT_ID --instructions` to review your current settings first.",
  ].join("\n");
}
