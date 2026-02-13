import { useLastLoadable, useGet, useSet } from "ccstate-react";
import { IconPlayerPlay, IconX, IconLoader2 } from "@tabler/icons-react";
import { Button } from "@vm0/ui/components/ui/button";
import {
  allInlineRunEvents$,
  closeInlineRun$,
  inlineRunStatus$,
} from "../../signals/agent-detail/inline-run.ts";
import { FormattedEventsView } from "../logs-page/log-detail/components/formatted-events-view.tsx";

interface InlineRunPanelProps {
  runId: string | null;
}

function isTerminal(status: string | null): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timeout" ||
    status === "cancelled"
  );
}

function noop() {
  // intentional no-op for search interface
}

export function InlineRunPanel({ runId }: InlineRunPanelProps) {
  const eventsLoadable = useLastLoadable(allInlineRunEvents$);
  const runStatus = useGet(inlineRunStatus$);
  const close = useSet(closeInlineRun$);

  const events = eventsLoadable.state === "hasData" ? eventsLoadable.data : [];
  const isLoading = eventsLoadable.state === "loading" && events.length === 0;
  const terminal = isTerminal(runStatus);

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-card">
        <IconPlayerPlay size={16} className="text-muted-foreground shrink-0" />
        <span className="text-sm font-mono text-muted-foreground truncate">
          {runId ? `RunId: ${runId}` : "Sandbox preparing..."}
        </span>
        {runStatus && <StatusLabel status={runStatus} />}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground"
          onClick={() => close()}
          aria-label="Close run panel"
        >
          <IconX size={16} />
        </Button>
      </div>

      {/* Content */}
      <div className="bg-muted/50 p-4">
        {!runId ? (
          <div className="flex items-center justify-center py-8">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <IconLoader2 className="h-4 w-4 animate-spin" />
              Creating sandbox...
            </div>
          </div>
        ) : isLoading ? (
          <div className="flex items-center justify-center py-8">
            <IconLoader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : events.length === 0 && !terminal ? (
          <div className="flex items-center justify-center py-8">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <IconLoader2 className="h-4 w-4 animate-spin" />
              Waiting for events...
            </div>
          </div>
        ) : events.length === 0 && terminal ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No events recorded
          </div>
        ) : (
          <FormattedEventsView
            events={events}
            searchTerm=""
            currentMatchIndex={-1}
            setTotalMatches={noop}
          />
        )}
      </div>
    </div>
  );
}

function StatusLabel({ status }: { status: string }) {
  const colorClass = isTerminal(status)
    ? status === "completed"
      ? "text-green-600"
      : "text-destructive"
    : "text-primary";

  return (
    <span className={`text-xs font-medium capitalize ${colorClass}`}>
      {status}
    </span>
  );
}
