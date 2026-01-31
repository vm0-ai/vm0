import { useGet } from "ccstate-react";
import { JsonView, darkStyles, defaultStyles } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";
import { CopyButton } from "@vm0/ui";
import { theme$ } from "../../../signals/theme.ts";

interface JsonViewerProps {
  data: unknown;
  maxInitialDepth?: number;
  className?: string;
  showCopyButton?: boolean;
  searchTerm?: string;
  currentMatchIndex?: number;
  onMatchCountChange?: (count: number) => void;
}

function getLightStyles() {
  return {
    ...defaultStyles,
    container: "font-mono text-xs leading-relaxed",
    label: "text-rose-700/80 font-medium json-searchable",
    stringValue: "text-emerald-700/80 json-searchable",
    numberValue: "text-blue-700/80 json-searchable",
    booleanValue: "text-violet-700/80 json-searchable",
    nullValue: "text-gray-400 italic json-searchable",
    undefinedValue: "text-gray-400 italic json-searchable",
    punctuation: "text-gray-400",
    expandIcon:
      "text-gray-500 hover:text-gray-700 cursor-pointer select-none before:content-['▶'] before:mr-1 before:text-[0.6em]",
    collapseIcon:
      "text-gray-500 hover:text-gray-700 cursor-pointer select-none before:content-['▼'] before:mr-1 before:text-[0.6em]",
    collapsedContent:
      "text-gray-500 hover:text-gray-700 cursor-pointer px-1 rounded hover:bg-gray-100",
    basicChildStyle: "pl-4",
    childFieldsContainer: "",
    clickableLabel:
      "cursor-pointer hover:underline hover:bg-gray-100 rounded px-0.5 json-searchable",
    otherValue: "text-gray-600 json-searchable",
  };
}

function getDarkStyles() {
  return {
    ...darkStyles,
    container: "font-mono text-xs leading-relaxed",
    label: "text-rose-400/90 font-medium json-searchable",
    stringValue: "text-emerald-400/90 json-searchable",
    numberValue: "text-blue-400/90 json-searchable",
    booleanValue: "text-violet-400/90 json-searchable",
    nullValue: "text-gray-500 italic json-searchable",
    undefinedValue: "text-gray-500 italic json-searchable",
    punctuation: "text-gray-500",
    expandIcon:
      "text-gray-500 hover:text-gray-300 cursor-pointer select-none before:content-['▶'] before:mr-1 before:text-[0.6em]",
    collapseIcon:
      "text-gray-500 hover:text-gray-300 cursor-pointer select-none before:content-['▼'] before:mr-1 before:text-[0.6em]",
    collapsedContent:
      "text-gray-500 hover:text-gray-300 cursor-pointer px-1 rounded hover:bg-gray-700",
    basicChildStyle: "pl-4",
    childFieldsContainer: "",
    clickableLabel:
      "cursor-pointer hover:underline hover:bg-gray-700 rounded px-0.5 json-searchable",
    otherValue: "text-gray-400 json-searchable",
  };
}

/**
 * Check if a value contains the search term (case-insensitive)
 */
function valueContainsSearch(value: unknown, searchTerm: string): boolean {
  if (searchTerm === "") {
    return false;
  }
  const lowerSearch = searchTerm.toLowerCase();

  if (typeof value === "string") {
    return value.toLowerCase().includes(lowerSearch);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).toLowerCase().includes(lowerSearch);
  }
  if (value === null) {
    return "null".includes(lowerSearch);
  }
  if (Array.isArray(value)) {
    return value.some((item) => valueContainsSearch(item, searchTerm));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(
      ([key, val]) =>
        key.toLowerCase().includes(lowerSearch) ||
        valueContainsSearch(val, searchTerm),
    );
  }
  return false;
}

/**
 * Highlight matches in DOM and scroll to current match
 */
