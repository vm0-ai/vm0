import { useState } from "react";
import { IconArrowLeft, IconSearch, IconDownload } from "@tabler/icons-react";
import { Button, Input } from "@vm0/ui";
import type { LogStatus } from "../../signals/logs-page/types.ts";
import { StatusBadge } from "../logs-page/status-badge.tsx";
import { StatusDot } from "../logs-page/components/status-dot.tsx";
import type { ActivityItem } from "./zero-activity-types.ts";

type StepVariant = "neutral" | "todo" | "success";

interface StepItem {
  id: string;
  type:
    | "prompt"
    | "initialize"
    | "todo"
    | "skill"
    | "bash"
    | "read"
    | "message";
  content: string;
  variant: StepVariant;
  time?: string;
}

const MOCK_STEPS: StepItem[] = [
  {
    id: "1",
    type: "prompt",
    content:
      "Scan Hacker News for trending AI stories, summarize the top 5, and post the d...",
    variant: "neutral",
    time: "08:30:04",
  },
  {
    id: "2",
    type: "initialize",
    content: "18 tools 5 agents > 10 commands",
    variant: "neutral",
    time: "08:30:05",
  },
  {
    id: "3",
    type: "message",
    content:
      "I'll help you create a daily digest of trending AI stories from Hacker News and post it to Slack. Let me break this down into steps....",
    variant: "neutral",
    time: "08:30:06",
  },
  {
    id: "4",
    type: "todo",
    content: "Fetch top stories from Hacker News API [0/5]",
    variant: "todo",
    time: "08:30:07",
  },
  {
    id: "5",
    type: "message",
    content: "Now let me fetch the top stories from Hacker News.",
    variant: "neutral",
    time: "08:30:08",
  },
  {
    id: "6",
    type: "skill",
    content: "hackernews",
    variant: "success",
    time: "08:30:09",
  },
  {
    id: "7",
    type: "bash",
    content: `bash -c 'curl -s "https://hacker-news.firebaseio.com/v0/t...`,
    variant: "success",
    time: "08:30:10",
  },
  {
    id: "8",
    type: "read",
    content: "/tmp/all_stories.json",
    variant: "success",
    time: "08:30:11",
  },
  {
    id: "9",
    type: "bash",
    content: `cat /tmp/all_stories.json | jq '.[0:10] | [] | {id, titl...`,
    variant: "success",
    time: "08:30:12",
  },
  {
    id: "10",
    type: "message",
    content:
      "Let me try a different approach to fetch the stories more reliably.",
    variant: "neutral",
    time: "08:30:15",
  },
  {
    id: "11",
    type: "message",
    content: "Let me read more to see the actual story data.",
    variant: "neutral",
    time: "08:30:18",
  },
  {
    id: "12",
    type: "message",
    content:
      "Now let me filter for AI-related stories by checking titles, URLs, and fetching more details.",
    variant: "neutral",
    time: "08:30:22",
  },
  {
    id: "13",
    type: "bash",
    content: "5 calls",
    variant: "success",
    time: "08:31:32",
  },
];

function toLogStatus(status: ActivityItem["status"]): LogStatus {
  const map: Record<ActivityItem["status"], LogStatus> = {
    success: "completed",
    error: "failed",
    warning: "timeout",
  };
  return map[status];
}

interface ZeroActivityDetailPageProps {
  item: ActivityItem;
  onBack: () => void;
}

function stepMatchesSearch(step: StepItem, term: string): boolean {
  const t = term.toLowerCase();
  return (
    step.content.toLowerCase().includes(t) ||
    (step.type !== "message" && step.type.toLowerCase().includes(t))
  );
}

export function ZeroActivityDetailPage({
  item,
  onBack,
}: ZeroActivityDetailPageProps) {
  const [stepSearch, setStepSearch] = useState("");
  const steps = MOCK_STEPS.filter(
    (s) => !stepSearch.trim() || stepMatchesSearch(s, stepSearch.trim()),
  );

  const typeLabel = item.type === "zero" ? "Zero" : "Workflow";
  const totalCountDisplay = `${MOCK_STEPS.length}`;

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
          {/* Compact header card: title + meta with labels and short dividers */}
          <div className="shrink-0 rounded-xl border border-border bg-card px-4 py-3 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
            <div className="flex flex-wrap items-center gap-y-2">
              <h2 className="text-base font-semibold tracking-tight text-foreground truncate min-w-0 pr-3">
                {item.title}
              </h2>
              <span
                className="w-px h-3.5 shrink-0 bg-border self-center"
                aria-hidden
              />
              <div className="flex flex-wrap items-center gap-x-0 text-sm">
                <div className="flex items-center gap-1.5 pl-3 pr-3">
                  <span className="text-muted-foreground shrink-0">Status</span>
                  <StatusBadge status={toLogStatus(item.status)} />
                </div>
                <span
                  className="w-px h-3.5 shrink-0 bg-border self-center"
                  aria-hidden
                />
                <div className="flex items-center gap-1.5 pl-3 pr-3">
                  <span className="text-muted-foreground shrink-0">Type</span>
                  <span className="text-foreground truncate">{typeLabel}</span>
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
                    {item.duration ?? "—"}
                  </span>
                </div>
                <span
                  className="w-px h-3.5 shrink-0 bg-border self-center"
                  aria-hidden
                />
                <div className="flex items-center gap-1.5 pl-3 pr-3">
                  <span className="text-muted-foreground shrink-0">Time</span>
                  <span className="text-foreground whitespace-nowrap">
                    {item.time}
                  </span>
                </div>
              </div>
              <div className="flex-1 min-w-0" />
              <Button
                variant="ghost"
                size="sm"
                className="h-8 shrink-0 gap-1 rounded-md text-sm text-muted-foreground hover:text-foreground ml-auto"
              >
                <IconDownload size={14} stroke={1.5} />
                Download
              </Button>
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
                      ? `(${steps.length}/${MOCK_STEPS.length} matched)`
                      : `${totalCountDisplay} total`}
                  </span>
                </div>
                <div className="flex items-center gap-2 sm:gap-3">
                  <div className="relative flex h-9 flex-1 sm:flex-none items-center rounded-lg border border-border bg-card transition-colors focus-within:border-primary focus-within:ring-[3px] focus-within:ring-primary/10">
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
                {steps.length === 0 ? (
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
