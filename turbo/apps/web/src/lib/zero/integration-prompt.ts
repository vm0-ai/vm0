/**
 * The platform (integration) an agent run originates from.
 * Used to inject context so the agent knows which channel it is operating in.
 */
type IntegrationPlatform =
  | "Email"
  | "GitHub"
  | "AgentPhone"
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
  telegramDisplayName?: string;
  telegramUsername?: string;
  telegramUserId?: string;
  telegramLanguage?: string;
  agentphoneHandle?: string;
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
 * Build the full appendSystemPrompt for Telegram integration.
 */
export function buildTelegramPrompt(
  opts: {
    botId?: string;
    botUsername?: string | null;
    chatId?: string;
    chatType?: string;
    messageId?: string;
    rootMessageId?: string | null;
    messageThreadId?: string | number | null;
  },
  threadContext: string,
): string {
  const headerParts = [buildIntegrationPrompt("Telegram")];
  if (opts.botId) {
    headerParts.push(`Bot ID: ${opts.botId}`);
  }
  if (opts.botUsername) {
    headerParts.push(`Bot username: @${opts.botUsername}`);
  }
  if (opts.chatId) {
    headerParts.push(`Chat ID: ${opts.chatId}`);
  }
  if (opts.chatType) {
    headerParts.push(`Chat type: ${opts.chatType}`);
  }
  if (opts.messageId) {
    headerParts.push(`Message ID: ${opts.messageId}`);
  }
  if (opts.rootMessageId) {
    headerParts.push(`Root message ID: ${opts.rootMessageId}`);
  }
  if (opts.messageThreadId) {
    headerParts.push(`Message thread ID: ${opts.messageThreadId}`);
  }

  const header = headerParts.join("\n");
  return [header, threadContext].filter(Boolean).join("\n\n");
}

/**
 * Build the full appendSystemPrompt for AgentPhone integration.
 */
export function buildAgentPhonePrompt(
  opts: {
    sharedNumber: string;
    phoneHandle: string;
    conversationId?: string | null;
    channel?: string | null;
    messageId?: string;
    agentphoneAgentId?: string;
  },
  threadContext: string,
): string {
  const headerParts = [buildIntegrationPrompt("AgentPhone")];
  headerParts.push(`Shared AgentPhone number: ${opts.sharedNumber}`);
  headerParts.push(`User phone handle: ${opts.phoneHandle}`);
  if (opts.agentphoneAgentId) {
    headerParts.push(`AgentPhone Agent ID: ${opts.agentphoneAgentId}`);
  }
  if (opts.channel) {
    headerParts.push(`Channel: ${opts.channel}`);
  }
  if (opts.conversationId) {
    headerParts.push(`Conversation ID: ${opts.conversationId}`);
  }
  if (opts.messageId) {
    headerParts.push(`Message ID: ${opts.messageId}`);
  }

  const header = headerParts.join("\n");
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
 */
export function buildWebChatPrompt(): string {
  const header = buildIntegrationPrompt("Web");
  const description =
    "You are communicating with the user through the web chat UI.";
  return [header, description].join("\n\n");
}

interface WebChatPriorMessage {
  role: "user" | "assistant";
  content: string;
  attachFiles: string[] | null;
}

const WEB_CHAT_PRIOR_MESSAGE_CHAR_CAP = 4000;
const WEB_CHAT_CONTEXT_PREAMBLE = [
  "The messages below are from a web chat conversation. When responding:",
  "- Messages closer to RELATIVE_INDEX 0 are more recent — prioritize them.",
  "- Match the tone of the conversation — casual messages deserve casual replies.",
  "- Only provide technical analysis when explicitly asked a technical question.",
  "- Keep responses proportional to the message length and complexity.",
].join("\n");

function truncateForPriorContext(value: string): string {
  if (value.length <= WEB_CHAT_PRIOR_MESSAGE_CHAR_CAP) return value;
  return `${value.slice(0, WEB_CHAT_PRIOR_MESSAGE_CHAR_CAP)}…[truncated]`;
}

function formatPriorAttachFiles(ids: string[] | null | undefined): string {
  if (!ids || ids.length === 0) return "";
  return ids
    .map((id) => {
      return `[Web file]\n   [ID] ${id}`;
    })
    .join("\n");
}

/**
 * Build a transcript block describing the most recent messages earlier in the
 * thread. Web runs normally continue the same CLI session, but this gives the
 * agent the same short, explicit channel context that Slack and Telegram get.
 *
 * Empty input returns `""` so the caller can `filter(Boolean).join()`.
 */
export function buildWebChatPriorMessagesContext(
  msgs: WebChatPriorMessage[],
): string {
  if (msgs.length === 0) return "";

  const total = msgs.length;
  const blocks = msgs.map((m, idx) => {
    const relativeIndex = idx - total + 1;
    const attach = formatPriorAttachFiles(m.attachFiles);
    const body = truncateForPriorContext(m.content);
    const roleLabel = m.role === "user" ? "User" : "Assistant";
    const lines = [
      "---",
      "",
      `- RELATIVE_INDEX: ${relativeIndex}`,
      `- ROLE: ${m.role}`,
      "",
      `${roleLabel}: ${body || "[empty message]"}`,
    ];
    if (attach) lines.push(attach);
    return lines.join("\n");
  });

  return [
    "# Web Chat Context",
    "",
    WEB_CHAT_CONTEXT_PREAMBLE,
    "",
    blocks.join("\n\n"),
    "",
    "---",
  ].join("\n");
}
