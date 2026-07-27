import type { FeishuOutboundMessage } from "../signals/external/feishu-client";

const MARKDOWN_ELEMENT_MAX_LENGTH = 12_000;

type FeishuCardTemplate = "blue" | "green" | "orange" | "red";

function markdownElements(
  content: string,
): Readonly<Record<string, unknown>>[] {
  const suffix = "\n\n_(Message too long to view in Feishu.)_";
  const truncated =
    content.length > MARKDOWN_ELEMENT_MAX_LENGTH
      ? content.slice(0, MARKDOWN_ELEMENT_MAX_LENGTH - suffix.length) + suffix
      : content;
  return [{ tag: "markdown", content: truncated || "\u200b" }];
}

function cardMessage(args: {
  readonly title: string;
  readonly template: FeishuCardTemplate;
  readonly summary: string;
  readonly elements: readonly Readonly<Record<string, unknown>>[];
}): FeishuOutboundMessage {
  return {
    msgType: "interactive",
    content: {
      schema: "2.0",
      config: {
        update_multi: true,
        width_mode: "default",
        summary: { content: args.summary },
      },
      header: {
        title: { tag: "plain_text", content: args.title },
        template: args.template,
      },
      body: {
        direction: "vertical",
        padding: "12px 12px 20px 12px",
        vertical_spacing: "medium",
        elements: args.elements,
      },
    },
  };
}

export function buildFeishuLoginMessage(
  connectUrl: string,
): FeishuOutboundMessage {
  return cardMessage({
    title: "Connect your account",
    template: "blue",
    summary: "Connect your account to use Zero in Feishu.",
    elements: [
      {
        tag: "markdown",
        content: "To use Zero in Feishu, please connect your account first.",
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: "Connect" },
        type: "primary_filled",
        width: "fill",
        behaviors: [{ type: "open_url", default_url: connectUrl }],
      },
    ],
  });
}

export function buildFeishuWelcomeMessage(args: {
  readonly agentName: string | null;
}): FeishuOutboundMessage {
  const agentLine = args.agentName
    ? `\n\nYour current agent is **${args.agentName}**.`
    : "";
  return cardMessage({
    title: "You're connected! 🎉",
    template: "green",
    summary: "Your Feishu account is connected to VM0.",
    elements: [
      {
        tag: "markdown",
        content: `👋 **Hi! I'm Zero.**\n\nI connect Feishu conversations to AI agents to help with your tasks.${agentLine}`,
      },
      {
        tag: "hr",
      },
      {
        tag: "markdown",
        content:
          "Send me a direct message or mention me in a group chat to get started.\n\nCommands: `/help`, `/connect`, `/disconnect`, `/switch`, `/model`.",
      },
    ],
  });
}

export function buildFeishuHelpMessage(): FeishuOutboundMessage {
  return {
    msgType: "text",
    content: {
      text: [
        "Zero commands",
        "",
        "/help — Show this help",
        "/connect — Connect your VM0 account",
        "/disconnect — Disconnect your VM0 account",
        "/switch — Choose which agent responds",
        "/model — Choose your model",
        "",
        "Send a task in a direct message, or mention the bot with a task in a group chat.",
      ].join("\n"),
    },
  };
}

export function buildFeishuNoticeMessage(args: {
  readonly title: string;
  readonly text: string;
  readonly kind?: "error" | "info" | "success" | "warning";
}): FeishuOutboundMessage {
  const templateByKind = {
    error: "red",
    info: "blue",
    success: "green",
    warning: "orange",
  } as const;
  return cardMessage({
    title: args.title,
    template: templateByKind[args.kind ?? "info"],
    summary: args.text,
    elements: markdownElements(args.text),
  });
}

export function buildFeishuAgentResponseMessage(args: {
  readonly text: string;
  readonly auditUrl?: string;
  readonly footerText?: string;
}): FeishuOutboundMessage {
  const footerElements: Readonly<Record<string, unknown>>[] =
    args.auditUrl || args.footerText
      ? [
          { tag: "hr" },
          {
            tag: "markdown",
            content: [
              args.auditUrl ? `[Audit](${args.auditUrl})` : undefined,
              args.footerText ? `*${args.footerText}*` : undefined,
            ]
              .filter((part): part is string => {
                return Boolean(part);
              })
              .join(" · "),
            text_size: "notation",
          },
        ]
      : [];
  return cardMessage({
    title: "Zero",
    template: "blue",
    summary: args.text.slice(0, 200),
    elements: [...markdownElements(args.text), ...footerElements],
  });
}
