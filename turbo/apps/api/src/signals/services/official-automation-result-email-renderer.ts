import { convert } from "html-to-text";
import MarkdownIt from "markdown-it";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { publicBrandPresentation } from "@okouai/core/public-brand";

import { safeSync, safeUrlParse } from "../utils";

const OFFICIAL_AUTOMATION_RESULT_EMAIL_HTML_MAX_BYTES = 96 * 1024;
const OKOU_AUTOMATION_EMAIL_AVATAR_URL =
  "https://static.okou.io/public/okou-agent-email-avatar-5c997967b68e.png";

const SAFE_LINK_INFO = "official-email-safe-link";
const UNSAFE_LINK_INFO = "official-email-unsafe-link";
const LINK_STYLE =
  "color:#d94801;text-decoration:underline;text-underline-offset:2px";
const FOOTER_LINK_STYLE = "color:#6f7378;text-decoration:underline";
const BODY_WRAP_STYLE =
  "margin:0;max-width:100%;overflow-wrap:anywhere;word-break:break-word";
const PARAGRAPH_STYLE =
  "margin:0 0 14px;overflow-wrap:anywhere;word-break:break-word";
const LIST_STYLE =
  "margin:0 0 16px;padding-left:22px;overflow-wrap:anywhere;word-break:break-word";
const LIST_ITEM_STYLE =
  "margin:0 0 8px;padding-left:1px;overflow-wrap:anywhere;word-break:break-word";
const INLINE_CODE_STYLE =
  "padding:1px 4px;border-radius:4px;background-color:#f3f4f6;font-family:SFMono-Regular,Consolas,'Liberation Mono',monospace;font-size:0.92em;white-space:normal;overflow-wrap:anywhere;word-break:break-word";
const CODE_BLOCK_STYLE =
  "margin:0 0 16px;padding:12px 14px;border:1px solid #e4e6e8;border-radius:6px;background-color:#f7f7f8;font-family:SFMono-Regular,Consolas,'Liberation Mono',monospace;font-size:12px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word";
const TABLE_CELL_STYLE =
  "padding:8px 10px;border:1px solid #d9dde1;text-align:left;vertical-align:top;overflow-wrap:anywhere;word-break:break-word";

const HEADING_STYLES: Readonly<Record<string, string>> = {
  h1: "margin:0 0 25px;font-size:23px;line-height:1.3;letter-spacing:-0.025em",
  h2: "margin:24px 0 9px;font-size:16px;line-height:1.35;letter-spacing:-0.01em",
  h3: "margin:20px 0 8px;font-size:15px;line-height:1.4",
  h4: "margin:18px 0 8px;font-size:14px;line-height:1.4",
  h5: "margin:16px 0 8px;font-size:13px;line-height:1.45",
  h6: "margin:16px 0 8px;font-size:12px;line-height:1.45",
};

interface OfficialAutomationResultEmailRenderProps {
  readonly title: string;
  readonly resultText: string;
  readonly runUrl: string;
  readonly manageUrl: string;
}

interface OfficialAutomationResultEmailFallback {
  readonly reason: "render-error" | "size-limit";
  readonly attemptedHtmlBytes: number | null;
  readonly fallbackHtmlBytes: number;
}

interface RenderedOfficialAutomationResultEmail {
  readonly html: string;
  readonly text: string;
  readonly fallback: OfficialAutomationResultEmailFallback | null;
}

function escapeHtml(value: string): string {
  let escaped = "";
  for (const char of value) {
    switch (char) {
      case "&": {
        escaped += "&amp;";
        break;
      }
      case "<": {
        escaped += "&lt;";
        break;
      }
      case ">": {
        escaped += "&gt;";
        break;
      }
      case '"': {
        escaped += "&quot;";
        break;
      }
      default: {
        escaped += char;
      }
    }
  }
  return escaped;
}

function linkDestinationIsSafe(destination: string): boolean {
  const parsed = safeUrlParse(destination);
  if (!parsed) {
    return false;
  }

  if (parsed.protocol === "https:") {
    return (
      destination.slice(0, "https://".length).toLowerCase() === "https://" &&
      parsed.hostname.length > 0
    );
  }
  if (parsed.protocol === "mailto:") {
    const mailDestination = destination.slice("mailto:".length);
    return !mailDestination.startsWith("//") && parsed.pathname.length > 0;
  }
  return false;
}

