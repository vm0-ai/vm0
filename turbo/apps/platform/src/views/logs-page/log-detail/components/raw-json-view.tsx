import { CopyButton } from "@vm0/ui";
import type { AgentEvent } from "../../../../signals/logs-page/types.ts";
import { highlightText } from "../../utils/highlight-text.tsx";

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

  let element: React.ReactNode = jsonString;
  let matchCount = 0;

  if (searchTerm.trim()) {
    const result = highlightText(jsonString, {
      searchTerm,
      currentMatchIndex,
      matchStartIndex: 0,
    });
    element = result.element;
    matchCount = result.matchCount;
  }

  const containerRef = (node: HTMLPreElement | null) => {
    if (node) {
      setTotalMatches(matchCount);
    }
  };

  return (
    <div className="relative h-full overflow-y-auto">
      <div className="sticky top-0 z-10 flex justify-end p-2 pointer-events-none">
        <CopyButton
          text={jsonString}
          className="h-8 w-8 bg-background/90 hover:bg-background shadow-sm pointer-events-auto"
        />
      </div>
      <pre
        ref={containerRef}
        className="font-mono text-sm whitespace-pre-wrap p-4 pt-0 bg-muted/30 rounded-lg -mt-10"
      >
        {element}
      </pre>
    </div>
  );
}
