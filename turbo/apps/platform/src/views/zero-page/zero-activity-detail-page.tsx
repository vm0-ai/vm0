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
import { useTranslation } from "react-i18next";
import {
  MODEL_PROVIDER_TYPES,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import { RUN_ERROR_GUIDANCE } from "@vm0/api-contracts/contracts/errors";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { fetchDownloadExtra$ } from "../../signals/activity-page/activity-download.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { searchParams$, updateSearchParams$ } from "../../signals/route.ts";
import { Link } from "../router/link.tsx";
import {
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
  zeroActivityVisibleGroups$,
  zeroActivityStepSearch$,
  setZeroActivityStepSearch$,
  formatLogTime,
  formatDuration,
  currentRunId$,
} from "../../signals/activity-page/activity-signals.ts";
import {
  eventGroupKey,
  eventGroupMatchesSearch,
  type EventGroup,
} from "./components/log-views/log-detail-utils.ts";
import { EventGroupCard } from "./components/log-views/event-group-card.tsx";
import { StatusDot } from "./components/log-views/status-dot.tsx";
import { zeroActivityContext$ } from "../../signals/activity-page/activity-context-signals.ts";
import { zeroActivityRunner$ } from "../../signals/activity-page/activity-runner-signals.ts";
import {
  zeroActivityNetworkLogs$,
  loadNetworkLogsNextPage$,
} from "../../signals/activity-page/activity-network-signals.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { setActivityDetailScrollContainer$ } from "../../signals/activity-page/activity-detail-scroll.ts";
import { ContextContent } from "./components/context-content.tsx";
import { NetworkContent } from "./components/network-content.tsx";
import { Markdown } from "../components/markdown.tsx";
import { ZeroNoPermissionIllustration } from "./components/zero-no-permission-illustration.tsx";
import { formatAppNumber } from "../../i18n/format.ts";

// ---------------------------------------------------------------------------
// Error Banner
// ---------------------------------------------------------------------------

function getErrorGuidance(error: string) {
  for (const [code, guidance] of Object.entries(RUN_ERROR_GUIDANCE)) {
    if (error.toLowerCase().includes(guidance.title.toLowerCase())) {
      return { code, guidance };
    }
  }
  return null;
}

function RunErrorBanner({ error }: { error: string }) {
  const { t } = useTranslation();
  const match = getErrorGuidance(error);
  if (match) {
    let localized = {
      title: match.guidance.title,
      guidance: match.guidance.guidance,
    };
    switch (match.code) {
      case "COMPUTER_USE_AUTHORIZATION_REQUIRED": {
        localized = {
          title: t(($) => {
            return $.activity.detail.errorGuidance
              .computerUseAuthorizationRequired.title;
          }),
          guidance: t(($) => {
            return $.activity.detail.errorGuidance
              .computerUseAuthorizationRequired.guidance;
          }),
        };
        break;
      }
      case "NO_MODEL_PROVIDER": {
        localized = {
          title: t(($) => {
            return $.activity.detail.errorGuidance.noModelProvider.title;
          }),
          guidance: t(($) => {
            return $.activity.detail.errorGuidance.noModelProvider.guidance;
          }),
        };
        break;
      }
      case "INSUFFICIENT_CREDITS": {
        localized = {
          title: t(($) => {
            return $.activity.detail.errorGuidance.creditsDepleted.title;
          }),
          guidance: t(($) => {
            return $.activity.detail.errorGuidance.creditsDepleted.guidance;
          }),
        };
        break;
      }
      case "PRO_REQUIRED": {
        localized = {
          title: t(($) => {
            return $.activity.detail.errorGuidance.paidPlanRequired.title;
          }),
          guidance: t(($) => {
            return $.activity.detail.errorGuidance.paidPlanRequired.guidance;
          }),
        };
        break;
      }
      case "PROVIDER_INCOMPATIBLE": {
        localized = {
          title: t(($) => {
            return $.activity.detail.errorGuidance.providerIncompatible.title;
          }),
          guidance: t(($) => {
            return $.activity.detail.errorGuidance.providerIncompatible
              .guidance;
          }),
        };
        break;
      }
      case "PROVIDER_UNAVAILABLE": {
        localized = {
          title: t(($) => {
            return $.activity.detail.errorGuidance
              .providerTemporarilyUnavailable.title;
          }),
          guidance: t(($) => {
            return $.activity.detail.errorGuidance
              .providerTemporarilyUnavailable.guidance;
          }),
        };
        break;
      }
      case "PROVIDER_DELETED": {
        localized = {
          title: t(($) => {
            return $.activity.detail.errorGuidance.modelProviderUnavailable
              .title;
          }),
          guidance: t(($) => {
            return $.activity.detail.errorGuidance.modelProviderUnavailable
              .guidance;
          }),
        };
        break;
      }
      case "TOO_MANY_REQUESTS": {
        localized = {
          title: t(($) => {
            return $.activity.detail.errorGuidance.concurrentRunLimitReached
              .title;
          }),
          guidance: t(($) => {
            return $.activity.detail.errorGuidance.concurrentRunLimitReached
              .guidance;
          }),
        };
        break;
      }
    }
    return (
      <div className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
        <div className="font-medium">{localized.title}</div>
        <div className="mt-1 text-destructive/80">{localized.guidance}</div>
        {match.guidance.cliHint && (
          <div className="mt-1 font-mono text-xs text-destructive/60">
            $ {match.guidance.cliHint}
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

function ActivityBreadcrumbLink() {
  const { t } = useTranslation();
  return (
    <Link
      pathname="/activities"
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground transition-colors no-underline text-inherit"
    >
      <IconChartLine size={14} stroke={1.5} className="shrink-0" />
      {t(($) => {
        return $.activity.detail.activity;
      })}
    </Link>
  );
}

function ActivityNotFound() {
  const { t } = useTranslation();
  const features = useLastResolved(featureSwitch$);
  return (
    <div className="h-full flex flex-col min-h-0">
      <nav className="hidden md:flex shrink-0 items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
        {features?.[FeatureSwitchKey.ZeroDebug] && (
          <>
            <ActivityBreadcrumbLink />
            <span className="text-muted-foreground/40 select-none">/</span>
          </>
        )}
        <span className="rounded-md px-1.5 py-0.5 text-foreground font-medium">
          {t(($) => {
            return $.activity.detail.log;
          })}
        </span>
      </nav>
      <div className="flex-1 flex flex-col items-center justify-center gap-3 pb-20">
        <ZeroNoPermissionIllustration />
        <h2 className="text-lg font-semibold text-foreground">
          {t(($) => {
            return $.activity.detail.notFound.title;
          })}
        </h2>
        <p className="text-sm text-muted-foreground text-center max-w-sm">
          {t(($) => {
            return $.activity.detail.notFound.description;
          })}
        </p>
        <Link
          pathname="/activities"
          className="zero-btn-morandi mt-2 inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium no-underline text-inherit hover:bg-accent"
        >
          {t(($) => {
            return $.activity.detail.notFound.back;
          })}
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
  };
  logDetail?: LogDetail;
  duration: string | null | undefined;
  time: string;
  events: AgentEvent[];
  showModelDetail: boolean;
  onDownload?: () => void;
}) {
  const { t } = useTranslation();
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
            <span className="text-muted-foreground shrink-0">
              {t(($) => {
                return $.activity.detail.fields.status;
              })}
            </span>
            <StatusBadge status={status} zeroStyle />
          </div>
          <span
            className="w-px h-3.5 shrink-0 bg-border self-center"
            aria-hidden
          />
          {triggerSource && (
            <>
              <div className="flex items-center gap-1.5 px-3">
                <span className="text-muted-foreground shrink-0">
                  {t(($) => {
                    return $.activity.detail.fields.source;
                  })}
                </span>
                <span className="text-foreground whitespace-nowrap">
                  {getTriggerSourceLabel(triggerSource, triggerAgentName)}
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
              <div className="flex items-center gap-1.5 px-3">
                <span className="text-muted-foreground shrink-0">
                  {t(($) => {
                    return $.activity.detail.fields.model;
                  })}
                </span>
                {showModelDetail && detail.selectedModel ? (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-foreground whitespace-nowrap cursor-default">
                          {detail.selectedModel}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {t(
                          ($) => {
                            return $.activity.detail.modelProvidedBy;
                          },
                          {
                            model: detail.selectedModel,
                            provider: detail.modelProvider
                              ? (MODEL_PROVIDER_TYPES[
                                  detail.modelProvider as ModelProviderType
                                ]?.label ?? detail.modelProvider)
                              : detail.framework,
                          },
                        )}
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
            <span className="text-muted-foreground shrink-0">
              {t(($) => {
                return $.activity.detail.fields.duration;
              })}
            </span>
            <span className="text-foreground whitespace-nowrap">
              {duration ?? "—"}
            </span>
          </div>
          <span
            className="w-px h-3.5 shrink-0 bg-border self-center"
            aria-hidden
          />
          <div className="flex items-center gap-1.5 px-3">
            <span className="text-muted-foreground shrink-0">
              {t(($) => {
                return $.activity.detail.fields.time;
              })}
            </span>
            <span className="text-foreground whitespace-nowrap">{time}</span>
          </div>
          <div className="ml-auto flex items-center gap-1 shrink-0">
            {(logDetail || onDownload) && (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t(($) => {
                        return $.activity.detail.downloadRawData;
                      })}
                      className="h-7 w-7 shrink-0 rounded-lg text-muted-foreground hover:text-foreground p-0"
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
                    <p className="text-xs">
                      {t(($) => {
                        return $.activity.detail.downloadRawData;
                      })}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>
      </div>
      {detail.error && status === "failed" && (
        <RunErrorBanner error={detail.error} />
      )}
    </div>
  );
}

function prepareRenderData(
  detail: {
    prompt: string | null;
    appendSystemPrompt: string | null;
    framework: string | null;
  },
  features: Record<FeatureSwitchKey, boolean> | undefined,
) {
  const showModelDetail = true;
  const prompt = detail.prompt ?? "";
  const appendSystemPrompt = detail.appendSystemPrompt ?? "";
  const showSystemPrompt =
    (features?.[FeatureSwitchKey.ZeroDebug] ?? false) &&
    appendSystemPrompt.trim().length > 0;
  return {
    showModelDetail,
    prompt,
    appendSystemPrompt,
    showSystemPrompt,
  };
}

function resolveDisplayName(
  detail: { displayName: string | null; agentId: string | null } | null,
  isStale: boolean,
  fallback: string,
): string {
  if (!detail || isStale) {
    return fallback;
  }
  return detail.displayName ?? detail.agentId ?? fallback;
}

type ActivityTab = "steps" | "context" | "runner" | "network";

function ActivityStepsContent({
  detail,
  features,
}: {
  detail: LogDetail;
  features: Record<FeatureSwitchKey, boolean> | undefined;
}) {
  const { t } = useTranslation();
  const stepSearch = useGet(zeroActivityStepSearch$);
  const setStepSearch = useSet(setZeroActivityStepSearch$);
  const visibleGroupsLoadable = useLastLoadable(zeroActivityVisibleGroups$);
  const visibleGroupsData =
    visibleGroupsLoadable.state === "hasData" &&
    visibleGroupsLoadable.data.runId === detail.id
      ? visibleGroupsLoadable.data
      : null;
  const visibleGroups =
    visibleGroupsData === null ? [] : visibleGroupsData.groups;
  const visibleGroupsLoading =
    visibleGroupsLoadable.state === "loading" ||
    (visibleGroupsLoadable.state === "hasData" &&
      visibleGroupsLoadable.data.runId !== detail.id);
  const { prompt, showSystemPrompt, appendSystemPrompt } = prepareRenderData(
    detail,
    features,
  );
  const searchTerm = stepSearch.trim();
  const groups = visibleGroups.filter((group) => {
    return eventGroupMatchesSearch(group, searchTerm);
  });

  return (
    <div className="flex flex-col gap-4 pb-8 min-w-0">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="text-base font-medium text-foreground whitespace-nowrap">
            {t(($) => {
              return $.activity.detail.steps.title;
            })}
          </span>
          <span className="text-sm text-muted-foreground whitespace-nowrap">
            {stepSearch.trim()
              ? t(
                  ($) => {
                    return $.activity.detail.steps.matched;
                  },
                  {
                    matched: formatAppNumber(groups.length),
                    total: formatAppNumber(visibleGroups.length),
                  },
                )
              : t(
                  ($) => {
                    return $.activity.detail.steps.total;
                  },
                  { total: formatAppNumber(visibleGroups.length) },
                )}
          </span>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="relative flex-1 sm:flex-none sm:w-44">
            <IconSearch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t(($) => {
                return $.activity.detail.steps.search;
              })}
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
        groups={groups}
        stepSearch={stepSearch}
        isLoading={visibleGroupsLoading}
        startedAt={detail.startedAt}
      />
    </div>
  );
}

function ActivityContextTab({ detailId }: { detailId: string }) {
  const { t } = useTranslation();
  const contextLoadable = useLastLoadable(zeroActivityContext$);

  if (
    contextLoadable.state === "loading" ||
    contextLoadable.state === "hasError" ||
    (contextLoadable.state === "hasData" &&
      contextLoadable.data?.runId !== detailId)
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

  const context = contextLoadable.data?.context ?? null;
  if (!context) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12">
        <h2 className="text-lg font-semibold text-foreground">
          {t(($) => {
            return $.activity.detail.contextUnavailable.title;
          })}
        </h2>
        <p className="text-sm text-muted-foreground text-center max-w-sm">
          {t(($) => {
            return $.activity.detail.contextUnavailable.description;
          })}
        </p>
      </div>
    );
  }

  return <ContextContent context={context} />;
}

function ActivityRunnerTab({ detailId }: { detailId: string }) {
  const { t } = useTranslation();
  const runnerLoadable = useLastLoadable(zeroActivityRunner$);

  if (
    runnerLoadable.state === "loading" ||
    runnerLoadable.state === "hasError" ||
    (runnerLoadable.state === "hasData" &&
      runnerLoadable.data?.runId !== detailId)
  ) {
    return (
      <div className="flex flex-col gap-2 py-4">
        <div className="h-4 w-24 rounded bg-muted/50 animate-pulse" />
        <div className="h-8 w-64 rounded bg-muted/50 animate-pulse" />
      </div>
    );
  }

  const runner = runnerLoadable.data?.runner ?? null;
  const reuse = runner?.sandboxReuseResult ?? null;
  const notReused = t(($) => {
    return $.activity.detail.runner.notReused;
  });
  const info = (() => {
    switch (reuse) {
      case "reused": {
        return {
          label: t(($) => {
            return $.activity.detail.runner.reused;
          }),
          description: t(($) => {
            return $.activity.detail.runner.reusedDescription;
          }),
        };
      }
      case "featureDisabled": {
        return {
          label: notReused,
          description: t(($) => {
            return $.activity.detail.runner.featureDisabled;
          }),
        };
      }
      case "noSessionId": {
        return {
          label: notReused,
          description: t(($) => {
            return $.activity.detail.runner.noSessionId;
          }),
        };
      }
      case "noReuseKey": {
        return {
          label: notReused,
          description: t(($) => {
            return $.activity.detail.runner.noReuseKey;
          }),
        };
      }
      case "invalidResumeSessionId": {
        return {
          label: notReused,
          description: t(($) => {
            return $.activity.detail.runner.invalidResumeSessionId;
          }),
        };
      }
      case "poolMiss": {
        return {
          label: notReused,
          description: t(($) => {
            return $.activity.detail.runner.poolMiss;
          }),
        };
      }
      case "profileMismatch": {
        return {
          label: notReused,
          description: t(($) => {
            return $.activity.detail.runner.profileMismatch;
          }),
        };
      }
      case "deviceLimitMismatch": {
        return {
          label: notReused,
          description: t(($) => {
            return $.activity.detail.runner.deviceLimitMismatch;
          }),
        };
      }
      case "unparkFailed": {
        return {
          label: notReused,
          description: t(($) => {
            return $.activity.detail.runner.unparkFailed;
          }),
        };
      }
      case null: {
        return null;
      }
    }
  })() satisfies {
    label: string;
    description: string;
  } | null;

  return (
    <div className="flex flex-col gap-6 pb-8">
      <section>
        <h3 className="text-sm font-semibold text-foreground mb-2">
          {t(($) => {
            return $.activity.detail.runner.sandbox;
          })}
        </h3>
        {info ? (
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center rounded-md border bg-muted/50 px-2 py-0.5 text-xs font-medium">
              {info.label}
            </span>
            <span className="text-sm text-muted-foreground">
              {info.description}
            </span>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.activity.detail.runner.unknown;
            })}
          </p>
        )}
      </section>
    </div>
  );
}

function ActivityNetworkTab({ detailId }: { detailId: string }) {
  const { t } = useTranslation();
  const logsLoadable = useLastLoadable(zeroActivityNetworkLogs$);
  const loadNextPage = useSet(loadNetworkLogsNextPage$);
  const pageSignal = useGet(pageSignal$);

  if (
    logsLoadable.state === "loading" ||
    logsLoadable.state === "hasError" ||
    (logsLoadable.state === "hasData" && logsLoadable.data.runId !== detailId)
  ) {
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
          {t(($) => {
            return $.activity.detail.networkEmpty.title;
          })}
        </h2>
        <p className="text-sm text-muted-foreground text-center max-w-sm">
          {t(($) => {
            return $.activity.detail.networkEmpty.description;
          })}
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

function ActivityTabContent({
  activeTab,
  detail,
  features,
}: {
  activeTab: ActivityTab;
  detail: LogDetail;
  features: Record<FeatureSwitchKey, boolean> | undefined;
}) {
  if (activeTab === "steps") {
    return <ActivityStepsContent detail={detail} features={features} />;
  }
  if (activeTab === "context") {
    return <ActivityContextTab detailId={detail.id} />;
  }
  if (activeTab === "runner") {
    return <ActivityRunnerTab detailId={detail.id} />;
  }
  return <ActivityNetworkTab detailId={detail.id} />;
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
  const { t } = useTranslation();
  const params = useGet(searchParams$);
  const updateParams = useSet(updateSearchParams$);
  const showDebugTabs = features?.[FeatureSwitchKey.ZeroDebug] ?? false;
  const rawTab = params.get("tab");
  const activeTab: ActivityTab =
    showDebugTabs &&
    (rawTab === "context" || rawTab === "runner" || rawTab === "network")
      ? rawTab
      : "steps";
  const setActiveTab = (tab: ActivityTab) => {
    const next = new URLSearchParams(params);
    if (tab === "steps") {
      next.delete("tab");
    } else {
      next.set("tab", tab);
    }
    detach(updateParams(next), Reason.DomCallback);
  };
  const fetchExtra = useSet(fetchDownloadExtra$);
  const pageSignal = useGet(pageSignal$);
  const setScrollContainer = useSet(setActivityDetailScrollContainer$);

  const events: AgentEvent[] = eventsData;
  const { showModelDetail } = prepareRenderData(detail, features);
  const status: LogStatus = detail.status;
  const time = formatLogTime(detail.createdAt);
  const duration = formatDuration(detail.startedAt, detail.completedAt);

  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden">
      <div
        ref={setScrollContainer}
        className="flex-1 flex flex-col min-h-0 overflow-auto"
      >
        <nav className="hidden md:flex shrink-0 items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
          {features?.[FeatureSwitchKey.ZeroDebug] && (
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
              detach(
                (async () => {
                  const extra = await fetchExtra(detail.id, pageSignal);
                  downloadJson(events, detail.id, detail, extra);
                })(),
                Reason.DomCallback,
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
                  <TabsTrigger value="steps">
                    {t(($) => {
                      return $.activity.detail.tabs.steps;
                    })}
                  </TabsTrigger>
                  <TabsTrigger value="context">
                    {t(($) => {
                      return $.activity.detail.tabs.context;
                    })}
                  </TabsTrigger>
                  <TabsTrigger value="runner">
                    {t(($) => {
                      return $.activity.detail.tabs.runner;
                    })}
                  </TabsTrigger>
                  <TabsTrigger value="network">
                    {t(($) => {
                      return $.activity.detail.tabs.network;
                    })}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          )}

          <div className="mt-6">
            <ActivityTabContent
              activeTab={activeTab}
              detail={detail}
              features={features}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export function ZeroActivityDetailPage() {
  const { t } = useTranslation();
  const currentRunId = useGet(currentRunId$);
  const detailLoadable = useLastLoadable(zeroActivityDetail$);
  const eventsLoadable = useLastLoadable(zeroActivityEvents$);
  // Resolve agent display name from the detail response
  const detail =
    detailLoadable.state === "hasData" ? detailLoadable.data : null;
  // Detect stale detail from previous navigation (useLastLoadable keeps old data)
  const isStale = detail !== null && detail.id !== currentRunId;
  const displayName = resolveDisplayName(
    detail,
    isStale,
    t(($) => {
      return $.activity.detail.fallbackAgent;
    }),
  );

  const features = useLastResolved(featureSwitch$);
  const eventsData =
    eventsLoadable.state === "hasData" &&
    eventsLoadable.data !== null &&
    eventsLoadable.data.runId === currentRunId
      ? eventsLoadable.data.events
      : null;

  // Skeleton until both detail and initial events are loaded for this run.
  // useLastLoadable keeps stale data while refetching, so the events payload
  // carries its run id and must match the current route before rendering.
  if (!detail || isStale || eventsData === null) {
    if (detailLoadable.state === "hasError") {
      return <ActivityNotFound />;
    }
    return <ActivitySkeleton />;
  }

  return (
    <ActivityDetailContent
      detail={detail}
      displayName={displayName}
      eventsData={eventsData}
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
          {features?.[FeatureSwitchKey.ZeroDebug] && (
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
  groups,
  stepSearch,
  isLoading,
  startedAt,
}: {
  prompt: string;
  appendSystemPrompt: string;
  groups: EventGroup[];
  stepSearch: string;
  isLoading: boolean;
  startedAt?: string | null;
}) {
  const { t } = useTranslation();
  const normalizedStepSearch = stepSearch.trim();
  const hasSystemPrompt = appendSystemPrompt.trim().length > 0;
  const hasPrompt = prompt.trim().length > 0;
  const hasContent = hasSystemPrompt || hasPrompt || groups.length > 0;
  return (
    <div className="min-w-0">
      {hasSystemPrompt && (
        <PromptCard
          label={t(($) => {
            return $.activity.detail.steps.systemPrompt;
          })}
          prompt={appendSystemPrompt}
          showConnector={hasPrompt || groups.length > 0}
        />
      )}
      {hasPrompt && (
        <PromptCard
          label={t(($) => {
            return $.activity.detail.steps.userPrompt;
          })}
          prompt={prompt}
          showConnector={groups.length > 0}
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
      ) : groups.length === 0 && !hasContent ? (
        <div className="py-8 text-center text-muted-foreground">
          {t(($) => {
            return $.activity.detail.steps.noEvents;
          })}
        </div>
      ) : (
        groups.map((group, index) => {
          return (
            <EventGroupCard
              key={eventGroupKey(group)}
              group={group}
              searchTerm={normalizedStepSearch}
              showConnector={index < groups.length - 1}
              startedAt={startedAt}
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
  const runtimeFramework = runtimeFrameworkFromContext(extra?.context);
  const data: Record<string, unknown> = {
    meta: {
      id: detail.id,
      displayName: detail.displayName,
      status: detail.status,
      triggerSource: detail.triggerSource,
      triggerAgentName: detail.triggerAgentName,
      modelProvider: detail.modelProvider,
      selectedModel: detail.selectedModel,
      framework: runtimeFramework ?? detail.framework,
      prompt: detail.prompt,
      appendSystemPrompt: detail.appendSystemPrompt,
      error: detail.error,
      createdAt: detail.createdAt,
      startedAt: detail.startedAt,
      completedAt: detail.completedAt,
      agentId: detail.agentId,
      sessionId: detail.sessionId,
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

function runtimeFrameworkFromContext(context: unknown): string | null {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return null;
  }

  const cliAgentType = (context as { readonly cliAgentType?: unknown })
    .cliAgentType;
  return typeof cliAgentType === "string" && cliAgentType.length > 0
    ? cliAgentType
    : null;
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
      !line.startsWith("[file]") &&
      !line.startsWith("[Web file]") &&
      !line.startsWith("[Slack file]") &&
      !line.startsWith("[ID]") &&
      !line.startsWith("[Dimensions]") &&
      !line.startsWith("[URL]")
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
  label,
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
