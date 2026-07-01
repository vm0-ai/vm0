export const CHAT_THREAD_EMOJI_OPTIONS = [
  { emoji: "✅", label: "Done" },
  { emoji: "🔥", label: "Urgent" },
  { emoji: "❌", label: "No" },
  { emoji: "⚠️", label: "Risk" },
  { emoji: "💡", label: "Idea" },
  { emoji: "❓", label: "Question" },
  { emoji: "⏳", label: "Waiting" },
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

export function chatThreadEmojiShortcutIndex(event: {
  key: string;
  code?: string;
}): number | null {
  const codeMatch = event.code?.match(/^(?:Digit|Numpad)([1-7])$/);
  const key = codeMatch?.[1] ?? event.key;
  const fallbackShiftedKeys: Record<string, string> = {
    "!": "1",
    "@": "2",
    "#": "3",
    $: "4",
    "%": "5",
    "^": "6",
    "&": "7",
  };
  const digit = fallbackShiftedKeys[key] ?? key;
  if (!/^[1-7]$/.test(digit)) {
    return null;
  }
  return Number(digit) - 1;
}
