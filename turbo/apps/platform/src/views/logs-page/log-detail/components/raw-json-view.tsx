import { CopyButton } from "@vm0/ui";
import type { AgentEvent } from "../../../../signals/logs-page/types.ts";
import { highlightText } from "../../utils/highlight-text.tsx";
import { JsonViewer } from "../../components/json-viewer.tsx";

export function RawJsonView({
  events,
  searchTerm,
  currentMatchIndex,
  setTotalMatches,
}: {
  events: AgentEvent[];
  searchTerm: string;
  currentMatchIndex: number;
  setTotalMatches: (count: number) => void;
}) {
  const jsonString = JSON.stringify(events, null, 2);
  const hasSearch = searchTerm.trim().length > 0;

  // When searching, show text view with highlighting
  if (hasSearch) {
    const result = highlightText(jsonString, {
      searchTerm,
      currentMatchIndex,
      matchStartIndex: 0,
    });

    const containerRef = (node: HTMLPreElement | null) => {
      if (node) {
        setTotalMatches(result.matchCount);
      }
    };

    return (
      <div className="relative h-full overflow-y-auto bg-muted/30 rounded-lg">
        <CopyButton
          text={jsonString}
          className="sticky top-2 float-right mr-2 mt-2 h-8 w-8 bg-background/90 hover:bg-background shadow-sm z-10"
        />
        <pre
          ref={containerRef}
          className="font-mono text-sm whitespace-pre-wrap p-4"
        >
          {result.element}
        </pre>
      </div>
    );
  }

  // No search: reset match count and show interactive JSON tree viewer
  const containerRef = (node: HTMLDivElement | null) => {
    if (node) {
      setTotalMatches(0);
    }
  };

  return (
    <div
      ref={containerRef}
      className="h-full overflow-y-auto bg-muted/30 rounded-lg p-4"
    >
      <JsonViewer data={events} maxInitialDepth={2} showCopyButton />
    </div>
  );
}
