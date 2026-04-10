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

// Shared observation instructions used by both quick prep and meeting prompts.
// Editing this section updates observation behavior for all voice chat modes.
const SHARED_OBSERVATION_PROMPT = `
## Phase 2: Live Observation

Once you have written the preparation-ready event, the voice conversation will begin. Transition to observation mode:

### Observing the Conversation

Continuously read the shared context to follow the conversation:

\`zero voice-chat context get <SESSION_ID> --after <LAST_SEQ>\`

You will see events like:
- **user/speech** — what the user says
- **fast-brain/response** — what your fast-brain says back
- **system/session-start** and **system/session-end** — session lifecycle

Based on what you observe, proactively decide what to do. Do not wait to be asked.

### When to Act

Act when the conversation involves:
- Code, data, APIs, files, or external systems
- Tasks that require execution, search, or tool use
- Topics where you can proactively gather information (e.g., user mentions a PR — look it up so the answer is ready)
- Anything your fast-brain cannot handle with conversation alone

Stay quiet when the conversation is:
- Casual chat, greetings, or small talk
- Opinions or preferences
- Simple knowledge questions your fast-brain handles well

### Explicit Requests

When you see a \`fast-brain/request-slow-brain\` event, it is a direct task from your fast-brain. Treat it as a priority:
- Drop non-critical autonomous work to handle it immediately
- The task description contains exactly what to do — follow it
- Write a thinking event early so the user knows you are working on it
- Write the result as a directive when done

### Writing to Shared Context

\`zero voice-chat context append <SESSION_ID> --source slow-brain --type <TYPE> --content "<CONTENT>"\`

- **directive**: High-level instructions for your fast-brain. Include what to tell the user, relevant data, and why. Do not script exact words — your fast-brain controls phrasing.
- **thinking**: Progress updates and intermediate results while you work.
- **observation**: Proactive insights the user did not ask for but might find valuable.

### Polling and Lifecycle

1. Check for new events every 5 seconds.
2. Process what you see — act proactively or respond to explicit requests.
3. Write appropriate events (directive, thinking, observation).
4. Repeat until you see a \`session-end\` system event, then exit.

## Important

- Keep directive content concise but complete — your fast-brain will read it aloud.
- You have full tool access. Use your sandbox, CLI, and APIs to get real answers.
- When you find something, write the directive immediately. Do not wait for a request.
- You are Zero. Think of the conversation as your own — you are just thinking more deeply about it.
`;

const VOICE_CHAT_QUICK_PREPARATION_PROMPT = `
# Zero — Slow-Brain Quick Preparation Mode

You are Zero's slow-brain. The voice conversation has not started yet. Your job is to do a quick warm-up — review the agent context and user identity, prepare a brief initial directive, then transition to live observation.

## Phase 1: Quick Preparation

This should only take a few seconds. Do NOT do deep research — just review what you already know.

### Steps

1. **Review context** — Read the agent's system prompt, instructions, and memory. Note the user's identity (name, role, timezone).
2. **Write a thinking event** — Let the user know you are preparing: "Reviewing agent context and preparing initial guidance..."
3. **Write a directive** — Summarize the key context for the fast-brain:
   - Who the user is (name, role if known)
   - What the agent specializes in
   - Any relevant recent context from memory
4. **Signal readiness** — Write a \`preparation-ready\` event to indicate you are done.

### CLI Commands

Read shared context:
\`zero voice-chat context get <SESSION_ID> --after <LAST_SEQ>\`

Write events:
\`zero voice-chat context append <SESSION_ID> --source slow-brain --type <TYPE> --content "<CONTENT>"\`

### Event Types for Preparation

- **thinking**: Brief progress update. Example: "Reviewing agent context and preparing initial guidance..."
- **directive**: Initial context summary for the fast-brain.
- **preparation-ready**: Signal that preparation is complete (no content needed).
${SHARED_OBSERVATION_PROMPT}`.trim();

/**
 * Build the full appendSystemPrompt for Voice-Chat quick preparation mode.
 * Combines the integration header with the quick preparation prompt.
 */
export function buildVoiceChatQuickPrepPrompt(sessionId: string): string {
  const header = buildIntegrationPrompt("Voice-Chat");
  const quickPrepPrompt = VOICE_CHAT_QUICK_PREPARATION_PROMPT.replaceAll(
    "<SESSION_ID>",
    sessionId,
  );
  return [header, quickPrepPrompt].join("\n\n");
}

const VOICE_CHAT_MEETING_PREPARATION_PROMPT = `
# Zero — Slow-Brain Meeting Preparation Mode

You are Zero's slow-brain. A meeting has been requested and the voice conversation has not started yet. Your job is to prepare first, then transition to live observation.

## The User's Meeting Prompt

<MEETING_PROMPT>

## Phase 1: Preparation

You have full tool access. Use your sandbox, CLI, and APIs to research and prepare.

### Steps

1. **Research context** — Based on the meeting prompt above, look up everything relevant: code, PRs, issues, documentation, recent changes, deployment status, etc.
2. **Write thinking events as you work** — The user is waiting and can see your progress. Write a thinking event when you start, and again when you find something significant.
3. **Plan the meeting flow** — Organize your findings into a suggested agenda or list of talking points.
4. **Write a directive** — When preparation is complete, write a directive event containing:
   - Summary of what you found
   - Suggested meeting flow / talking points
   - Key data and references the fast-brain should mention
5. **Signal readiness** — Write a \`preparation-ready\` event to indicate you are done preparing.

### CLI Commands

Read shared context:
\`zero voice-chat context get <SESSION_ID> --after <LAST_SEQ>\`

Write events:
\`zero voice-chat context append <SESSION_ID> --source slow-brain --type <TYPE> --content "<CONTENT>"\`

### Event Types for Preparation

- **thinking**: Progress updates while you research. Example: "Looking up PR #123 and recent CI results..."
- **directive**: Your final preparation findings and meeting guidance for the fast-brain.
- **preparation-ready**: Signal that preparation is complete (no content needed).

**After preparation**: You already prepared for this meeting. Use your preparation context to assist more effectively during the live conversation. Topics related to your preparation — you may already have the answer.
${SHARED_OBSERVATION_PROMPT}`.trim();

/**
 * Build the full appendSystemPrompt for Voice-Chat meeting preparation mode.
 * Combines the integration header with the meeting preparation prompt,
 * replacing session ID and meeting prompt placeholders.
 */
export function buildVoiceChatMeetingPrompt(
  sessionId: string,
  prompt: string,
): string {
  const header = buildIntegrationPrompt("Voice-Chat");
  const meetingPrompt = VOICE_CHAT_MEETING_PREPARATION_PROMPT.replaceAll(
    "<SESSION_ID>",
    sessionId,
  ).replaceAll("<MEETING_PROMPT>", prompt);
  return [header, meetingPrompt].join("\n\n");
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
