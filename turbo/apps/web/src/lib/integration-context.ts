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
  options?: { botUserId?: string },
): string {
  let context = `# Current Integration\nYou are currently running inside: ${platform}`;
  if (options?.botUserId) {
    context += `\nYour bot user ID: ${options.botUserId}`;
  }
  return context;
}

/**
 * Cron tools to disallow when schedule guidance is active.
 */
export const DISALLOWED_CRON_TOOLS = [
  "CronCreate",
  "CronList",
  "CronDelete",
] as const;

/**
 * Build Agent Tools prompt so sandbox agents know how to use the Zero CLI.
 * Injected by createZeroRun() for all trigger paths.
 */
export function buildAgentToolsPrompt(): string {
  return [
    "# Agent Tools",
    "You have access to the Zero CLI for zero platform. Run commands with: `npx -p @vm0/cli zero <command>`",
    "- Use `zero --help` to see all available commands.",
    "- Use `zero schedule --help` for recurring or scheduled tasks. Do NOT use /loop or cron tools (CronCreate, CronList, CronDelete) — they are not available.",
    "- Use `zero slack message send` to send messages as bot token. Never use SLACK_TOKEN to send messages — it's a user token.",
  ].join("\n");
}
