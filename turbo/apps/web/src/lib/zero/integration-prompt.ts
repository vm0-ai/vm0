/**
 * The platform (integration) an agent run originates from.
 * Used to inject context so the agent knows which channel it is operating in.
 */
type IntegrationPlatform =
  | "Email"
  | "GitHub"
  | "iMessage"
  | "Phone"
  | "Schedule"
  | "Slack"
  | "Telegram"
  | "Voice-Chat"
  | "Web";

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

// Shared observation instructions used by the voice-chat quick-prep prompt.
const SHARED_OBSERVATION_PROMPT = `
## Phase 2: Live Observation

Once you have written the preparation-ready event, the voice conversation will begin. Transition to observation mode:

### Observing the Conversation

Continuously read the shared context to follow the conversation:

\`zero voice-chat context get <SESSION_ID> --after <LAST_SEQ>\`

You will see events like:
- **user/speech** — what the user says
- **fast-brain/response** — what your fast-brain says back
- **fast-brain/request-slow-brain** — an explicit ask from fast-brain (see Explicit Requests)
- **system/session-start** and **system/session-end** — session lifecycle
- **system/task-dispatched** and **system/task-completed** — tasks you dispatched (see Dispatching Tasks)

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

### Dispatching Tasks

Some work is too heavy to do inline: code changes, file operations, external API calls (GitHub, Slack, Linear), database queries, multi-step research. For these, dispatch a task to a fresh sandbox so your polling loop stays responsive.

Dispatch a task:

\`zero voice-chat task create <SESSION_ID> --prompt "<self-sufficient task prompt>"\`

The command returns a JSON object with \`id\` and \`status\` immediately. **Write down the id and return to the poll loop.** Never block, wait, or sleep for the task to finish.

The task prompt must be self-sufficient. The Tasker runs in a fresh sandbox with no conversation history — include repo paths, user intent, and any data it needs. Write the prompt as if briefing a smart colleague who just walked in.

Fetch a result once completed:

\`zero voice-chat task get <SESSION_ID> <TASK_ID>\` → JSON with \`status\`, \`result\`, \`error\`.

List your tasks:

\`zero voice-chat task list <SESSION_ID>\` → array of \`{ id, status, createdAt }\`.

#### When to dispatch vs. handle inline

- **Dispatch** when the work requires tool use you don't already have the answer to: reading files, running commands, calling APIs, querying DBs, doing long research.
- **Handle inline** (directive only) when you can answer from the prompt, context, or memory: knowledge answers, opinions, summarizing the conversation so far, simple context lookups.
- **Stay quiet** for casual chat, greetings, and small talk — same as before.

Spinning a Tasker has cold-start cost. Don't use it for "what's 2+2".

#### Every directive carries task context in natural language

Fast-brain knows nothing about tasks, ids, or the Tasker subsystem. Your directives are the only channel it learns from. Never mention "task", "taskId", or ids in directive content — fast-brain reads directives aloud.

- **On dispatch**, write a directive telling fast-brain to acknowledge work is happening.
  - OK: "I'm checking the PR — tell the user you're looking into it."
  - NOT OK: "Dispatched task T1 to check PR status."
- **On completion**, write a directive describing what to say.
  - OK: "The PR was merged yesterday by Alice — tell the user naturally."
  - NOT OK: "Task abc-123 returned: PR merged by Alice on 2026-04-20."
- **On failure**, write a directive describing the failure plainly and recovering.
  - OK: "Couldn't reach GitHub right now — tell the user there's a hiccup and we'll try again in a moment."
  - NOT OK: "Task failed with error: GITHUB_API_TIMEOUT."

Without the on-dispatch directive, fast-brain has nothing to say while the task runs and the user hears dead air. Always emit that first directive before returning to the poll loop.

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

**Do NOT dispatch tasks during preparation.** The Tasker is only for Phase 2 (Live Observation). During Phase 1 you review existing context and emit a \`preparation-ready\` event — no tool use, no task creation.

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
 * Build the full appendSystemPrompt for iMessage integration.
 */
export function buildIMessagePrompt(fromNumber: string): string {
  const header = buildIntegrationPrompt("iMessage", { channelType: "dm" });
  const context = `The user is communicating via iMessage. Their phone number is ${fromNumber}. Keep responses concise — they will be delivered as text messages.`;
  return [header, context].join("\n\n");
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

/**
 * Build the full appendSystemPrompt for Schedule integration.
 */
export function buildSchedulePrompt(opts: { triggerType: string }): string {
  return buildIntegrationPrompt("Schedule", {
    triggerType: opts.triggerType,
  });
}

/**
 * Build the full appendSystemPrompt for Web Chat integration.
 *
 * The user is interacting through the web chat UI, so the final result of the
 * run will be rendered directly to them. Keep this in mind when producing
 * output — there is no separate delivery step.
 */
export function buildWebChatPrompt(): string {
  const header = buildIntegrationPrompt("Web");
  const description =
    "You are communicating with the user through the web chat UI. The final result you return will be displayed to the user directly in the chat.";
  return [header, description].join("\n\n");
}

/**
 * Build file-attachment blocks for files the user attached to their web message.
 * Only describes each attachment (name, type, id).
 * The agent learns how to download and read files from `zero web download-file -h`.
 */
export function buildWebAttachFilesPrompt(
  files: Array<{ id: string; filename: string; contentType: string }>,
): string {
  const blocks = files.map((f) => {
    return `[Web file] ${f.filename} (${f.contentType})\n   [ID] ${f.id}`;
  });

  return blocks.join("\n");
}

export interface WebChatIncompleteRoundMessage {
  role: "user" | "assistant";
  content: string | null;
  error: string | null;
  attachFiles: string[] | null;
}

export interface WebChatIncompleteRound {
  runId: string;
  status: "cancelled" | "failed" | "timeout";
  messages: WebChatIncompleteRoundMessage[];
}

const WEB_CHAT_INCOMPLETE_MESSAGE_CHAR_CAP = 4000;
const WEB_CHAT_INCOMPLETE_PREAMBLE = [
  "The rounds below were sent in this thread but their runs did not complete",
  "(cancelled, failed, or timed out), so the CLI session history does not",
  "contain them. Treat them as part of the conversation you are having with",
  "the user. RELATIVE_INDEX 0 is the most recent incomplete round.",
].join("\n");

function truncateForIncompleteContext(value: string): string {
  if (value.length <= WEB_CHAT_INCOMPLETE_MESSAGE_CHAR_CAP) return value;
  return `${value.slice(0, WEB_CHAT_INCOMPLETE_MESSAGE_CHAR_CAP)}…[truncated]`;
}

function formatIncompleteAttachFiles(ids: string[] | null | undefined): string {
  if (!ids || ids.length === 0) return "";
  return ids
    .map((id) => {
      return `[Web file]\n   [ID] ${id}`;
    })
    .join("\n");
}

function formatIncompleteMessage(msg: WebChatIncompleteRoundMessage): string {
  const attach = formatIncompleteAttachFiles(msg.attachFiles);
  if (msg.role === "user") {
    const body =
      msg.content !== null && msg.content !== ""
        ? truncateForIncompleteContext(msg.content)
        : "[empty message]";
    return attach ? `User: ${body}\n${attach}` : `User: ${body}`;
  }
  if (msg.content !== null && msg.content !== "") {
    return `Assistant (partial): ${truncateForIncompleteContext(msg.content)}`;
  }
  return "Assistant: [no response before run ended]";
}

/**
 * Build a transcript block describing previous rounds whose runs did not
 * complete (cancelled / failed / timed out). Appended to the web chat system
 * prompt so the next run sees the messages the user still has on screen, even
 * though they are absent from the CLI session history.
 *
 * Empty input returns `""` so the caller can simply `filter(Boolean).join()`.
 */
export function buildWebChatIncompleteContext(
  rounds: WebChatIncompleteRound[],
): string {
  if (rounds.length === 0) return "";

  const total = rounds.length;
  const blocks = rounds.map((round, index) => {
    const relativeIndex = index - total + 1;
    const hasAssistant = round.messages.some((m) => {
      return m.role === "assistant";
    });
    const rendered = round.messages.map(formatIncompleteMessage);
    if (!hasAssistant) {
      rendered.push("Assistant: [no response before run ended]");
    }
    const lines = [
      "---",
      "",
      `- RELATIVE_INDEX: ${relativeIndex}`,
      `- RUN_STATUS: ${round.status}`,
      "",
      ...rendered,
    ];
    return lines.join("\n");
  });

  return [
    "# Incomplete Rounds Context",
    "",
    WEB_CHAT_INCOMPLETE_PREAMBLE,
    "",
    blocks.join("\n\n"),
    "",
    "---",
  ].join("\n");
}
