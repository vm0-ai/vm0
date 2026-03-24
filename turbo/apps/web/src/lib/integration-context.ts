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
 * Build schedule guidance prompt that redirects agents from ephemeral cron
 * tools to vm0's persistent schedule system.
 */
export function buildScheduleGuidance(): string {
  return [
    "# Scheduling Tasks",
    "Do NOT use /loop or cron tools (CronCreate, CronList, CronDelete) — they are not available.",
    "For recurring or scheduled tasks, use the vm0 schedule CLI:",
    "- Create: vm0 schedule setup $VM0_AGENT_NAME",
    "- List: vm0 schedule list",
    "- Delete: vm0 schedule delete $VM0_AGENT_NAME --name <schedule-name>",
    "- Enable/Disable: vm0 schedule enable/disable $VM0_AGENT_NAME --name <schedule-name>",
    'Choose a short, descriptive schedule name based on the task (e.g., "deploy-check", "daily-report").',
  ].join("\n");
}

/**
 * Build system prompt guidance for Slack messaging via the vm0 proxy API.
 * Injected into Slack-triggered runs so agents know how to send messages.
 */
export function buildSlackMessagingGuidance(): string {
  return `# Sending Slack Messages
You can send Slack messages directly using the vm0 integration API:
curl -X POST "$VM0_API_URL/api/zero/integrations/slack/message" \\
  -H "Authorization: Bearer $VM0_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"channel": "<channel-id>", "text": "your message"}'
Optional fields: threadTs (reply in thread), blocks (Block Kit JSON).
Messages are sent as the bot user, not as an individual user.`;
}
