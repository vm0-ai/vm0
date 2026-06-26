import { useGet, useSet, useLastResolved } from "ccstate-react";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { IconSearch, IconChartLine, IconUpload } from "@tabler/icons-react";
import { Button, Input, Tabs, TabsList, TabsTrigger } from "@vm0/ui";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import type {
  LogStatus,
  TriggerSource,
} from "../../signals/zero-page/log-types.ts";
import {
  formatLogTime,
  formatDuration,
} from "../../signals/activity-page/activity-signals.ts";
import {
  groupEventsIntoMessages,
  groupedMessageMatchesSearch,
} from "../zero-page/components/log-views/log-detail-utils.ts";
import {
  isVisibleMessage,
  ActivityHeaderCard,
  StepsList,
} from "../zero-page/zero-activity-detail-page.tsx";
import {
  inspectLogData$,
  inspectLogLoadError$,
  inspectStepSearch$,
  loadInspectLogFile$,
  setInspectStepSearch$,
  type InspectLogData,
} from "../../signals/activity-page/inspect-log-signals.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { searchParams$, updateSearchParams$ } from "../../signals/route.ts";
import { ContextContent } from "../zero-page/components/context-content.tsx";
import { NetworkContent } from "../zero-page/components/network-content.tsx";
import { Link } from "../router/link.tsx";

type InspectTab = "steps" | "context" | "network";

const LOG_STATUSES = [
  "queued",
  "pending",
  "running",
  "completed",
  "failed",
  "timeout",
  "cancelled",
] as const satisfies readonly LogStatus[];

const TRIGGER_SOURCES = [
  "automation",
  "web",
  "slack",
  "email",
  "telegram",
  "agentphone",
  "github",
  "cli",
  "agent",
  "webhook",
  "workflow-schedule",
  "workflow-event",
] as const satisfies readonly TriggerSource[];

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nullableStringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isLogStatus(value: unknown): value is LogStatus {
  return (
    typeof value === "string" &&
    LOG_STATUSES.some((status) => {
      return status === value;
    })
  );
}

function isTriggerSource(value: unknown): value is TriggerSource {
  return (
    typeof value === "string" &&
    TRIGGER_SOURCES.some((source) => {
      return source === value;
    })
  );
}

function logStatusValue(value: unknown): LogStatus {
  return isLogStatus(value) ? value : "completed";
}

function triggerSourceValue(value: unknown): TriggerSource | null {
  return isTriggerSource(value) ? value : null;
}

function isInspectTab(value: string): value is InspectTab {
  return value === "steps" || value === "context" || value === "network";
}

function InspectBreadcrumb({ title }: { title: string }) {
  return (
    <nav className="hidden md:flex shrink-0 items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
      <Link
        pathname="/activities"
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground transition-colors no-underline text-inherit"
      >
        <IconChartLine size={14} stroke={1.5} className="shrink-0" />
        Activity
      </Link>
      <span className="text-muted-foreground/40 select-none">/</span>
      <span className="rounded-md px-1.5 py-0.5 text-foreground font-medium truncate">
        {title}
      </span>
    </nav>
  );
}

function InspectEmptyState() {
  const loadFile = useSet(loadInspectLogFile$);
  const pageSignal = useGet(pageSignal$);
  const loadError = useGet(inspectLogLoadError$);

  return (
    <div className="h-full flex flex-col min-h-0">
      <InspectBreadcrumb title="Inspect" />
      <div className="flex-1 flex flex-col items-center justify-center gap-3 pb-20">
        <IconUpload size={48} stroke={1} className="text-muted-foreground/40" />
        <h2 className="text-lg font-semibold text-foreground">No log loaded</h2>
        <p className="text-sm text-muted-foreground text-center max-w-sm">
          Upload an activity log JSON file to inspect it.
        </p>
        {loadError && (
          <p className="text-sm text-destructive text-center max-w-sm">
            {loadError}
          </p>
        )}
        <Button variant="outline" asChild>
          <label className="cursor-pointer">
            <IconUpload size={16} stroke={1.5} />
            Upload JSON
            <input
              type="file"
              accept=".json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  detach(loadFile(file, pageSignal), Reason.DomCallback);
                }
                e.target.value = "";
              }}
            />
          </label>
        </Button>
      </div>
    </div>
  );
}

function buildInspectDetail(meta: InspectLogData["meta"]) {
  return {
    id: stringValue(meta?.id) ?? "inspect",
    modelProvider: nullableStringValue(meta?.modelProvider),
    selectedModel: nullableStringValue(meta?.selectedModel),
    framework: nullableStringValue(meta?.framework),
    error: nullableStringValue(meta?.error),
    automationId: nullableStringValue(meta?.automationId),
  };
}

