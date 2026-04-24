import { command, computed, state } from "ccstate";
import { jsonParseOr, throwIfAbort } from "../utils.ts";

const CHAT_MESSAGE_CLIPBOARD_ATTR = "data-vm0-chat-message";

export interface ChatClipboardAttachment {
  id: string | null;
  url: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface ChatClipboardPayload {
  text: string;
  attachments: ChatClipboardAttachment[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isChatClipboardAttachment(
  value: unknown,
): value is ChatClipboardAttachment {
  if (!isRecord(value)) {
    return false;
  }
  const id = value.id;
  return (
    (typeof id === "string" || id === null) &&
    typeof value.url === "string" &&
    typeof value.filename === "string" &&
    typeof value.contentType === "string" &&
    typeof value.size === "number"
  );
}

function parseChatClipboardPayload(
  serialized: string,
): ChatClipboardPayload | null {
  const parsed = jsonParseOr<unknown>(serialized, null);
  if (!isRecord(parsed) || typeof parsed.text !== "string") {
    return null;
  }
  if (!Array.isArray(parsed.attachments)) {
    return null;
  }
  if (!parsed.attachments.every(isChatClipboardAttachment)) {
    return null;
  }
  return {
    text: parsed.text,
    attachments: parsed.attachments,
  };
}

function decodeClipboardPayload(value: string): string | null {
  // eslint-disable-next-line no-restricted-syntax -- clipboard HTML is untrusted, so malformed URI payloads must be ignored
  try {
    return decodeURIComponent(value);
  } catch (error: unknown) {
    throwIfAbort(error);
    return null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatPlainText(payload: ChatClipboardPayload): string {
  if (payload.attachments.length === 0) {
    return payload.text;
  }
  const attachments = payload.attachments
    .map((attachment) => {
      return `- ${attachment.filename}: ${attachment.url}`;
    })
    .join("\n");
  return [payload.text.trim(), `Attachments:\n${attachments}`]
    .filter(Boolean)
    .join("\n\n");
}

function formatMessageHtml(payload: ChatClipboardPayload): string {
  const encoded = escapeHtml(encodeURIComponent(JSON.stringify(payload)));
  const textHtml = payload.text
    ? `<div>${escapeHtml(payload.text).replace(/\n/g, "<br>")}</div>`
    : "";
  const attachmentsHtml = payload.attachments
    .map((attachment) => {
      const name = escapeHtml(attachment.filename);
      const url = escapeHtml(attachment.url);
      if (isImageAttachment(attachment)) {
        return `<div><img src="${url}" alt="${name}" data-vm0-attachment-id="${escapeHtml(attachment.id ?? "")}" /></div>`;
      }
      return `<div><a href="${url}" data-vm0-attachment-id="${escapeHtml(attachment.id ?? "")}">${name}</a></div>`;
    })
    .join("");
  return `<div ${CHAT_MESSAGE_CLIPBOARD_ATTR}="${encoded}">${textHtml}${attachmentsHtml}</div>`;
}

function isImageAttachment(attachment: ChatClipboardAttachment): boolean {
  return (
    attachment.contentType.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|svg)$/i.test(attachment.filename)
  );
}

async function writeClipboardItem(items: Record<string, Blob>): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem(items)]);
}

/**
 * Write text to the clipboard with a legacy fallback.
 *
 * Tries the Clipboard API first. When it throws (e.g. NotAllowedError on iOS
 * Safari after an async boundary loses the user-gesture context), falls back to
 * the deprecated `document.execCommand("copy")` approach.
 *
 * Returns `true` if the text was copied, `false` if both methods failed.
 */
export async function writeToClipboard(text: string): Promise<boolean> {
  // eslint-disable-next-line no-restricted-syntax -- clipboard API requires try/catch for browser compatibility fallback
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error: unknown) {
    throwIfAbort(error);
    // Clipboard API can throw NotAllowedError on iOS Safari when the user
    // gesture context is lost (e.g. after an async boundary). Fall back to
    // the legacy execCommand approach.
    // eslint-disable-next-line no-restricted-syntax -- clipboard API requires try/catch for legacy execCommand fallback
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
      return true;
    } catch (fallbackError: unknown) {
      throwIfAbort(fallbackError);
      return false;
    }
  }
}

export async function writeChatMessageToClipboard(
  payload: ChatClipboardPayload,
): Promise<boolean> {
  const plainText = formatPlainText(payload);
  if (
    payload.attachments.length === 0 ||
    typeof ClipboardItem === "undefined" ||
    !navigator.clipboard?.write
  ) {
    return await writeToClipboard(plainText);
  }

  const html = formatMessageHtml(payload);
  const baseItems: Record<string, Blob> = {
    "text/plain": new Blob([plainText], { type: "text/plain" }),
    "text/html": new Blob([html], { type: "text/html" }),
  };

  // eslint-disable-next-line no-restricted-syntax -- rich clipboard writes fall back to text when the browser blocks ClipboardItem
  try {
    await writeClipboardItem(baseItems);
    return true;
  } catch (error: unknown) {
    throwIfAbort(error);
    return await writeToClipboard(plainText);
  }
}

export function readChatMessageFromClipboard(
  clipboardData: DataTransfer,
): ChatClipboardPayload | null {
  const html = clipboardData.getData("text/html");
  if (!html) {
    return null;
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  const node = doc.querySelector(`[${CHAT_MESSAGE_CLIPBOARD_ATTR}]`);
  const encoded = node?.getAttribute(CHAT_MESSAGE_CLIPBOARD_ATTR);
  if (!encoded) {
    return null;
  }
  const serialized = decodeClipboardPayload(encoded);
  return serialized ? parseChatClipboardPayload(serialized) : null;
}

const internalCopyStatus$ = state<"idle" | "copied">("idle");

const internalCopyTimeoutId$ = state<number | null>(null);

export const copyStatus$ = computed((get) => {
  return get(internalCopyStatus$);
});

/**
 * Copy text to clipboard and show "copied" status for 5 seconds.
 */
export const copyToClipboard$ = command(
  async ({ get, set }, text: string, signal: AbortSignal) => {
    const ok = await writeToClipboard(text);
    signal.throwIfAborted();
    if (!ok) {
      return;
    }

    const existingTimeoutId = get(internalCopyTimeoutId$);
    if (existingTimeoutId !== null) {
      window.clearTimeout(existingTimeoutId);
    }

    set(internalCopyStatus$, "copied");

    const timeoutId = window.setTimeout(() => {
      set(internalCopyStatus$, "idle");
      set(internalCopyTimeoutId$, null);
    }, 5000);
    set(internalCopyTimeoutId$, timeoutId);
  },
);
