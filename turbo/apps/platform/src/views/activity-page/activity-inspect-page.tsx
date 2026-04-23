import { useGet, useSet, useLastResolved } from "ccstate-react";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { IconSearch, IconChartLine, IconUpload } from "@tabler/icons-react";
import { Button, Input, Tabs, TabsList, TabsTrigger } from "@vm0/ui";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import type {
  LogStatus,
  TriggerSource,
  AgentEvent,
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

  return (
    <div className="h-full flex flex-col min-h-0">
      <InspectBreadcrumb title="Inspect" />
      <div className="flex-1 flex flex-col items-center justify-center gap-3 pb-20">
        <IconUpload size={48} stroke={1} className="text-muted-foreground/40" />
        <h2 className="text-lg font-semibold text-foreground">No log loaded</h2>
        <p className="text-sm text-muted-foreground text-center max-w-sm">
          Upload an activity log JSON file to inspect it.
        </p>
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
    id: meta?.id ?? "inspect",
    modelProvider: meta?.modelProvider ?? null,
    selectedModel: meta?.selectedModel ?? null,
    framework: meta?.framework ?? null,
    error: meta?.error ?? null,
    scheduleId: meta?.scheduleId ?? null,
  };
}

function prepareInspectData(data: InspectLogData) {
  const { meta, events } = data;
  const detail = buildInspectDetail(meta);

  return {
    events,
    displayName: meta?.displayName ?? "Imported Log",
    status: (meta?.status as LogStatus) ?? ("completed" as const),
    triggerSource: (meta?.triggerSource as TriggerSource) ?? null,
    triggerAgentName: meta?.triggerAgentName ?? null,
    detail,
    duration: formatDuration(
      meta?.startedAt ?? null,
      meta?.completedAt ?? null,
    ),
    time: meta?.createdAt ? formatLogTime(meta.createdAt) : "—",
    prompt: meta?.prompt ?? "",
    appendSystemPrompt: meta?.appendSystemPrompt ?? "",
  };
}

function StepsTab({
  prepared,
}: {
  prepared: ReturnType<typeof prepareInspectData>;
}) {
  const stepSearch = useGet(inspectStepSearch$);
  const setStepSearch = useSet(setInspectStepSearch$);
  const { events, prompt, appendSystemPrompt } = prepared;
  const showSystemPrompt = appendSystemPrompt.trim().length > 0;

  const allMessages = groupEventsIntoMessages(events);
  const visibleMessages = allMessages.filter((message, index) => {
    return isVisibleMessage(message, allMessages[index + 1]);
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

function InspectLogContent({ data }: { data: InspectLogData }) {
  const features = useLastResolved(featureSwitch$);
  const showDebugTabs = features?.[FeatureSwitchKey.ZeroDebug] ?? false;

  const params = useGet(searchParams$);
  const updateParams = useSet(updateSearchParams$);
  const rawTab = params.get("tab");
  const activeTab: InspectTab =
    rawTab === "context" || rawTab === "network" ? rawTab : "steps";
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
            events={events as AgentEvent[]}
            showModelDetail={Boolean(detail.selectedModel)}
          />

          {showDebugTabs && (
            <div className="mt-4">
              <Tabs
                value={activeTab}
                onValueChange={(v) => {
                  setActiveTab(v as InspectTab);
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
            {activeTab === "context" && data.context && (
              <ContextContent context={data.context} />
            )}
            {activeTab === "network" && data.networkLogs && (
              <NetworkContent networkLogs={data.networkLogs} />
            )}
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
