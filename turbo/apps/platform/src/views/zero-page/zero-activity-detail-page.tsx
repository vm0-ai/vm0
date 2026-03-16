import { useCCState } from "ccstate-react/experimental";
import { useGet, useSet, useLoadable } from "ccstate-react";
import {
  IconSearch,
  IconLoader2,
  IconDownload,
  IconLock,
  IconChartLine,
} from "@tabler/icons-react";
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
  type GroupedMessage,
} from "../logs-page/log-detail/utils.ts";
import { GroupedMessageCard } from "../logs-page/components/grouped-message-card.tsx";
import { StatusDot } from "../logs-page/components/status-dot.tsx";
import { Markdown } from "../components/markdown.tsx";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Returns true if a grouped message should be shown (filters out text-only
 * assistant messages immediately before a result message).
 */
function isVisibleMessage(
  message: GroupedMessage,
  nextMessage: GroupedMessage | undefined,
): boolean {
  if (message.type !== "assistant") {
    return true;
  }
  if (!nextMessage || nextMessage.type !== "result") {
    return true;
  }
  return (message.toolOperations?.length ?? 0) > 0;
}

interface ZeroActivityDetailPageProps {
  onBack: () => void;
}

function ActivityNotFound({ onBack }: { onBack: () => void }) {
  return (
    <div className="h-full flex flex-col min-h-0">
      <nav className="shrink-0 flex items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground transition-colors"
        >
          <IconChartLine size={14} stroke={1.5} className="shrink-0" />
          Activity
        </button>
        <span className="text-muted-foreground/40 select-none">/</span>
        <span className="rounded-md px-1.5 py-0.5 text-foreground font-medium">
          Log
        </span>
      </nav>
      <div className="flex-1 flex flex-col items-center justify-center gap-3 pb-20">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <IconLock size={24} stroke={1.5} className="text-muted-foreground" />
        </div>
        <h2 className="text-lg font-semibold text-foreground">Log not found</h2>
        <p className="text-sm text-muted-foreground text-center max-w-sm">
          This log doesn&apos;t exist or you don&apos;t have permission to view
          it in the current organization.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="zero-btn-morandi mt-2"
          onClick={onBack}
        >
          Back to activity
        </Button>
      </div>
    </div>
  );
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

  // Detail not found or no permission
  if (detailLoadable.state === "hasError") {
    return <ActivityNotFound onBack={onBack} />;
  }

  const detail =
    detailLoadable.state === "hasData" ? detailLoadable.data : null;
  const events: AgentEvent[] =
    eventsLoadable.state === "hasData" ? eventsLoadable.data : [];

  const allMessages = groupEventsIntoMessages(events);

  // Filter out text-only assistant messages right before result (redundant)
  const visibleMessages = allMessages.filter((message, index) =>
    isVisibleMessage(message, allMessages[index + 1]),
  );

  const messages = visibleMessages.filter((m) =>
    groupedMessageMatchesSearch(m, stepSearch.trim()),
  );

  const prompt = detail?.prompt ?? "";
  const status: LogStatus = detail?.status ?? "running";
  const time = detail ? formatLogTime(detail.createdAt) : "";
  const duration = detail
    ? formatDuration(detail.startedAt, detail.completedAt)
    : undefined;
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex-1 flex flex-col min-h-0 overflow-auto">
        <nav className="shrink-0 flex items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground transition-colors"
          >
            <IconChartLine size={14} stroke={1.5} className="shrink-0" />
            Activity
          </button>
          <span className="text-muted-foreground/40 select-none">/</span>
          <span className="rounded-md px-1.5 py-0.5 text-foreground font-medium truncate">
            {agentName}
          </span>
        </nav>
        <div className="mx-auto max-w-[900px] pb-8">
          {/* Compact header card */}
          <div className="zero-card shrink-0 px-4 py-3">
            <div className="flex flex-wrap items-center gap-y-2">
              <h2 className="text-base font-semibold tracking-tight text-foreground truncate min-w-0 pr-3">
                {agentName}
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
              <div className="flex-1 min-w-0" />
              <Button
                variant="ghost"
                size="sm"
                className="h-8 shrink-0 gap-1 rounded-lg text-sm text-muted-foreground hover:text-foreground ml-auto"
                onClick={() => downloadCsv(events, detail?.id ?? "activity")}
              >
                <IconDownload size={14} stroke={1.5} />
                Download
              </Button>
            </div>
            {detail?.error && status === "failed" && (
              <div className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {detail.error}
              </div>
            )}
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

              <StepsList
                prompt={prompt}
                messages={messages}
                stepSearch={stepSearch}
                isLoading={
                  eventsLoadable.state === "loading" && events.length === 0
                }
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StepsList({
  prompt,
  messages,
  stepSearch,
  isLoading,
}: {
  prompt: string;
  messages: GroupedMessage[];
  stepSearch: string;
  isLoading: boolean;
}) {
  return (
    <div>
      {prompt.trim().length > 0 && (
        <PromptCard prompt={prompt} showConnector={messages.length > 0} />
      )}
      {isLoading ? (
        <div className="flex justify-center py-8">
          <IconLoader2
            size={20}
            stroke={1.5}
            className="animate-spin text-muted-foreground"
          />
        </div>
      ) : messages.length === 0 && prompt.trim().length === 0 ? (
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
  );
}

function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function downloadCsv(events: AgentEvent[], logId: string) {
  const header = "sequenceNumber,eventType,eventData,createdAt";
  const rows = events.map((e) =>
    [
      String(e.sequenceNumber),
      escapeCsvField(e.eventType),
      escapeCsvField(JSON.stringify(e.eventData)),
      escapeCsvField(e.createdAt),
    ].join(","),
  );
  const csv = [header, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${logId}-logs.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function summarizePrompt(prompt: string): string {
  const lines = prompt.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (
      line.length > 0 &&
      !line.startsWith("#") &&
      !line.startsWith("---") &&
      !line.startsWith("- ") &&
      !line.startsWith("[file]")
    ) {
      return line.length > 80 ? `${line.slice(0, 77)}...` : line;
    }
  }
  const first = lines.find((l) => l.trim().length > 0)?.trim() ?? "";
  return first.length > 80 ? `${first.slice(0, 77)}...` : first;
}

function PromptCard({
  prompt,
  showConnector,
}: {
  prompt: string;
  showConnector: boolean;
}) {
  const summary = summarizePrompt(prompt);

  return (
    <div className="relative">
      {showConnector && (
        <div
          className="absolute left-[3px] top-6 bottom-[-8px] w-[1px] bg-border/70"
          aria-hidden="true"
        />
      )}
      <details className="group relative py-2">
        <summary className="cursor-pointer list-none">
          <div className="flex gap-2 items-center">
            <StatusDot variant="neutral" />
            <span className="font-semibold text-sm text-foreground shrink-0">
              Prompt
            </span>
            <span className="text-sm text-muted-foreground truncate">
              {summary}
            </span>
          </div>
        </summary>
        <div className="absolute left-[2px] top-[2.25rem] bottom-0 w-[1px] bg-border/70 group-open:block hidden" />
        <div className="ml-[18px] mt-2">
          <Markdown source={prompt} />
        </div>
      </details>
    </div>
  );
}
