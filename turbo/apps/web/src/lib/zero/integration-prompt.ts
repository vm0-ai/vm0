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
