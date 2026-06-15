import type { ReactNode } from "react";

interface HighlightResult {
  element: ReactNode;
  matchCount: number;
}

interface HighlightOptions {
  searchTerm: string;
  currentMatchIndex?: number;
  matchStartIndex?: number;
}

/**
 * Highlights search term matches in text with support for current match styling.
 *
 * @param text - The text to search within
 * @param options - Highlight options
 * @returns Object with highlighted element and match count
 */
export function highlightText(
  text: string,
  options: HighlightOptions,
): HighlightResult {
  const { searchTerm, currentMatchIndex = -1, matchStartIndex = 0 } = options;

  if (!searchTerm.trim() || !text) {
    return { element: text, matchCount: 0 };
  }

  const lowered = text.toLowerCase();
  const target = searchTerm.toLowerCase();
  const elements: ReactNode[] = [];
  let matchCount = 0;
  let cursor = 0;

  for (;;) {
    const idx = lowered.indexOf(target, cursor);
    if (idx === -1) {
      if (cursor < text.length) {
        elements.push(text.slice(cursor));
      }
      break;
    }

    if (idx > cursor) {
      elements.push(text.slice(cursor, idx));
    }

    const part = text.slice(idx, idx + target.length);
    const globalIndex = matchStartIndex + matchCount;
    const isCurrent = globalIndex === currentMatchIndex;

    elements.push(
      <mark
        key={`match-${globalIndex}-${idx}`}
        data-match-index={globalIndex}
        data-current-match={isCurrent ? "true" : undefined}
        className={
          isCurrent
            ? "bg-orange-200 text-orange-900 rounded px-0.5"
            : "bg-orange-100 text-orange-800 rounded px-0.5"
        }
      >
        {part}
      </mark>,
    );

    matchCount++;
    cursor = idx + target.length;
  }

  return {
    element: elements.length > 0 ? <>{elements}</> : text,
    matchCount,
  };
}
