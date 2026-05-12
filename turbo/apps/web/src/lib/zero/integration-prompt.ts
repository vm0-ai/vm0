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
  if (options.telegramDisplayName) {
    lines.push(`Telegram display name: ${options.telegramDisplayName}`);
  }
  if (options.telegramUsername) {
    lines.push(`Telegram username: ${options.telegramUsername}`);
  }
  if (options.telegramUserId) {
    lines.push(`Telegram user ID: ${options.telegramUserId}`);
  }
  if (options.telegramLanguage) {
    lines.push(`Telegram language: ${options.telegramLanguage}`);
  }
  if (options.agentphoneHandle) {
    lines.push(`Text message handle: ${options.agentphoneHandle}`);
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

  headerParts.push(
    [
      "",
      "# AgentPhone Tools",
      "When an AgentPhone message includes an [AgentPhone file] block, download it with `zero phone download-file <ID> -o <path>` before inspecting the contents.",
      "To send an extra text message outside the final run reply, use `zero phone message --to <phone> --text <message>`.",
      "To send a local file, use `zero phone upload-file --to <phone> -f <path>` and include `--caption` when useful.",
    ].join("\n"),
  );

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

/**
 * Sentinel literal the agent emits to signal goal completion. Detected by
 * scanning the last assistant message's content for an exact substring match.
 */
export const GOAL_DONE_SENTINEL = "[GOAL_DONE]";

export interface WebChatGoalContext {
  /** Inclusive of the current turn — when `1`, this is the last turn. */
  remainingTurns: number;
}

/**
 * Append-only "rules of the game" block injected into the system prompt only
 * when the run is goal-driven. The objective itself lives verbatim in the
 * triggering user message body and repeats each turn — the rules tell the
 * agent that repetition is the "continue" signal, not a redundant request.
 */
export function buildWebChatGoalPrompt(ctx: WebChatGoalContext): string {
  const turnLabel = ctx.remainingTurns === 1 ? "turn" : "turns";
  return [
    "# Goal Mode",
    "",
    "You are operating in goal mode. The user message that triggered this run",
    "may be a continuation of an earlier `/go` objective — the same message body",
    "will repeat verbatim each turn until the goal is satisfied. Treat each",
    "repetition as the signal to continue working on the objective, not as a",
    "fresh request to start over.",
    "",
    `You have ${String(ctx.remainingTurns)} ${turnLabel} remaining (this one included).`,
    "",
    `When you believe the goal is satisfied, include the literal text \`${GOAL_DONE_SENTINEL}\``,
    "somewhere in your final assistant message. The runtime detects this",
    "sentinel and stops the goal chain. Only emit it after verifying concrete",
    "deliverables — do not declare completion prematurely.",
  ].join("\n");
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

export interface WebChatPriorMessage {
  role: "user" | "assistant";
  content: string;
  attachFiles: string[] | null;
}

const WEB_CHAT_PRIOR_MESSAGE_CHAR_CAP = 4000;
const WEB_CHAT_PRIOR_PREAMBLE = [
  "The messages below are completed rounds earlier in this chat thread. The",
  "CLI session history has been reset for this run (the user switched models",
  "mid-thread, so the previous session is not safe to resume), so the prior",
  "conversation is shown here verbatim. RELATIVE_INDEX 0 is the most recent.",
  "Treat them as part of the conversation you are continuing.",
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
 * Build a transcript block describing successfully completed rounds earlier
 * in the thread. Used when the web chat send forces a new CLI session (the
 * user switched models mid-thread), so the agent still sees the prior
 * conversation that would otherwise have lived only in the discarded CLI
 * session history.
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
    "# Prior Chat Thread Context",
    "",
    WEB_CHAT_PRIOR_PREAMBLE,
    "",
    blocks.join("\n\n"),
    "",
    "---",
  ].join("\n");
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
