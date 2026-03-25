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
 * Build Zero CLI guidance prompt so sandbox agents know how to use the CLI.
 * Injected by createZeroRun() for all trigger paths.
 */
export function buildZeroCliGuidance(): string {
  return [
    "# Zero CLI",
    "You have access to the Zero CLI for managing platform resources.",
    "Run commands with: `npx -p @vm0/cli zero <command>`",
    "Tip: run `alias zero='npx -p @vm0/cli zero'` first, then use `zero <command>` for brevity.",
    "Run `npx -p @vm0/cli zero --help` to see all available commands.",
    "Do NOT use /loop or cron tools (CronCreate, CronList, CronDelete) — they are not available.",
    "For recurring or scheduled tasks, use the zero schedule CLI.",
    "Use `zero slack message send` to send Slack messages as the bot user.",
  ].join("\n");
}
