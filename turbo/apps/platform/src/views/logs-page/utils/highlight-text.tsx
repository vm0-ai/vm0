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

  // Ensure text is a string (API might return non-string values)
  const textStr = typeof text === "string" ? text : String(text ?? "");

  if (!searchTerm.trim() || !textStr) {
    return { element: textStr, matchCount: 0 };
  }

  const escapedTerm = searchTerm.replace(
    /[.*+?^${}()|[\]\\]/g,
    String.raw`\$&`,
  );
  const regex = new RegExp(`(${escapedTerm})`, "gi");
  const parts = textStr.split(regex);

  let matchCount = 0;
  const elements: ReactNode[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) {
      continue;
    }

    const isMatch = part.toLowerCase() === searchTerm.toLowerCase();

    if (isMatch) {
      const globalIndex = matchStartIndex + matchCount;
      const isCurrent = globalIndex === currentMatchIndex;

      elements.push(
        <mark
          key={`match-${globalIndex}-${i}`}
          data-match-index={globalIndex}
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
    } else {
      elements.push(part);
    }
  }

  return {
    element: elements.length > 0 ? <>{elements}</> : textStr,
    matchCount,
  };
}

/**
 * Count the number of matches of a search term in text without creating elements.
 * More efficient when you only need the count.
 */
export function countMatches(text: string, searchTerm: string): number {
  // Ensure text is a string (API might return non-string values)
  const textStr = typeof text === "string" ? text : String(text ?? "");

  if (!searchTerm.trim() || !textStr) {
    return 0;
  }

  const escapedTerm = searchTerm.replace(
    /[.*+?^${}()|[\]\\]/g,
    String.raw`\$&`,
  );
  const regex = new RegExp(escapedTerm, "gi");
  const matches = textStr.match(regex);
  return matches?.length ?? 0;
}