function prepareInspectData(data: InspectLogData) {
  const { meta, events } = data;
  const detail = buildInspectDetail(meta);
  const createdAt = stringValue(meta?.createdAt);

  return {
    events,
    displayName: stringValue(meta?.displayName) ?? "Imported Log",
    status: logStatusValue(meta?.status),
    triggerSource: triggerSourceValue(meta?.triggerSource),
    triggerAgentName: nullableStringValue(meta?.triggerAgentName),
    detail,
    duration: formatDuration(
      nullableStringValue(meta?.startedAt),
      nullableStringValue(meta?.completedAt),
    ),
    time: createdAt ? formatLogTime(createdAt) : "—",
    prompt: stringValue(meta?.prompt) ?? "",
    appendSystemPrompt: stringValue(meta?.appendSystemPrompt) ?? "",
  };
}

function StepsTab({
  prepared,
}: {
  prepared: ReturnType<typeof prepareInspectData>;
}) {
  const stepSearch = useGet(inspectStepSearch$);
  const setStepSearch = useSet(setInspectStepSearch$);
  const { events, prompt, appendSystemPrompt, detail } = prepared;
  const showSystemPrompt = appendSystemPrompt.trim().length > 0;

  const allMessages = groupEventsIntoMessages(events, {
    framework: detail.framework,
  });
  const visibleMessages = allMessages.filter((message, index) => {
    return isVisibleMessage(message, allMessages[index + 1], detail.framework);
  });
  const messages = visibleMessages.filter((m) => {
    return groupedMessageMatchesSearch(m, stepSearch.trim());
  });

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

function InspectMissingPanel({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      <p className="text-sm text-muted-foreground text-center max-w-sm">
        {description}
      </p>
    </div>
  );
}

function InspectContextTab({ data }: { data: InspectLogData }) {
  if (!data.context) {
    return (
      <InspectMissingPanel
        title="Context not available"
        description="Execution context is not available in this imported log."
      />
    );
  }
  return <ContextContent context={data.context} />;
}

function InspectNetworkTab({ data }: { data: InspectLogData }) {
  if (!data.networkLogs) {
    return (
      <InspectMissingPanel
        title="Network logs not available"
        description="Network logs are not available in this imported log."
      />
    );
  }
  return <NetworkContent networkLogs={data.networkLogs} />;
}

function InspectLogContent({ data }: { data: InspectLogData }) {
  const features = useLastResolved(featureSwitch$);
  const showDebugTabs = features?.[FeatureSwitchKey.ZeroDebug] ?? false;

  const params = useGet(searchParams$);
  const updateParams = useSet(updateSearchParams$);
  const rawTab = params.get("tab");
  const activeTab: InspectTab =
    showDebugTabs && (rawTab === "context" || rawTab === "network")
      ? rawTab
      : "steps";
  const setActiveTab = (tab: InspectTab) => {
    const next = new URLSearchParams(params);
    if (tab === "steps") {
      next.delete("tab");
    } else {
      next.set("tab", tab);
    }
    detach(updateParams(next), Reason.DomCallback);
  };

  const prepared = prepareInspectData(data);
  const {
    displayName,
    status,
    triggerSource,
    triggerAgentName,
    detail,
    duration,
    time,
    events,
  } = prepared;

  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden">
      <div className="flex-1 flex flex-col min-h-0 overflow-auto">
        <InspectBreadcrumb title={displayName} />
        <div className="mx-auto w-full max-w-[900px] px-4 sm:px-6 pt-4 pb-8">
          <ActivityHeaderCard
            displayName={displayName}
            status={status}
            triggerSource={triggerSource}
            triggerAgentName={triggerAgentName}
            detail={detail}
            duration={duration}
            time={time}
            events={events}
            showModelDetail={Boolean(detail.selectedModel)}
          />

          {showDebugTabs && (
            <div className="mt-4">
              <Tabs
                value={activeTab}
                onValueChange={(v) => {
                  if (isInspectTab(v)) {
                    setActiveTab(v);
                  }
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
            {activeTab === "steps" && <StepsTab prepared={prepared} />}
            {activeTab === "context" && <InspectContextTab data={data} />}
            {activeTab === "network" && <InspectNetworkTab data={data} />}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ActivityInspectPage() {
  const data = useGet(inspectLogData$);

  if (!data) {
    return <InspectEmptyState />;
  }

  return <InspectLogContent data={data} />;
}
