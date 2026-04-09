/**
 * The platform (integration) an agent run originates from.
 * Used to inject context so the agent knows which channel it is operating in.
 */
type IntegrationPlatform =
  | "Email"
  | "GitHub"
  | "Phone"
  | "Schedule"
  | "Slack"
  | "Telegram"
  | "Voice-Chat";

/**
 * Build the integration prompt header prepended to agent run prompts.
 */
export function buildIntegrationPrompt(
  platform: IntegrationPlatform,
  options?: {
    botUserId?: string;
    channelId?: string;
    channelType?: "channel" | "dm" | "group_dm";
    threadId?: string;
    scheduleDescription?: string;
    triggerType?: string;
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
  if (options?.threadId) {
    context += `\nThread ID: ${options.threadId}`;
  }
  if (options?.scheduleDescription) {
    context += `\nSchedule description: ${options.scheduleDescription}`;
  }
  if (options?.triggerType) {
    context += `\nTrigger type: ${options.triggerType}`;
  }
  return context;
}

export interface UserInfoOptions {
  name?: string;
  email?: string;
  timezone?: string;
  slackDisplayName?: string;
  slackUserId?: string;
}

/**
 * Build the user info section for agent system prompts.
 */
export function buildUserInfo(options: UserInfoOptions): string {
  const lines: string[] = [];
  if (options.name) {
    lines.push(`Name: ${options.name}`);
  }
  if (options.email) {
    lines.push(`Email: ${options.email}`);
  }
  if (options.timezone) {
    lines.push(`Timezone: ${options.timezone}`);
  }
  if (options.slackDisplayName) {
    lines.push(`Slack display name: ${options.slackDisplayName}`);
  }
  if (options.slackUserId) {
    lines.push(`Slack user ID: ${options.slackUserId}`);
  }
  return `# Current User Info\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Per-integration prompt builders
// ---------------------------------------------------------------------------

const VOICE_CHAT_WORKER_PROMPT = `
# Zero — Slow-Thinking Mode

You are Zero's slow-thinking mode. You and your fast-thinking self (the voice interface) are the same agent — Zero. Your fast self is having a real-time voice conversation with the user right now. You can see the entire conversation through the shared context.

## Observing the Conversation

Continuously read the shared context to follow the conversation:

\`zero voice-chat context get <SESSION_ID> --after <LAST_SEQ>\`

You will see events like:
- **user/speech** — what the user says
- **talker/response** — what your fast self says back
- **system/session-start** and **system/session-end** — session lifecycle

Based on what you observe, proactively decide what to do. Do not wait to be asked.

## When to Act

Act when the conversation involves:
- Code, data, APIs, files, or external systems
- Tasks that require execution, search, or tool use
- Topics where you can proactively gather information (e.g., user mentions a PR — look it up so the answer is ready)
- Anything your fast self cannot handle with conversation alone

Stay quiet when the conversation is:
- Casual chat, greetings, or small talk
- Opinions or preferences
- Simple knowledge questions your fast self handles well

## Writing to Shared Context

When you have something for the user, write to the shared context:

\`zero voice-chat context append <SESSION_ID> --source slow-brain --type <TYPE> --content "<CONTENT>"\`

### Event Types

- **directive**: High-level instructions for your fast self. Include what to tell the user, relevant data, and why. Do not script exact words — your fast self controls phrasing.
  Example: "The user asked about PR status. PR #8644 merged to main, all CI checks passed. Release PR #8647 is in merge queue position 2. Let the user know and ask if they want to wait for deployment."

- **thinking-progress**: When you start working on something, write a progress event so your fast self can tell the user you are thinking.
  Example: "Looking up the CI status for the latest PR."

- **thinking-result**: Raw results of your work — data, findings, command output — for your fast self to reference.

- **observation**: Proactive insights the user did not ask for but might find valuable.
  Example: "While checking the PR, I noticed the test coverage dropped by 3%. Might be worth mentioning."

## Polling and Lifecycle

1. Check for new events every 5 seconds.
2. Process what you see — act proactively or respond to explicit requests.
3. Write appropriate events (directive, thinking-progress, thinking-result, observation).
4. Repeat until you see a \`session-end\` system event, then exit.

## Important

- Keep directive content concise but complete — your fast self will read it aloud.
- You have full tool access. Use your sandbox, CLI, and APIs to get real answers.
- When you find something, write the directive immediately. Do not wait for a request.
- You are Zero. Think of the conversation as your own — you are just thinking more deeply about it.
`.trim();

/**
 * Build the full appendSystemPrompt for Voice-Chat worker mode.
 * Combines the integration header with the slow-thinking worker prompt.
 */
export function buildVoiceChatWorkerPrompt(sessionId: string): string {
  const header = buildIntegrationPrompt("Voice-Chat");
  const workerPrompt = VOICE_CHAT_WORKER_PROMPT.replaceAll(
    "<SESSION_ID>",
    sessionId,
  );
  return [header, workerPrompt].join("\n\n");
}

/**
 * Build the full appendSystemPrompt for Slack integration.
 */
export function buildSlackPrompt(
  opts: {
    botUserId: string;
    channelId?: string;
    channelType?: "channel" | "dm" | "group_dm";
    threadId?: string;
  },
  threadContext: string,
): string {
  const header = buildIntegrationPrompt("Slack", opts);
  return [header, threadContext].filter(Boolean).join("\n\n");
}

/**
 * Build the full appendSystemPrompt for Phone integration.
 */
export function buildPhonePrompt(phoneContext: string): string {
  const header = buildIntegrationPrompt("Phone", { channelType: "dm" });
  return [header, phoneContext].filter(Boolean).join("\n\n");
}

/**
 * Build the full appendSystemPrompt for Telegram integration.
 */
export function buildTelegramPrompt(threadContext: string): string {
  const header = buildIntegrationPrompt("Telegram");
  return [header, threadContext].filter(Boolean).join("\n\n");
}

/**
 * Build the full appendSystemPrompt for GitHub integration.
 */
export function buildGitHubPrompt(issueContext: string): string {
  const header = buildIntegrationPrompt("GitHub");
  return [header, issueContext].filter(Boolean).join("\n\n");
}
