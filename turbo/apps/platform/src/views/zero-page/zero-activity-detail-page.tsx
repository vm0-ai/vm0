import { useCCState } from "ccstate-react/experimental";
import { useGet, useSet, useLoadable } from "ccstate-react";
import { IconArrowLeft, IconSearch, IconLoader2 } from "@tabler/icons-react";
import { Button, Input } from "@vm0/ui";
import type { LogStatus, AgentEvent } from "../../signals/logs-page/types.ts";
import { StatusBadge } from "../logs-page/status-badge.tsx";
import { StatusDot } from "../logs-page/components/status-dot.tsx";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";
import {
  zeroActivityDetail$,
  zeroActivityEvents$,
  formatLogTime,
  formatDuration,
} from "../../signals/zero-page/zero-activity.ts";

// ---------------------------------------------------------------------------
// Map AgentEvent to display step
// ---------------------------------------------------------------------------

type StepVariant = "neutral" | "todo" | "success" | "error" | "pending";

interface StepItem {
  id: string;
  type: string;
  content: string;
  variant: StepVariant;
  time?: string;
}

function eventToStep(event: AgentEvent, index: number): StepItem {
  const eventType = event.eventType;
  const data = event.eventData as Record<string, unknown> | undefined;
  const time = new Date(event.createdAt).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  let content = "";
  let variant: StepVariant = "neutral";

  if (typeof data === "object" && data !== null) {
    if (typeof data.content === "string") {
      content = data.content;
    } else if (typeof data.message === "string") {
      content = data.message;
    } else if (typeof data.name === "string") {
      content = data.name;
    } else if (typeof data.text === "string") {
      content = data.text;
    } else {
      content = JSON.stringify(data).slice(0, 200);
    }
  }

  // Determine variant based on event type
  if (eventType.includes("error") || eventType.includes("fail")) {
    variant = "error";
  } else if (
    eventType.includes("tool") ||
    eventType.includes("bash") ||
    eventType.includes("skill")
  ) {
    variant = "success";
  } else if (eventType.includes("todo") || eventType.includes("plan")) {
    variant = "todo";
  }

  return {
    id: String(event.sequenceNumber ?? index),
    type: eventType,
    content: content || eventType,
    variant,
    time,
  };
}

function stepMatchesSearch(step: StepItem, term: string): boolean {
  const t = term.toLowerCase();
  return (
    step.content.toLowerCase().includes(t) ||
    step.type.toLowerCase().includes(t)
  );
}

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

  const allSteps = events.map(eventToStep);
  const steps = allSteps.filter(
    (s) => !stepSearch.trim() || stepMatchesSearch(s, stepSearch.trim()),
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
                      ? `(${steps.length}/${allSteps.length} matched)`
                      : `${allSteps.length} total`}
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
                ) : steps.length === 0 ? (
                  <div className="py-8 text-center text-muted-foreground">
                    No events available
                  </div>
                ) : (
                  steps.map((step, index) => {
                    const showConnector = index < steps.length - 1;
                    const hasLabel = step.type !== "message";
                    const typeLabel =
                      step.type.charAt(0).toUpperCase() + step.type.slice(1);
                    return (
                      <div key={step.id} className="py-2 relative">
                        {showConnector && (
                          <div
                            className="absolute left-[3px] top-6 bottom-[-8px] w-[1px] bg-border/70"
                            aria-hidden="true"
                          />
                        )}
                        <div className="flex gap-2 items-center relative min-w-0">
                          <StatusDot variant={step.variant} />
                          {hasLabel && (
                            <span className="font-semibold text-sm text-foreground shrink-0">
                              {typeLabel}
                            </span>
                          )}
                          <span className="text-sm text-foreground min-w-0 truncate">
                            {step.content}
                          </span>
                          <span className="flex-1 shrink min-w-0" />
                          {step.time !== undefined && (
                            <span className="text-xs text-muted-foreground shrink-0 ml-4 whitespace-nowrap hidden sm:inline">
                              {step.time}
                            </span>
                          )}
                        </div>
                        {step.time !== undefined && (
                          <div className="text-xs text-muted-foreground pl-5 mt-1 sm:hidden">
                            {step.time}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
