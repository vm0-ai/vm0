export interface ChatThreadSuggestionRange {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

export interface ComposerChatThreadSuggestion {
  readonly id: string;
  readonly title: string;
}

export function findActiveChatThreadSuggestionRange(
  value: string,
  caretIndex: number,
): ChatThreadSuggestionRange | null {
  if (caretIndex < 0 || caretIndex > value.length) {
    return null;
  }

  const beforeCaret = value.slice(0, caretIndex);
  const match = /(?:^|\s)@(\S*)$/u.exec(beforeCaret);
  if (!match) {
    return null;
  }

  const query = match[1] ?? "";
  const atOffset = match[0].lastIndexOf("@");
  const start = beforeCaret.length - match[0].length + atOffset;
  return { start, end: caretIndex, query };
}
