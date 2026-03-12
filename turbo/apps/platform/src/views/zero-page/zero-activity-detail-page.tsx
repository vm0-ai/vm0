import { useCCState } from "ccstate-react/experimental";
import { useGet, useSet, useLoadable } from "ccstate-react";
import { IconArrowLeft, IconSearch, IconLoader2 } from "@tabler/icons-react";
import { Button, Input } from "@vm0/ui";
import type { LogStatus, AgentEvent } from "../../signals/logs-page/types.ts";
import { StatusBadge } from "../logs-page/status-badge.tsx";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";
import {
  zeroActivityDetail$,
  zeroActivityEvents$,
  formatLogTime,
  formatDuration,
} from "../../signals/zero-page/zero-activity.ts";
import {
  groupEventsIntoMessages,
  groupedMessageMatchesSearch,
} from "../logs-page/log-detail/utils.ts";
import { GroupedMessageCard } from "../logs-page/components/grouped-message-card.tsx";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ZeroActivityDetailPageProps {
  logId: string;
  onBack: () => void;
}

export function ZeroActivityDetailPage({
  onBack,
}: ZeroActivityDetailPageProps) {
  const agentNameLoadable = useLoadable(agentDisplayName$);
  const agentName =
    agentNameLoadable.state === "hasData" ? agentNameLoadable.data : "Zero";

  const detailLoadable = useLoadable(zeroActivityDetail$);
  const eventsLoadable = useLoadable(zeroActivityEvents$);

  const stepSearch$ = useCCState("");
  const stepSearch = useGet(stepSearch$);
  const setStepSearch = useSet(stepSearch$);

  const detail =
    detailLoadable.state === "hasData" ? detailLoadable.data : null;
  const events: AgentEvent[] =
    eventsLoadable.state === "hasData" ? eventsLoadable.data : [];

  const allMessages = groupEventsIntoMessages(events);

  // Filter out text-only assistant messages right before result (redundant)
  const visibleMessages = allMessages.filter((message, index) => {
    if (message.type !== "assistant") {
      return true;
    }
    const nextMessage = allMessages[index + 1];
    if (!nextMessage || nextMessage.type !== "result") {
      return true;
    }
    const hasTools =
      message.toolOperations && message.toolOperations.length > 0;
    return hasTools;
  });

  const messages = visibleMessages.filter((m) =>
    groupedMessageMatchesSearch(m, stepSearch.trim()),
  );

  const status: LogStatus = detail?.status ?? "running";
  const time = detail ? formatLogTime(detail.createdAt) : "";
  const duration = detail
    ? formatDuration(detail.startedAt, detail.completedAt)
    : undefined;

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex-1 flex flex-col min-h-0 overflow-auto">
        <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-4 pb-3">
          <div className="mb-3">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 -ml-2"
              onClick={onBack}
              aria-label="Back to activity"
            >
              <IconArrowLeft size={20} stroke={1.5} />
            </Button>
          </div>
        </header>
        <div className="max-w-[900px] w-full mx-auto px-4 sm:px-6 pb-8">
          {/* Compact header card */}
          <div className="zero-card shrink-0 px-4 py-3">
            <div className="flex flex-wrap items-center gap-y-2">
              <h2 className="text-base font-semibold tracking-tight text-foreground truncate min-w-0 pr-3">
                {detail?.prompt
                  ? detail.prompt.length > 80
                    ? `${detail.prompt.slice(0, 80)}...`
                    : detail.prompt
                  : agentName}
              </h2>
              <span
                className="w-px h-3.5 shrink-0 bg-border self-center"
                aria-hidden
              />
              <div className="flex flex-wrap items-center gap-x-0 text-sm">
                <div className="flex items-center gap-1.5 pl-3 pr-3">
                  <span className="text-muted-foreground shrink-0">Status</span>
                  <StatusBadge status={status} zeroStyle />
                </div>
                <span
                  className="w-px h-3.5 shrink-0 bg-border self-center"
                  aria-hidden
                />
                <div className="flex items-center gap-1.5 pl-3 pr-3">
                  <span className="text-muted-foreground shrink-0">Agent</span>
                  <span className="text-foreground truncate">{agentName}</span>
                </div>
                <span
                  className="w-px h-3.5 shrink-0 bg-border self-center"
                  aria-hidden
                />
                <div className="flex items-center gap-1.5 pl-3 pr-3">
                  <span className="text-muted-foreground shrink-0">
                    Duration
                  </span>
                  <span className="text-foreground whitespace-nowrap">
                    {duration ?? "—"}
                  </span>
                </div>
                <span
                  className="w-px h-3.5 shrink-0 bg-border self-center"
                  aria-hidden
                />
                <div className="flex items-center gap-1.5 pl-3 pr-3">
                  <span className="text-muted-foreground shrink-0">Time</span>
                  <span className="text-foreground whitespace-nowrap">
                    {time}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Steps section */}
          <div className="flex flex-col gap-4 flex-1 min-h-0 mt-6">
            <div className="flex flex-col gap-4 pb-8">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="text-base font-medium text-foreground whitespace-nowrap">
                    Steps
                  </span>
                  <span className="text-sm text-muted-foreground whitespace-nowrap">
                    {stepSearch.trim()
                      ? `(${messages.length}/${visibleMessages.length} matched)`
                      : `${visibleMessages.length} total`}
                  </span>
                </div>
                <div className="flex items-center gap-2 sm:gap-3">
                  <div className="zero-search-input relative flex h-9 flex-1 sm:flex-none items-center rounded-lg border transition-colors focus-within:border-primary focus-within:ring-[3px] focus-within:ring-primary/10">
                    <div className="pl-2">
                      <IconSearch className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <Input
                      placeholder="Search steps"
                      value={stepSearch}
                      onChange={(e) => setStepSearch(e.target.value)}
                      className="h-full w-full sm:w-44 border-0 text-sm focus:border-0 focus:ring-0 pl-2 pr-3 bg-transparent"
                    />
                  </div>
                </div>
              </div>

              <div>
                {eventsLoadable.state === "loading" && events.length === 0 ? (
                  <div className="flex justify-center py-8">
                    <IconLoader2
                      size={20}
                      stroke={1.5}
                      className="animate-spin text-muted-foreground"
                    />
                  </div>
                ) : messages.length === 0 ? (
                  <div className="py-8 text-center text-muted-foreground">
                    No events available
                  </div>
                ) : (
                  messages.map((message, index) => (
                    <GroupedMessageCard
                      key={`${message.type}-${message.sequenceNumber}-${message.createdAt}`}
                      message={message}
                      searchTerm={stepSearch}
                      showConnector={index < messages.length - 1}
                    />
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
