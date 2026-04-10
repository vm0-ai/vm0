// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
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
  IconChartLine,
} from "@tabler/icons-react";
import {
  Button,
  Input,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import {
  MODEL_PROVIDER_TYPES,
  FeatureSwitchKey,
  RUN_ERROR_GUIDANCE,
  type ModelProviderType,
} from "@vm0/core";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { fetchDownloadExtra$ } from "../../signals/activity-page/activity-download.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { searchParams$, updateSearchParams$ } from "../../signals/route.ts";
import { Link } from "../router/link.tsx";
import {
  TRIGGER_SOURCE_LABELS,
  getTriggerSourceLabel,
  type LogStatus,
  type TriggerSource,
  type AgentEvent,
  type LogDetail,
} from "../../signals/zero-page/log-types.ts";
import { StatusBadge } from "./components/log-views/status-badge.tsx";
import {
  zeroActivityDetail$,
  zeroActivityEvents$,
  zeroActivityStepSearch$,
  setZeroActivityStepSearch$,
  formatLogTime,
  formatDuration,
  currentRunId$,
} from "../../signals/activity-page/activity-signals.ts";
import {
  groupEventsIntoMessages,
  groupedMessageMatchesSearch,
  type GroupedMessage,
} from "./components/log-views/log-detail-utils.ts";
import { GroupedMessageCard } from "./components/log-views/grouped-message-card.tsx";
import { StatusDot } from "./components/log-views/status-dot.tsx";
import { zeroActivityContext$ } from "../../signals/activity-page/activity-context-signals.ts";
import {
  zeroActivityNetworkLogs$,
  loadNetworkLogsNextPage$,
} from "../../signals/activity-page/activity-network-signals.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ContextContent } from "./components/context-content.tsx";
import { NetworkContent } from "./components/network-content.tsx";
import { Markdown } from "../components/markdown.tsx";
import { ZeroNoPermissionIllustration } from "./components/zero-no-permission-illustration.tsx";

// ---------------------------------------------------------------------------
// Error Banner
// ---------------------------------------------------------------------------

function getErrorGuidance(error: string) {
  for (const [, guidance] of Object.entries(RUN_ERROR_GUIDANCE)) {
    if (error.toLowerCase().includes(guidance.title.toLowerCase())) {
      return guidance;
    }
  }
  return null;
}

function RunErrorBanner({ error }: { error: string }) {
  const guidance = getErrorGuidance(error);
  if (guidance) {
    return (
      <div className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
        <div className="font-medium">{guidance.title}</div>
        <div className="mt-1 text-destructive/80">{guidance.guidance}</div>
        {guidance.cliHint && (
          <div className="mt-1 font-mono text-xs text-destructive/60">
            $ {guidance.cliHint}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive break-words whitespace-pre-wrap">
      {error}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Returns true if a grouped message should be shown (filters out text-only
 * assistant messages immediately before a result message).
 */
export function isVisibleMessage(
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
      pathname="/activities"
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground transition-colors no-underline text-inherit"
    >
      <IconChartLine size={14} stroke={1.5} className="shrink-0" />
      Activity
    </Link>
  );
}

function ActivityNotFound() {
  const features = useLastResolved(featureSwitch$);
  return (
    <div className="h-full flex flex-col min-h-0">
      <nav className="hidden md:flex shrink-0 items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
        {features?.[FeatureSwitchKey.ActivityLogList] && (
          <>
            <ActivityBreadcrumbLink />
            <span className="text-muted-foreground/40 select-none">/</span>
          </>
        )}
        <span className="rounded-md px-1.5 py-0.5 text-foreground font-medium">
          Log
        </span>
      </nav>
      <div className="flex-1 flex flex-col items-center justify-center gap-3 pb-20">
        <ZeroNoPermissionIllustration />
        <h2 className="text-lg font-semibold text-foreground">Log not found</h2>
        <p className="text-sm text-muted-foreground text-center max-w-sm">
          This log doesn&apos;t exist or you don&apos;t have permission to view
          it in the current workspace.
        </p>
        <Link
          pathname="/activities"
          className="zero-btn-morandi mt-2 inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium no-underline text-inherit hover:bg-accent"
        >
          Back to activity
        </Link>
      </div>
    </div>
  );
}

export function ActivityHeaderCard({
  displayName,
  status,
  triggerSource,
  triggerAgentName,
  detail,
  logDetail,
  duration,
  time,
  events,
  showModelDetail,
  onDownload,
}: {
  displayName: string;
  status: LogStatus;
  triggerSource: TriggerSource | null;
  triggerAgentName: string | null;
  detail: {
    id: string;
    modelProvider?: string | null;
    selectedModel?: string | null;
    framework?: string | null;
    error?: string | null;
    scheduleId?: string | null;
  };
  logDetail?: LogDetail;
  duration: string | null | undefined;
  time: string;
  events: AgentEvent[];
  showModelDetail: boolean;
  onDownload?: () => void;
}) {
  return (
    <div className="zero-card shrink-0 px-4 py-3">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold tracking-tight text-foreground truncate min-w-0 flex-1">
            {displayName}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-y-1 text-sm">
          <div className="flex items-center gap-1.5 pr-3">
            <span className="text-muted-foreground shrink-0">Status</span>
            <StatusBadge status={status} zeroStyle />
          </div>
          <span
            className="w-px h-3.5 shrink-0 bg-border self-center"
            aria-hidden
          />
          {triggerSource && (
            <>
              <div className="flex items-center gap-1.5 px-3">
                <span className="text-muted-foreground shrink-0">Source</span>
                {triggerSource === "schedule" && detail.scheduleId ? (
                  <Link
                    pathname="/schedules/:scheduleId"
                    options={{
                      pathParams: { scheduleId: detail.scheduleId },
                    }}
                    className="text-foreground whitespace-nowrap underline decoration-foreground/40 hover:decoration-foreground transition-colors"
                  >
                    {TRIGGER_SOURCE_LABELS[triggerSource]}
                  </Link>
                ) : (
                  <span className="text-foreground whitespace-nowrap">
                    {getTriggerSourceLabel(triggerSource, triggerAgentName)}
                  </span>
                )}
              </div>
              <span
                className="w-px h-3.5 shrink-0 bg-border self-center"
                aria-hidden
              />
            </>
          )}
          {(detail.modelProvider || detail.framework) && (
            <>
              <div className="flex items-center gap-1.5 px-3">
                <span className="text-muted-foreground shrink-0">Model</span>
                {showModelDetail && detail.selectedModel ? (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-foreground whitespace-nowrap cursor-default">
                          {detail.selectedModel}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {detail.selectedModel} provided by{" "}
                        {detail.modelProvider
                          ? (MODEL_PROVIDER_TYPES[
                              detail.modelProvider as ModelProviderType
                            ]?.label ?? detail.modelProvider)
                          : detail.framework}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  <span className="text-foreground whitespace-nowrap">
                    {detail.modelProvider
                      ? (MODEL_PROVIDER_TYPES[
                          detail.modelProvider as ModelProviderType
                        ]?.label ?? detail.modelProvider)
                      : detail.framework}
                  </span>
                )}
              </div>
              <span
                className="w-px h-3.5 shrink-0 bg-border self-center"
                aria-hidden
              />
            </>
          )}
          <div className="flex items-center gap-1.5 px-3">
            <span className="text-muted-foreground shrink-0">Duration</span>
            <span className="text-foreground whitespace-nowrap">
              {duration ?? "—"}
            </span>
          </div>
          <span
            className="w-px h-3.5 shrink-0 bg-border self-center"
            aria-hidden
          />
          <div className="flex items-center gap-1.5 px-3">
            <span className="text-muted-foreground shrink-0">Time</span>
            <span className="text-foreground whitespace-nowrap">{time}</span>
          </div>
          {(logDetail || onDownload) && (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Download raw data"
                    className="h-7 w-7 ml-auto shrink-0 rounded-lg text-muted-foreground hover:text-foreground p-0"
                    onClick={() => {
                      if (onDownload) {
                        onDownload();
                      } else if (logDetail) {
                        downloadJson(events, detail.id, logDetail);
                      }
                    }}
                  >
                    <IconDownload size={14} stroke={1.5} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">
                  <p className="text-xs">Download raw data</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </div>
      {detail.error && status === "failed" && (
        <RunErrorBanner error={detail.error} />
      )}
    </div>
  );
}

function prepareRenderData(
  detail: { prompt: string | null; appendSystemPrompt: string | null },
  rawEvents: AgentEvent[] | null,
  stepSearch: string,
  features: Record<FeatureSwitchKey, boolean> | undefined,
) {
  const events: AgentEvent[] = rawEvents ?? [];
  const allMessages = groupEventsIntoMessages(events);
  const visibleMessages = allMessages.filter((message, index) => {
    return isVisibleMessage(message, allMessages[index + 1]);
  });
  const messages = visibleMessages.filter((m) => {
    return groupedMessageMatchesSearch(m, stepSearch.trim());
  });
  const showModelDetail = features?.[FeatureSwitchKey.ModelDetail] ?? false;
  const prompt = detail.prompt ?? "";
  const appendSystemPrompt = detail.appendSystemPrompt ?? "";
  const showSystemPrompt =
    (features?.[FeatureSwitchKey.ShowSystemPrompt] ?? false) &&
    appendSystemPrompt.trim().length > 0;
  return {
    events,
    visibleMessages,
    messages,
    showModelDetail,
    prompt,
    appendSystemPrompt,
    showSystemPrompt,
  };
}

function resolveDisplayName(
  detail: { displayName: string | null; agentId: string | null } | null,
  isStale: boolean,
): string {
  if (!detail || isStale) {
    return "Agent";
  }
  return detail.displayName ?? detail.agentId ?? "Agent";
}

type ActivityTab = "steps" | "context" | "network";

function ActivityStepsContent({
  detail,
  eventsData,
  features,
}: {
  detail: LogDetail;
  eventsData: AgentEvent[];
  features: Record<FeatureSwitchKey, boolean> | undefined;
}) {
  const stepSearch = useGet(zeroActivityStepSearch$);
  const setStepSearch = useSet(setZeroActivityStepSearch$);
  const {
    visibleMessages,
    messages,
    prompt,
    showSystemPrompt,
    appendSystemPrompt,
  } = prepareRenderData(detail, eventsData, stepSearch, features);

  return (
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
          <div className="relative flex-1 sm:flex-none sm:w-44">
            <IconSearch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search steps"
              value={stepSearch}
              onChange={(e) => {
                return setStepSearch(e.target.value);
              }}
              className="pl-9"
            />
          </div>
        </div>
      </div>

      <StepsList
        prompt={prompt}
        appendSystemPrompt={showSystemPrompt ? appendSystemPrompt : ""}
        messages={messages}
        stepSearch={stepSearch}
        isLoading={false}
      />
    </div>
  );
}

function ActivityContextTab() {
  const contextLoadable = useLastLoadable(zeroActivityContext$);

  if (
    contextLoadable.state === "loading" ||
    contextLoadable.state === "hasError"
  ) {
    return (
      <div className="flex flex-col gap-2 py-4">
        {["prompt", "system-prompt", "environment"].map((section) => {
          return (
            <div key={section} className="flex flex-col gap-2">
              <div className="h-4 w-24 rounded bg-muted/50 animate-pulse" />
              <div className="h-20 w-full rounded bg-muted/50 animate-pulse" />
            </div>
          );
        })}
      </div>
    );
  }

  const context = contextLoadable.data;
  if (!context) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12">
        <h2 className="text-lg font-semibold text-foreground">
          Context not available
        </h2>
        <p className="text-sm text-muted-foreground text-center max-w-sm">
          Execution context is not available for this run. It may be an older
          run created before context snapshots were enabled.
        </p>
      </div>
    );
  }

  return <ContextContent context={context} />;
}

function ActivityNetworkTab() {
  const logsLoadable = useLastLoadable(zeroActivityNetworkLogs$);
  const loadNextPage = useSet(loadNetworkLogsNextPage$);
  const pageSignal = useGet(pageSignal$);

  if (logsLoadable.state === "loading" || logsLoadable.state === "hasError") {
    return (
      <div className="flex flex-col gap-2 py-4">
        {Array.from({ length: 5 }, (_, i) => {
          return (
            <div
              key={i}
              className="h-8 w-full rounded bg-muted/50 animate-pulse"
            />
          );
        })}
      </div>
    );
  }

  const data = logsLoadable.data;
  if (!data || data.networkLogs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12">
        <h2 className="text-lg font-semibold text-foreground">
          No network logs
        </h2>
        <p className="text-sm text-muted-foreground text-center max-w-sm">
          No network traffic was recorded for this run.
        </p>
      </div>
    );
  }

  const handleLoadMore = () => {
    detach(loadNextPage(pageSignal), Reason.DomCallback);
  };

  return (
    <NetworkContent
      networkLogs={data.networkLogs}
      hasMore={data.hasMore}
      loading={data.loading}
      onLoadMore={handleLoadMore}
    />
  );
}

function ActivityDetailContent({
  detail,
  displayName,
  eventsData,
  features,
}: {
  detail: LogDetail;
  displayName: string;
  eventsData: AgentEvent[];
  features: Record<FeatureSwitchKey, boolean> | undefined;
}) {
  const params = useGet(searchParams$);
  const updateParams = useSet(updateSearchParams$);
  const rawTab = params.get("tab");
  const activeTab: ActivityTab =
    rawTab === "context" || rawTab === "network" ? rawTab : "steps";
  const setActiveTab = (tab: ActivityTab) => {
    const next = new URLSearchParams(params);
    if (tab === "steps") {
      next.delete("tab");
    } else {
      next.set("tab", tab);
    }
    void updateParams(next);
  };
  const fetchExtra = useSet(fetchDownloadExtra$);
  const pageSignal = useGet(pageSignal$);

  const events: AgentEvent[] = eventsData;
  const { showModelDetail } = prepareRenderData(
    detail,
    eventsData,
    "",
    features,
  );
  const status: LogStatus = detail.status;
  const time = formatLogTime(detail.createdAt);
  const duration = formatDuration(detail.startedAt, detail.completedAt);

  const showDebugTabs = features?.[FeatureSwitchKey.ZeroDebug] ?? false;

  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden">
      <div className="flex-1 flex flex-col min-h-0 overflow-auto">
        <nav className="hidden md:flex shrink-0 items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
          {features?.[FeatureSwitchKey.ActivityLogList] && (
            <>
              <ActivityBreadcrumbLink />
              <span className="text-muted-foreground/40 select-none">/</span>
            </>
          )}
          <span className="rounded-md px-1.5 py-0.5 text-foreground font-medium truncate">
            {displayName}
          </span>
        </nav>
        <div className="mx-auto w-full max-w-[900px] px-4 sm:px-6 pt-4 pb-8">
          <ActivityHeaderCard
            displayName={displayName}
            status={status}
            triggerSource={detail.triggerSource ?? null}
            triggerAgentName={detail.triggerAgentName ?? null}
            detail={detail}
            logDetail={detail}
            duration={duration}
            time={time}
            events={events}
            showModelDetail={showModelDetail}
            onDownload={() => {
              void fetchExtra(detail.id, pageSignal).then(
                (extra) => {
                  downloadJson(events, detail.id, detail, extra);
                },
                () => {},
              );
            }}
          />

          {showDebugTabs && (
            <div className="mt-4">
              <Tabs
                value={activeTab}
                onValueChange={(v) => {
                  setActiveTab(v as ActivityTab);
                }}
              >
                <TabsList>
                  <TabsTrigger value="steps">Steps</TabsTrigger>
                  <TabsTrigger value="context">Context</TabsTrigger>
                  <TabsTrigger value="network">Network</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          )}

          <div className="mt-6">
            {activeTab === "steps" && (
              <ActivityStepsContent
                detail={detail}
                eventsData={eventsData}
                features={features}
              />
            )}
            {activeTab === "context" && <ActivityContextTab />}
            {activeTab === "network" && <ActivityNetworkTab />}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ZeroActivityDetailPage() {
  const currentRunId = useGet(currentRunId$);
  const detailLoadable = useLastLoadable(zeroActivityDetail$);
  const eventsLoadable = useLastLoadable(zeroActivityEvents$);
  // Resolve agent display name from the detail response
  const detail =
    detailLoadable.state === "hasData" ? detailLoadable.data : null;
  // Detect stale detail from previous navigation (useLastLoadable keeps old data)
  const isStale = detail !== null && detail.id !== currentRunId;
  const displayName = resolveDisplayName(detail, isStale);

  const features = useLastResolved(featureSwitch$);

  // Skeleton until both detail and initial events are loaded.
  // Events signal returns null when the run loop hasn't been set up yet;
  // useLastLoadable would keep the stale null as "hasData" which correctly
  // prevents the page from rendering with an empty steps list.
  const eventsReady =
    eventsLoadable.state === "hasData" && eventsLoadable.data !== null;
  if (!detail || isStale || !eventsReady) {
    if (detailLoadable.state === "hasError") {
      return <ActivityNotFound />;
    }
    return <ActivitySkeleton />;
  }

  return (
    <ActivityDetailContent
      detail={detail}
      displayName={displayName}
      eventsData={eventsLoadable.data ?? []}
      features={features}
    />
  );
}

function ActivitySkeleton() {
  const features = useLastResolved(featureSwitch$);
  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden">
      <div className="flex-1 flex flex-col min-h-0 overflow-auto">
        <nav className="hidden md:flex shrink-0 items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
          {features?.[FeatureSwitchKey.ActivityLogList] && (
            <>
              <ActivityBreadcrumbLink />
              <span className="text-muted-foreground/40 select-none">/</span>
            </>
          )}
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
              {["sk-1", "sk-2", "sk-3"].map((id) => {
                return (
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
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function StepsList({
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
        messages.map((message, index) => {
          return (
            <GroupedMessageCard
              key={`${message.type}-${message.sequenceNumber}-${message.createdAt}`}
              message={message}
              searchTerm={stepSearch}
              showConnector={index < messages.length - 1}
            />
          );
        })
      )}
    </div>
  );
}

function downloadJson(
  events: AgentEvent[],
  logId: string,
  detail: LogDetail,
  extra?: { context?: unknown; networkLogs?: unknown },
) {
  const data: Record<string, unknown> = {
    meta: {
      id: detail.id,
      displayName: detail.displayName,
      status: detail.status,
      triggerSource: detail.triggerSource,
      triggerAgentName: detail.triggerAgentName,
      modelProvider: detail.modelProvider,
      selectedModel: detail.selectedModel,
      framework: detail.framework,
      prompt: detail.prompt,
      appendSystemPrompt: detail.appendSystemPrompt,
      error: detail.error,
      createdAt: detail.createdAt,
      startedAt: detail.startedAt,
      completedAt: detail.completedAt,
      agentId: detail.agentId,
      sessionId: detail.sessionId,
      scheduleId: detail.scheduleId,
    },
    events,
  };
  if (extra?.context) {
    data.context = extra.context;
  }
  if (extra?.networkLogs) {
    data.networkLogs = extra.networkLogs;
  }
  const json = JSON.stringify(data);
  const blob = new Blob([json], { type: "application/json;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${logId}-logs.json`;
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
  const first =
    lines
      .find((l) => {
        return l.trim().length > 0;
      })
      ?.trim() ?? "";
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