function createMarkdownRenderer(): MarkdownIt {
  const markdown = new MarkdownIt({
    html: false,
    breaks: false,
    linkify: false,
    typographer: false,
  });

  // Link destinations have already been entity-decoded and normalized when
  // validateLink runs. Retain every parsed link token here so the renderer can
  // remove only an unsafe anchor while preserving its visible label.
  markdown.validateLink = () => {
    return true;
  };
  markdown.core.ruler.after("inline", "official_email_link_policy", (state) => {
    for (const blockToken of state.tokens) {
      if (blockToken.type !== "inline" || blockToken.children === null) {
        continue;
      }
      const safeLinkStack: boolean[] = [];
      for (const token of blockToken.children) {
        if (token.type === "link_open") {
          const safe = linkDestinationIsSafe(token.attrGet("href") ?? "");
          safeLinkStack.push(safe);
          token.info = safe ? SAFE_LINK_INFO : UNSAFE_LINK_INFO;
        } else if (token.type === "link_close") {
          token.info = safeLinkStack.pop() ? SAFE_LINK_INFO : UNSAFE_LINK_INFO;
        }
      }
    }
  });

  markdown.renderer.rules.heading_open = (tokens, index) => {
    const token = tokens[index]!;
    const style = HEADING_STYLES[token.tag] ?? HEADING_STYLES.h6;
    return `<${token.tag} style="${style}">`;
  };
  markdown.renderer.rules.paragraph_open = () => {
    return `<p style="${PARAGRAPH_STYLE}">`;
  };
  markdown.renderer.rules.bullet_list_open = () => {
    return `<ul style="${LIST_STYLE}">`;
  };
  markdown.renderer.rules.ordered_list_open = (tokens, index) => {
    const start = tokens[index]!.attrGet("start");
    const startAttribute = start ? ` start="${escapeHtml(start)}"` : "";
    return `<ol${startAttribute} style="${LIST_STYLE}">`;
  };
  markdown.renderer.rules.list_item_open = () => {
    return `<li style="${LIST_ITEM_STYLE}">`;
  };
  markdown.renderer.rules.strong_open = () => {
    return '<strong style="font-weight:700">';
  };
  markdown.renderer.rules.em_open = () => {
    return '<em style="font-style:italic">';
  };
  markdown.renderer.rules.s_open = () => {
    return '<s style="text-decoration:line-through">';
  };
  markdown.renderer.rules.blockquote_open = () => {
    return '<blockquote style="margin:0 0 16px;padding:2px 0 2px 14px;border-left:3px solid #d0d4d8;color:#4b5563;overflow-wrap:anywhere;word-break:break-word">';
  };
  markdown.renderer.rules.code_inline = (tokens, index) => {
    return `<code style="${INLINE_CODE_STYLE}">${escapeHtml(tokens[index]!.content)}</code>`;
  };
  const renderCodeBlock = (
    tokens: Parameters<NonNullable<typeof markdown.renderer.rules.fence>>[0],
    index: number,
  ): string => {
    return `<pre style="${CODE_BLOCK_STYLE}"><code>${escapeHtml(tokens[index]!.content)}</code></pre>\n`;
  };
  markdown.renderer.rules.fence = renderCodeBlock;
  markdown.renderer.rules.code_block = renderCodeBlock;
  markdown.renderer.rules.hr = () => {
    return '<hr style="height:1px;margin:20px 0;border:0;background-color:#e4e6e8">\n';
  };
  markdown.renderer.rules.table_open = () => {
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:100%;table-layout:fixed;border-collapse:collapse;margin:0 0 16px">';
  };
  markdown.renderer.rules.thead_open = () => {
    return '<thead style="background-color:#f3f4f6">';
  };
  markdown.renderer.rules.th_open = () => {
    return `<th style="${TABLE_CELL_STYLE};font-weight:700">`;
  };
  markdown.renderer.rules.td_open = () => {
    return `<td style="${TABLE_CELL_STYLE}">`;
  };
  markdown.renderer.rules.link_open = (tokens, index) => {
    const token = tokens[index]!;
    if (token.info !== SAFE_LINK_INFO) {
      return "";
    }
    return `<a href="${escapeHtml(token.attrGet("href") ?? "")}" style="${LINK_STYLE}">`;
  };
  markdown.renderer.rules.link_close = (tokens, index) => {
    return tokens[index]!.info === SAFE_LINK_INFO ? "</a>" : "";
  };
  markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
    const children = tokens[index]!.children ?? [];
    return escapeHtml(renderer.renderInlineAsText(children, options, env));
  };

  return markdown;
}

const markdownRenderer = createMarkdownRenderer();

