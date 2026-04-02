import { useState } from "react";
import { useGet } from "ccstate-react";
import { IconSearch, IconChartLine, IconUpload } from "@tabler/icons-react";
import { Input } from "@vm0/ui";
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
  type InspectLogData,
} from "../../signals/activity-page/inspect-log-signals.ts";
import { Link } from "../router/link.tsx";

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
  return (
    <div className="h-full flex flex-col min-h-0">
      <InspectBreadcrumb title="Inspect" />
      <div className="flex-1 flex flex-col items-center justify-center gap-3 pb-20">
        <IconUpload size={48} stroke={1} className="text-muted-foreground/40" />
        <h2 className="text-lg font-semibold text-foreground">No log loaded</h2>
        <p className="text-sm text-muted-foreground text-center max-w-sm">
          Run{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
            _vm0.inspectLogs()
          </code>{" "}
          in the browser console to select a CSV file.
        </p>
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

function InspectLogContent({ data }: { data: InspectLogData }) {
  const [stepSearch, setStepSearch] = useState("");

  const {
    events,
    displayName,
    status,
    triggerSource,
    triggerAgentName,
    detail,
    duration,
    time,
    prompt,
    appendSystemPrompt,
  } = prepareInspectData(data);
  const showSystemPrompt = appendSystemPrompt.trim().length > 0;

  const allMessages = groupEventsIntoMessages(events);
  const visibleMessages = allMessages.filter((message, index) => {
    return isVisibleMessage(message, allMessages[index + 1]);
  });
  const messages = visibleMessages.filter((m) => {
    return groupedMessageMatchesSearch(m, stepSearch.trim());
  });

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
            showContextLink={false}
            showNetworkLink={false}
            showModelDetail={Boolean(detail.selectedModel)}
          />

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
