import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { publicBrandPresentation } from "@okouai/core/public-brand";

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

export function buildFeishuLoginMessage(args: {
  readonly connectUrl: string;
  readonly publicBrand: PublicBrand;
}): FeishuOutboundMessage {
  const { assistantName } = publicBrandPresentation(args.publicBrand);
  return cardMessage({
    title: "Connect your account",
    template: "blue",
    summary: `Connect your account to use ${assistantName} in Feishu.`,
    elements: [
      {
        tag: "markdown",
        content: `To use ${assistantName} in Feishu, please connect your account first.`,
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: "Connect" },
        type: "primary_filled",
        width: "fill",
        behaviors: [{ type: "open_url", default_url: args.connectUrl }],
      },
    ],
  });
}

export function buildFeishuWelcomeMessage(args: {
  readonly agentName: string | null;
  readonly botName: string | null;
  readonly publicBrand: PublicBrand;
}): FeishuOutboundMessage {
  const { brandName } = publicBrandPresentation(args.publicBrand);
  // Provider bot metadata is legitimately unavailable until Feishu discovery
  // succeeds. This neutral presentation fallback carries neither provider nor
  // product identity and remains while botName is nullable (#27750).
  const botName = args.botName ?? "your Feishu bot";
  const agentLine = args.agentName
    ? `\n\nYour current agent is **${args.agentName}**.`
    : "";
  return cardMessage({
    title: "You're connected! 🎉",
    template: "green",
    summary: `Your Feishu account is connected to ${brandName}.`,
    elements: [
      {
        tag: "markdown",
        content: `👋 **Hi! I'm ${botName}.**\n\nI connect Feishu conversations to AI agents to help with your tasks.${agentLine}`,
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

export function buildFeishuHelpMessage(args: {
  readonly publicBrand: PublicBrand;
  readonly botName: string | null;
}): FeishuOutboundMessage {
  const { brandName } = publicBrandPresentation(args.publicBrand);
  // Keep this provider-neutral while Feishu bot metadata is legitimately
  // nullable; it must never synthesize a VM0/Okou provider identity (#27750).
  const botName = args.botName ?? "Feishu bot";
  return {
    msgType: "text",
    content: {
      text: [
        `${botName} commands`,
        "",
        "/help — Show this help",
        `/connect — Connect your ${brandName} account`,
        `/disconnect — Disconnect your ${brandName} account`,
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
  readonly publicBrand: PublicBrand;
  readonly auditUrl?: string;
  readonly footerText?: string;
}): FeishuOutboundMessage {
  const { assistantName } = publicBrandPresentation(args.publicBrand);
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
    title: assistantName,
    template: "blue",
    summary: args.text.slice(0, 200),
    elements: [...markdownElements(args.text), ...footerElements],
  });
}