function highlightAndScroll(
  container: HTMLElement,
  searchTerm: string,
  currentMatchIndex: number,
): number {
  // Remove existing highlights
  const existingHighlights = container.querySelectorAll(
    ".json-search-highlight",
  );
  for (const el of existingHighlights) {
    const textNode = document.createTextNode(el.textContent ?? "");
    el.replaceWith(textNode);
    textNode.parentNode?.normalize();
  }

  if (!searchTerm.trim()) {
    return 0;
  }

  const lowerSearch = searchTerm.toLowerCase();
  let matchCount = 0;
  const highlights: HTMLElement[] = [];

  // Find all text nodes in searchable elements
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!parent) {
        return NodeFilter.FILTER_REJECT;
      }
      // Only search in elements with json-searchable class
      if (
        parent.classList.contains("json-searchable") ||
        parent.closest(".json-searchable")
      ) {
        return NodeFilter.FILTER_ACCEPT;
      }
      return NodeFilter.FILTER_REJECT;
    },
  });

  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    textNodes.push(node as Text);
  }

  // Process each text node
  for (const textNode of textNodes) {
    const text = textNode.textContent ?? "";
    const lowerText = text.toLowerCase();
    let lastIndex = 0;
    let matchIndex = lowerText.indexOf(lowerSearch);

    if (matchIndex === -1) {
      continue;
    }

    const fragment = document.createDocumentFragment();

    while (matchIndex !== -1) {
      // Add text before match
      if (matchIndex > lastIndex) {
        fragment.appendChild(
          document.createTextNode(text.slice(lastIndex, matchIndex)),
        );
      }

      // Add highlighted match
      const highlight = document.createElement("mark");
      highlight.className =
        "json-search-highlight bg-yellow-300 dark:bg-yellow-600 rounded px-0.5";
      highlight.dataset.matchIndex = String(matchCount);
      highlight.textContent = text.slice(
        matchIndex,
        matchIndex + searchTerm.length,
      );

      if (matchCount === currentMatchIndex) {
        highlight.classList.add("ring-2", "ring-primary", "bg-primary/30");
      }

      fragment.appendChild(highlight);
      highlights.push(highlight);
      matchCount++;

      lastIndex = matchIndex + searchTerm.length;
      matchIndex = lowerText.indexOf(lowerSearch, lastIndex);
    }

    // Add remaining text
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    textNode.replaceWith(fragment);
  }

  // Scroll to current match
  const currentHighlight = highlights[currentMatchIndex];
  if (currentHighlight) {
    currentHighlight.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  return matchCount;
}

/**
 * Interactive JSON viewer component with dark/light theme support.
 * Uses react-json-view-lite for tree navigation with expandable nodes.
 * Supports search with auto-expand and highlighting.
 */
export function JsonViewer({
  data,
  maxInitialDepth = 2,
  className = "",
  showCopyButton = true,
  searchTerm = "",
  currentMatchIndex = 0,
  onMatchCountChange,
}: JsonViewerProps) {
  const theme = useGet(theme$);
  const isDark = theme === "dark";
  const hasSearch = searchTerm.trim().length > 0;

  const styles = isDark ? getDarkStyles() : getLightStyles();

  // When searching, expand nodes that contain matches
  const shouldExpandNode = (level: number, value: unknown): boolean => {
    if (hasSearch) {
      // Always expand nodes that contain the search term
      return valueContainsSearch(value, searchTerm);
    }
    return level < maxInitialDepth;
  };

  // Ensure data is an object or array for JsonView
  const jsonData =
    typeof data === "object" && data !== null ? data : { value: data };

  const jsonString = JSON.stringify(data, null, 2);

  // Ref callback to highlight matches after render
  const containerRef = (node: HTMLDivElement | null) => {
    if (!node) {
      return;
    }

    if (hasSearch) {
      // Use queueMicrotask to ensure DOM is updated after React render
      queueMicrotask(() => {
        const matchCount = highlightAndScroll(
          node,
          searchTerm,
          currentMatchIndex,
        );
        onMatchCountChange?.(matchCount);
      });
    } else {
      onMatchCountChange?.(0);
    }
  };

  // Generate a key that changes when search changes to force re-render
  const viewKey = hasSearch ? `search-${searchTerm}` : "no-search";

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {showCopyButton && (
        <div className="absolute top-0 right-0 z-10">
          <CopyButton
            text={jsonString}
            className="h-6 w-6 p-1 bg-background/80 hover:bg-background rounded"
          />
        </div>
      )}
      <div className="overflow-auto">
        <JsonView
          key={viewKey}
          data={jsonData}
          style={styles}
          shouldExpandNode={shouldExpandNode}
          clickToExpandNode
        />
      </div>
    </div>
  );
}
