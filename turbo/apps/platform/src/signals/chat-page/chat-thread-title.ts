export const CHAT_THREAD_EMOJI_OPTIONS = [
  { emoji: "✅", label: "Done" },
  { emoji: "🔥", label: "Urgent" },
  { emoji: "❌", label: "No" },
  { emoji: "⚠️", label: "Risk" },
  { emoji: "💡", label: "Idea" },
  { emoji: "❓", label: "Question" },
  { emoji: "⏳", label: "Waiting" },
  { emoji: "👀", label: "Watching" },
  { emoji: "🚀", label: "Shipped" },
] as const;

const CHAT_THREAD_EMOJI_PATTERN =
  /(?:[\u{1f1e6}-\u{1f1ff}]{2}|[#*0-9]\ufe0f?\u20e3|\p{Extended_Pictographic}(?:\ufe0f|\ufe0e)?(?:[\u{1f3fb}-\u{1f3ff}])?(?:\u200d\p{Extended_Pictographic}(?:\ufe0f|\ufe0e)?(?:[\u{1f3fb}-\u{1f3ff}])?)*)/u;

interface ChatThreadTitleParts {
  readonly emoji: string | null;
  readonly text: string;
}

export function getChatThreadTitleParts(
  title: string | null | undefined,
): ChatThreadTitleParts {
  const trimmedTitle = title?.trim() ?? "";
  if (!trimmedTitle) {
    return { emoji: null, text: "" };
  }

  const match = trimmedTitle.match(CHAT_THREAD_EMOJI_PATTERN);
  if (!match || match.index === undefined) {
    return { emoji: null, text: trimmedTitle };
  }

  const beforeEmoji = trimmedTitle.slice(0, match.index).trim();
  const afterEmoji = trimmedTitle.slice(match.index + match[0].length).trim();
  return {
    emoji: match[0],
    text: [beforeEmoji, afterEmoji].filter(Boolean).join(" "),
  };
}

export function applyChatThreadEmoji(
  title: string | null | undefined,
  emoji: string,
): string {
  const { text } = getChatThreadTitleParts(title);
  return text ? `${emoji} ${text}` : emoji;
}

export function removeChatThreadEmoji(
  title: string | null | undefined,
): string {
  return getChatThreadTitleParts(title).text;
}

interface ChatThreadEmojiKeyboardEvent {
  key: string;
  code?: string;
  shiftKey: boolean;
}

function chatThreadEmojiShortcutDigit(
  event: ChatThreadEmojiKeyboardEvent,
): string | null {
  if (!event.shiftKey) {
    return null;
  }
  const shiftedDigitKeys: Record<string, string> = {
    "!": "1",
    "@": "2",
    "#": "3",
    $: "4",
    "%": "5",
    "^": "6",
    "&": "7",
    "*": "8",
    "(": "9",
    ")": "0",
  };
  const codeMatch = event.code?.match(/^(?:Digit|Numpad)([0-9])$/);
  const key = codeMatch?.[1] ?? event.key;
  const digit = shiftedDigitKeys[key] ?? key;
  return /^[0-9]$/.test(digit) ? digit : null;
}

export function chatThreadEmojiShortcutIndex(
  event: ChatThreadEmojiKeyboardEvent,
): number | null {
  const digit = chatThreadEmojiShortcutDigit(event);
  if (digit === null || digit === "0") {
    return null;
  }
  return Number(digit) - 1;
}

export function isChatThreadEmojiClearShortcut(
  event: ChatThreadEmojiKeyboardEvent,
): boolean {
  return chatThreadEmojiShortcutDigit(event) === "0";
}
