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
