import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import {
  IconSearch,
  IconLoader2,
  IconDownload,
  IconLock,
  IconChartLine,
} from "@tabler/icons-react";
import { Button, Input } from "@vm0/ui";
import {
  MODEL_PROVIDER_TYPES,
  FeatureSwitchKey,
  type ModelProviderType,
} from "@vm0/core";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { Link } from "../router/link.tsx";
import {
  TRIGGER_SOURCE_LABELS,
  type LogStatus,
  type TriggerSource,
  type AgentEvent,
} from "../../signals/zero-page/log-types.ts";
import { StatusBadge } from "./components/logs/status-badge.tsx";
import {
  zeroActivityDetail$,
  zeroActivityEvents$,
  zeroActivityStepSearch$,
  setZeroActivityStepSearch$,
  formatLogTime,
  formatDuration,
} from "../../signals/activity-page/activity-signals.ts";
import {
  groupEventsIntoMessages,
  groupedMessageMatchesSearch,
  type GroupedMessage,
} from "./components/logs/log-detail-utils.ts";
import { GroupedMessageCard } from "./components/logs/grouped-message-card.tsx";
import { StatusDot } from "./components/logs/status-dot.tsx";
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

function ActivityBreadcrumbLink() {
  return (
    <Link
      pathname="/activity"
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground transition-colors no-underline text-inherit"
    >
      <IconChartLine size={14} stroke={1.5} className="shrink-0" />
      Activity
    </Link>
  );
}

function ActivityNotFound() {
  return (
    <div className="h-full flex flex-col min-h-0">
      <nav className="shrink-0 flex items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
        <ActivityBreadcrumbLink />
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
        <Link
          pathname="/activity"
          className="zero-btn-morandi mt-2 inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium no-underline text-inherit hover:bg-accent"
        >
          Back to activity
        </Link>
      </div>
    </div>
  );
}

function ActivityHeaderCard({
  agentName,
  status,
  triggerSource,
  detail,
  duration,
  time,
  events,
}: {
  agentName: string;
  status: LogStatus;
  triggerSource: TriggerSource | null;
  detail: {
    id: string;
    modelProvider?: string | null;
    framework?: string | null;
    error?: string | null;
  };
  duration: string | null | undefined;
  time: string;
  events: AgentEvent[];
}) {
  return (
    <div className="zero-card shrink-0 px-4 py-3">
      <div className="flex items-center gap-y-2 overflow-hidden">
        <h2 className="text-base font-semibold tracking-tight text-foreground truncate min-w-0 pr-3 shrink-0">
          {agentName}
        </h2>
        <span
          className="w-px h-3.5 shrink-0 bg-border self-center"
          aria-hidden
        />
        <div className="flex items-center gap-x-0 text-sm min-w-0 overflow-x-auto">
          <div className="flex items-center gap-1.5 pl-3 pr-3">
            <span className="text-muted-foreground shrink-0">Status</span>
            <StatusBadge status={status} zeroStyle />
          </div>
          <span
            className="w-px h-3.5 shrink-0 bg-border self-center"
            aria-hidden
          />
          {triggerSource && (
            <>
              <div className="flex items-center gap-1.5 pl-3 pr-3">
                <span className="text-muted-foreground shrink-0">Source</span>
                <span className="text-foreground whitespace-nowrap">
                  {TRIGGER_SOURCE_LABELS[triggerSource]}
                </span>
              </div>
              <span
                className="w-px h-3.5 shrink-0 bg-border self-center"
                aria-hidden
              />
            </>
          )}
          {(detail.modelProvider || detail.framework) && (
            <>
              <div className="flex items-center gap-1.5 pl-3 pr-3">
                <span className="text-muted-foreground shrink-0">Model</span>
                <span className="text-foreground whitespace-nowrap">
                  {detail.modelProvider
                    ? (MODEL_PROVIDER_TYPES[
                        detail.modelProvider as ModelProviderType
                      ]?.label ?? detail.modelProvider)
                    : detail.framework}
                </span>
              </div>
              <span
                className="w-px h-3.5 shrink-0 bg-border self-center"
                aria-hidden
              />
            </>
          )}
          <div className="flex items-center gap-1.5 pl-3 pr-3">
            <span className="text-muted-foreground shrink-0">Duration</span>
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
            <span className="text-foreground whitespace-nowrap">{time}</span>
          </div>
        </div>
        <div className="flex-1 min-w-0" />
        <Button
          variant="ghost"
          size="sm"
          className="h-8 shrink-0 gap-1 rounded-lg text-sm text-muted-foreground hover:text-foreground ml-auto"
          onClick={() => downloadCsv(events, detail.id)}
        >
          <IconDownload size={14} stroke={1.5} />
          Download
        </Button>
      </div>
      {detail.error && status === "failed" && (
        <div className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive break-words whitespace-pre-wrap">
          {detail.error}
        </div>
      )}
    </div>
  );
}

