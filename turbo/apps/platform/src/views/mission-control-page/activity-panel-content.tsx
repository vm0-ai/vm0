import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import { IconSearch } from "@tabler/icons-react";
import { Input } from "@vm0/ui";
import { FeatureSwitchKey } from "@vm0/core";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import type { ActivitySignals } from "../../signals/mission-control-page/create-activity-signals.ts";
import type {
  AgentEvent,
  LogDetail,
} from "../../signals/zero-page/log-types.ts";
import {
  formatLogTime,
  formatDuration,
} from "../../signals/activity-page/activity-signals.ts";
import {
  ActivityHeaderCard,
  StepsList,
  isVisibleMessage,
} from "../zero-page/zero-activity-detail-page.tsx";
import {
  groupEventsIntoMessages,
  groupedMessageMatchesSearch,
} from "../zero-page/components/log-views/log-detail-utils.ts";

function ActivityPanelSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="zero-card shrink-0 px-4 py-3">
        <div className="flex flex-wrap items-center gap-y-2 gap-x-3">
          <div className="h-5 w-28 rounded bg-muted/50 animate-pulse" />
          <span
            className="w-px h-3.5 shrink-0 bg-border self-center"
            aria-hidden
          />
          <div className="h-4 w-20 rounded bg-muted/50 animate-pulse" />
          <div className="h-4 w-16 rounded bg-muted/50 animate-pulse" />
        </div>
      </div>
      <div className="flex flex-col gap-3 px-4">
        {["sk-1", "sk-2", "sk-3"].map((id) => {
          return (
            <div key={id} className="rounded-lg border border-border/40 p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="h-2 w-2 rounded-full bg-muted/50 animate-pulse" />
                <div className="h-4 w-16 rounded bg-muted/50 animate-pulse" />
              </div>
              <div className="h-3 w-full rounded bg-muted/50 animate-pulse" />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function prepareRenderData(
  detail: { prompt: string | null; appendSystemPrompt: string | null },
  rawEvents: AgentEvent[],
  stepSearch: string,
  features: Record<FeatureSwitchKey, boolean> | undefined,
) {
  const allMessages = groupEventsIntoMessages(rawEvents);
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
    visibleMessages,
    messages,
    showModelDetail,
    prompt,
    appendSystemPrompt,
    showSystemPrompt,
  };
}

function ActivityPanelSteps({
  detail,
  eventsData,
  features,
  signals,
}: {
  detail: LogDetail;
  eventsData: AgentEvent[];
  features: Record<FeatureSwitchKey, boolean> | undefined;
  signals: ActivitySignals;
}) {
  const stepSearch = useGet(signals.stepSearch$);
  const setStepSearch = useSet(signals.setStepSearch$);
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

export function ActivityPanelContent({
  signals,
}: {
  signals: ActivitySignals;
}) {
  const detailLoadable = useLastLoadable(signals.detail$);
  const eventsLoadable = useLastLoadable(signals.events$);
  const features = useLastResolved(featureSwitch$);

  const detail =
    detailLoadable.state === "hasData" ? detailLoadable.data : null;
  const eventsReady =
    eventsLoadable.state === "hasData" && eventsLoadable.data !== null;

  if (!detail || !eventsReady) {
    if (detailLoadable.state === "hasError") {
      return (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 p-4">
          <p className="text-sm text-muted-foreground">Activity not found</p>
        </div>
      );
    }
    return <ActivityPanelSkeleton />;
  }

  const displayName = detail.displayName ?? detail.agentId ?? "Agent";
  const status = detail.status;
  const time = formatLogTime(detail.createdAt);
  const duration = formatDuration(detail.startedAt, detail.completedAt);
  const { showModelDetail } = prepareRenderData(
    detail,
    eventsLoadable.data ?? [],
    "",
    features,
  );

  return (
    <div className="h-full flex flex-col min-h-0 overflow-auto">
      <div className="mx-auto w-full max-w-[900px] px-4 pt-4 pb-8">
        <ActivityHeaderCard
          displayName={displayName}
          status={status}
          triggerSource={detail.triggerSource ?? null}
          triggerAgentName={detail.triggerAgentName ?? null}
          detail={detail}
          duration={duration}
          time={time}
          events={eventsLoadable.data ?? []}
          showModelDetail={showModelDetail}
        />
        <div className="mt-6">
          <ActivityPanelSteps
            detail={detail}
            eventsData={eventsLoadable.data ?? []}
            features={features}
            signals={signals}
          />
        </div>
      </div>
    </div>
  );
}