function officialAutomationResultEmailHtml(
  props: OfficialAutomationResultEmailRenderProps,
  publicBrand: PublicBrand,
  resultBodyHtml: string,
  unsubscribeUrl: string,
): string {
  const presentation = publicBrandPresentation(publicBrand);
  const assistantIdentity =
    publicBrand === "okou"
      ? `<td width="36" height="36" align="center" valign="middle" style="width:36px;height:36px;line-height:0;mso-line-height-rule:exactly"><img src="${OKOU_AUTOMATION_EMAIL_AVATAR_URL}" width="36" height="36" alt="" role="presentation" style="display:block;width:36px;height:36px;border:0;border-radius:50%;outline:none;text-decoration:none"></td>`
      : '<td width="32" height="32" align="center" valign="middle" bgcolor="#ed4e01" style="width:32px;height:32px;border-radius:9px;color:#ffffff;font-size:14px;font-weight:700;line-height:32px;mso-line-height-rule:exactly">0</td>';
  const automationArticle = publicBrand === "okou" ? "an" : "a";
  const footer = `Sent by ${automationArticle} ${escapeHtml(
    presentation.assistantName,
  )} automation &middot; <a href="${escapeHtml(
    props.manageUrl,
  )}" style="${FOOTER_LINK_STYLE}">Manage</a> &middot; <a href="${escapeHtml(
    unsubscribeUrl,
  )}" style="${FOOTER_LINK_STYLE}">Unsubscribe</a>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escapeHtml(
    props.title,
  )}</title></head><body style="margin:0;padding:0;background-color:#f7f7f5;color:#202124;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.58;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f7f7f5" style="width:100%;border-collapse:collapse;background-color:#f7f7f5"><tr><td align="center" style="padding:24px 20px 40px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:650px;border:1px solid #e5e6e4;border-radius:16px;border-collapse:separate;background-color:#ffffff;text-align:left"><tr><td style="padding:30px 38px 24px"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 18px"><tr>${assistantIdentity}<td valign="middle" style="padding-left:10px;color:#303235;font-size:13px;font-weight:600;line-height:1.4">${escapeHtml(
    presentation.assistantName,
  )}</td></tr></table><div style="${BODY_WRAP_STYLE}">${resultBodyHtml}</div><p style="margin:24px 0 22px;font-size:13px;line-height:1.5"><a href="${escapeHtml(
    props.runUrl,
  )}" style="${LINK_STYLE};font-weight:600">Open in ${escapeHtml(
    presentation.assistantName,
  )} &rarr;</a></p><p style="margin:0;padding-top:17px;border-top:1px solid #e5e6e4;color:#8c9094;font-size:11px;line-height:1.5">${footer}</p></td></tr></table></td></tr></table></body></html>`;
}

function plainTextFromHtml(html: string): string {
  return convert(html, { wordwrap: false }).trim();
}

export function renderOfficialAutomationResultEmail(
  props: OfficialAutomationResultEmailRenderProps,
  publicBrand: PublicBrand,
  unsubscribeUrl: string,
): RenderedOfficialAutomationResultEmail {
  let attemptedHtmlBytes: number | null = null;
  let fallbackReason: OfficialAutomationResultEmailFallback["reason"] =
    "render-error";

  const renderAttempt = safeSync(() => {
    const html = officialAutomationResultEmailHtml(
      props,
      publicBrand,
      markdownRenderer.render(props.resultText),
      unsubscribeUrl,
    );
    const htmlBytes = Buffer.byteLength(html, "utf8");
    if (htmlBytes <= OFFICIAL_AUTOMATION_RESULT_EMAIL_HTML_MAX_BYTES) {
      return {
        kind: "rendered" as const,
        html,
        text: plainTextFromHtml(html),
      };
    }
    return { kind: "size-limit" as const, attemptedHtmlBytes: htmlBytes };
  });

  if ("ok" in renderAttempt) {
    if (renderAttempt.ok.kind === "rendered") {
      return {
        html: renderAttempt.ok.html,
        text: renderAttempt.ok.text,
        fallback: null,
      };
    }
    attemptedHtmlBytes = renderAttempt.ok.attemptedHtmlBytes;
    fallbackReason = "size-limit";
  }

  const fallbackHtml = officialAutomationResultEmailHtml(
    props,
    publicBrand,
    `<pre style="margin:0;font-family:inherit;font-size:14px;line-height:1.58;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word">${escapeHtml(
      props.resultText,
    )}</pre>`,
    unsubscribeUrl,
  );
  const fallbackHtmlBytes = Buffer.byteLength(fallbackHtml, "utf8");
  if (fallbackHtmlBytes > OFFICIAL_AUTOMATION_RESULT_EMAIL_HTML_MAX_BYTES) {
    throw new Error(
      "Official Automation result email fallback exceeded its size bound",
    );
  }

  return {
    html: fallbackHtml,
    text: plainTextFromHtml(fallbackHtml),
    fallback: {
      reason: fallbackReason,
      attemptedHtmlBytes,
      fallbackHtmlBytes,
    },
  };
}
