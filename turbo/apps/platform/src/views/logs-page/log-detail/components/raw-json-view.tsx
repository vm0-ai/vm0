import { CopyButton } from "@vm0/ui";
import type { AgentEvent } from "../../../../signals/logs-page/types.ts";
import { highlightText } from "../../utils/highlight-text.tsx";
import { EVENTS_CONTAINER_ID } from "../utils.ts";

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
    <div className="relative">
      <CopyButton
        text={jsonString}
        className="absolute top-2 right-2 h-8 w-8 bg-background/80 hover:bg-background z-10"
      />
      <pre
        id={EVENTS_CONTAINER_ID}
        ref={containerRef}
        className="font-mono text-sm whitespace-pre-wrap overflow-auto max-h-[600px] p-4 bg-muted/30 rounded-lg"
      >
        {element}
      </pre>
    </div>
  );
}
