import { CopyButton } from "@vm0/ui";
import type { AgentEvent } from "../../../../signals/logs-page/types.ts";
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

  return (
    <div className="relative h-full overflow-y-auto bg-muted/30 rounded-lg p-4">
      <CopyButton
        text={jsonString}
        className="sticky top-0 float-right ml-2 h-6 w-6 p-1 bg-background/80 hover:bg-background rounded z-10"
      />
      <JsonViewer
        data={events}
        maxInitialDepth={2}
        showCopyButton={false}
        searchTerm={searchTerm}
        currentMatchIndex={currentMatchIndex}
        onMatchCountChange={setTotalMatches}
      />
    </div>
  );
}