export function ZeroActivityDetailPage() {
  const detailLoadable = useLastLoadable(zeroActivityDetail$);
  const eventsLoadable = useLastLoadable(zeroActivityEvents$);
  // Resolve agent display name from the detail response
  const detail =
    detailLoadable.state === "hasData" ? detailLoadable.data : null;
  const agentName = detail ? (detail.displayName ?? detail.agentName) : "Agent";

  const stepSearch = useGet(zeroActivityStepSearch$);
  const setStepSearch = useSet(setZeroActivityStepSearch$);
  const features = useLastResolved(featureSwitch$);

  // Skeleton until both detail and initial events are loaded
  const eventsReady = eventsLoadable.state === "hasData";
  if (!detail || !eventsReady) {
    if (detailLoadable.state === "hasError") {
      return <ActivityNotFound />;
    }
    return <ActivitySkeleton />;
  }

  const events: AgentEvent[] = eventsLoadable.data;

  const allMessages = groupEventsIntoMessages(events);

  // Filter out text-only assistant messages right before result (redundant)
  const visibleMessages = allMessages.filter((message, index) =>
    isVisibleMessage(message, allMessages[index + 1]),
  );

  const messages = visibleMessages.filter((m) =>
    groupedMessageMatchesSearch(m, stepSearch.trim()),
  );

  const showSystemPrompt =
    features?.[FeatureSwitchKey.ShowSystemPrompt] ?? false;

  const prompt = detail.prompt ?? "";
  const appendSystemPrompt = detail.appendSystemPrompt ?? "";
  const hasSystemPrompt =
    showSystemPrompt && appendSystemPrompt.trim().length > 0;
  const status: LogStatus = detail.status;
  const time = formatLogTime(detail.createdAt);
  const duration = formatDuration(detail.startedAt, detail.completedAt);
  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden">
      <div className="flex-1 flex flex-col min-h-0 overflow-auto">
        <nav className="shrink-0 flex items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
          <ActivityBreadcrumbLink />
          <span className="text-muted-foreground/40 select-none">/</span>
          <span className="rounded-md px-1.5 py-0.5 text-foreground font-medium truncate">
            {agentName}
          </span>
        </nav>
        <div className="mx-auto w-full max-w-[900px] px-4 sm:px-6 pt-4 pb-8">
          <ActivityHeaderCard
            agentName={agentName}
            status={status}
            triggerSource={detail.triggerSource ?? null}
            detail={detail}
            duration={duration}
            time={time}
            events={events}
          />

          {/* Steps section */}
          <div className="flex flex-col gap-4 flex-1 min-h-0 min-w-0 mt-6">
            <div className="flex flex-col gap-4 pb-8 min-w-0">
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
                appendSystemPrompt={hasSystemPrompt ? appendSystemPrompt : ""}
                messages={messages}
                stepSearch={stepSearch}
                isLoading={false}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ActivitySkeleton() {
  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden">
      <div className="flex-1 flex flex-col min-h-0 overflow-auto">
        <nav className="shrink-0 flex items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
          <ActivityBreadcrumbLink />
          <span className="text-muted-foreground/40 select-none">/</span>
          <div className="h-4 w-20 rounded bg-muted/50 animate-pulse" />
        </nav>
        <div className="mx-auto max-w-[900px] px-4 sm:px-6 pt-4 pb-8 w-full">
          {/* Header card skeleton */}
          <div className="zero-card shrink-0 px-4 py-3">
            <div className="flex flex-wrap items-center gap-y-2 gap-x-3">
              <div className="h-5 w-28 rounded bg-muted/50 animate-pulse" />
              <span
                className="w-px h-3.5 shrink-0 bg-border self-center"
                aria-hidden
              />
              <div className="h-4 w-20 rounded bg-muted/50 animate-pulse" />
              <div className="h-4 w-16 rounded bg-muted/50 animate-pulse" />
              <div className="h-4 w-24 rounded bg-muted/50 animate-pulse" />
            </div>
          </div>

          {/* Steps skeleton */}
          <div className="flex flex-col gap-4 flex-1 min-h-0 mt-6">
            <div className="flex items-center gap-3">
              <div className="h-5 w-12 rounded bg-muted/50 animate-pulse" />
            </div>
            <div className="flex flex-col gap-3">
              {["sk-1", "sk-2", "sk-3"].map((id) => (
                <div
                  key={id}
                  className="rounded-lg border border-border/40 p-4"
                >
                  <div className="flex items-center gap-2 mb-3">
                    <div className="h-2 w-2 rounded-full bg-muted/50 animate-pulse" />
                    <div className="h-4 w-16 rounded bg-muted/50 animate-pulse" />
                  </div>
                  <div className="space-y-2 ml-4">
                    <div className="h-3 w-full rounded bg-muted/30 animate-pulse" />
                    <div className="h-3 w-3/4 rounded bg-muted/30 animate-pulse" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StepsList({
  prompt,
  appendSystemPrompt,
  messages,
  stepSearch,
  isLoading,
}: {
  prompt: string;
  appendSystemPrompt: string;
  messages: GroupedMessage[];
  stepSearch: string;
  isLoading: boolean;
}) {
  const hasSystemPrompt = appendSystemPrompt.trim().length > 0;
  const hasPrompt = prompt.trim().length > 0;
  const hasContent = hasSystemPrompt || hasPrompt || messages.length > 0;
  return (
    <div className="min-w-0">
      {hasSystemPrompt && (
        <PromptCard
          label="System Prompt"
          prompt={appendSystemPrompt}
          showConnector={hasPrompt || messages.length > 0}
        />
      )}
      {hasPrompt && (
        <PromptCard
          label="Prompt"
          prompt={prompt}
          showConnector={messages.length > 0}
        />
      )}
      {isLoading ? (
        <div className="flex justify-center py-8">
          <IconLoader2
            size={20}
            stroke={1.5}
            className="animate-spin text-muted-foreground"
          />
        </div>
      ) : messages.length === 0 && !hasContent ? (
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
  label = "Prompt",
  prompt,
  showConnector,
}: {
  label?: string;
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
              {label}
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
