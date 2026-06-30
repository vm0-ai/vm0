import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import type {
  ZeroWorkflowSummary,
  ZeroWorkflowTriggerSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";
import {
  IconArrowUpRight,
  IconBrandGithub,
  IconCalendarTime,
  IconClock,
  IconLink,
  IconLoader2,
  IconMail,
  IconMessageCircle,
  IconPlayerPlay,
  IconPlus,
  IconRepeat,
  IconTag,
} from "@tabler/icons-react";
import { Button, Switch, cn } from "@vm0/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";

import { agents$ } from "../../signals/agent.ts";
import {
  selectedWorkflowAutomationAgentId$,
  setWorkflowAutomationAgentQuery$,
  setWorkflowAutomationDialogOpen$,
  startCreateWorkflowFromAutomationDialog$,
  workflowAutomationAgentSelectionLocked$,
  workflowAutomationAgentQuery$,
  workflowAutomationDialogIntent$,
  workflowAutomationDialogOpen$,
} from "../../signals/automation-page/workflow-trigger-automation-dialog.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import {
  allWorkflowTriggerEntries$,
  allVisibleWorkflows$,
  runWorkflowTriggerNow$,
  setWorkflowTriggerEnabled$,
  WORKFLOW_DETAIL_TAB_PARAM,
  type WorkflowTriggerAutomationEntry,
} from "../../signals/workflows-page/workflows-signals.ts";
import {
  atTimeInTimezone,
  cronWallTimeInTimezone,
} from "../../signals/zero-page/cron.ts";
import { userPreferences$ } from "../../signals/zero-page/settings/user-preferences.ts";
import { pinnedAgentIds$ } from "../../signals/zero-page/zero-pinned-agents.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import {
  AgentDialogAgentButton,
  agentDialogMatchesQuery,
  AgentDialogSearch,
  AgentDialogSection,
} from "./zero-sidebar-dialogs.tsx";
import { AvatarFromUrl } from "./zero-sidebar-shared.tsx";
import {
  agentLabel,
  formatWorkflowIntervalSeconds,
  gmailTriggerSummary,
  gmailTriggerTitle,
  workflowTitle,
} from "../workflows-page/workflow-shared.tsx";
import {
  WorkflowTriggerCard,
  type WorkflowTriggerCardRow,
} from "../workflows-page/workflow-trigger-card.tsx";

export const CREATE_WORKFLOW_WITH_CHAT_PROMPT =
  "Help me create a workflow for this agent. Use the workflow-setup skill, then ask me for the desired outcome, automation, and action before creating the workflow and automation.";

const CREATE_AUTOMATION_CHAT_PROMPT =
  "I'd like to create a workflow automation. Help me define the reusable workflow and decide when it should run automatically. An automation can run on a schedule, every few minutes, when an email arrives, when a Gmail label is applied, from a webhook, from a GitHub label, or when a calendar event is created. Ask what the workflow should do each time it runs, what inputs or sources it should use, what output it should produce, what side effects are allowed, and whether it should be enabled immediately.";

function formatClockTime(hour: number, minute: number): string {
  const ampm = hour >= 12 ? "PM" : "AM";
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${h12}:${String(minute).padStart(2, "0")} ${ampm}`;
}

function formatTriggerDate(
  value: string | null,
  displayTimezone: string,
): string {
  if (!value) {
    return "No runs yet";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "No runs yet";
  }
  return date.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: displayTimezone,
  });
}

function formatNextRun(value: string | null, displayTimezone: string): string {
  if (!value) {
    return "No upcoming run";
  }
  return formatTriggerDate(value, displayTimezone);
}

function cronRuleLabel(
  cronExpression: string,
  sourceTimezone: string,
  displayTimezone: string,
): string {
  const [minutePart, hourPart, dayOfMonth = "*", , dayOfWeek = "*"] =
    cronExpression.split(" ");
  const minute = Number(minutePart);
  const hour = Number(hourPart);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return `${cronExpression} (${sourceTimezone})`;
  }
  const converted = cronWallTimeInTimezone(
    hour,
    minute,
    sourceTimezone,
    displayTimezone,
  );
  const time = formatClockTime(converted.hour, converted.minute);
  if (dayOfMonth !== "*") {
    return `Every month on day ${dayOfMonth} at ${time}`;
  }
  if (dayOfWeek === "1-5") {
    return `Every weekday at ${time}`;
  }
  if (dayOfWeek !== "*") {
    const dayNames: Readonly<Record<string, string>> = {
      "0": "Sunday",
      "1": "Monday",
      "2": "Tuesday",
      "3": "Wednesday",
      "4": "Thursday",
      "5": "Friday",
      "6": "Saturday",
    };
    const days = dayOfWeek
      .split(",")
      .map((day) => {
        return dayNames[day];
      })
      .filter(Boolean)
      .join(", ");
    return days ? `Every week on ${days} at ${time}` : `Every week at ${time}`;
  }
  return `Every day at ${time}`;
}

function legacyTriggerRuleLabel(
  trigger: ZeroWorkflowTriggerSummary,
  displayTimezone: string,
): string {
  if (trigger.kind !== "schedule") {
    return gmailTriggerTitle(trigger);
  }
  const schedule = trigger.schedule;
  if (schedule.type === "loop") {
    return `Every ${formatWorkflowIntervalSeconds(schedule.intervalSeconds)}`;
  }
  if (schedule.type === "once") {
    const { date, hour, minute } = atTimeInTimezone(
      schedule.atTime,
      displayTimezone,
    );
    return `Once on ${date} at ${formatClockTime(hour, minute)}`;
  }
  return cronRuleLabel(
    schedule.cronExpression,
    schedule.timezone,
    displayTimezone,
  );
}

function quote(value: string): string {
  return `"${value}"`;
}

function humanReadableTriggerRuleLabel(
  trigger: ZeroWorkflowTriggerSummary,
  displayTimezone: string,
): string {
  if (trigger.kind === "schedule") {
    const schedule = trigger.schedule;
    if (schedule.type === "loop") {
      return `Every ${formatWorkflowIntervalSeconds(schedule.intervalSeconds)}`;
    }
    if (schedule.type === "once") {
      const { date, hour, minute } = atTimeInTimezone(
        schedule.atTime,
        displayTimezone,
      );
      return `Once on ${date} at ${formatClockTime(hour, minute)}`;
    }
    return cronRuleLabel(
      schedule.cronExpression,
      schedule.timezone,
      displayTimezone,
    );
  }

  if (trigger.eventType === "gmail-new-message") {
    const summary = gmailTriggerSummary(trigger);
    return summary && summary !== "all inbound messages"
      ? `When Gmail message matches ${summary}`
      : "When any Gmail message arrives";
  }
  if (trigger.eventType === "gmail-label-applied") {
    return `When Gmail label ${quote(trigger.eventConfig.labelName)} is applied`;
  }
  if (trigger.eventType === "github-label-applied") {
    return `When GitHub label ${quote(trigger.eventConfig.labelName)} is applied`;
  }
  if (trigger.eventType === "google-calendar-event-created") {
    return `When calendar ${quote(trigger.eventConfig.calendarId)} gets a new event`;
  }
  if (trigger.eventType === "webhook-received") {
    return "When an inbound webhook is received";
  }
  return gmailTriggerTitle(trigger);
}

function triggerTypeLabel(trigger: ZeroWorkflowTriggerSummary): string {
  if (trigger.kind === "schedule") {
    return "Schedule";
  }
  if (
    trigger.eventType === "gmail-new-message" ||
    trigger.eventType === "gmail-label-applied"
  ) {
    return "Gmail";
  }
  if (trigger.eventType === "github-label-applied") {
    return "GitHub";
  }
  if (trigger.eventType === "google-calendar-event-created") {
    return "Google Calendar";
  }
  if (trigger.eventType === "webhook-received") {
    return "Webhook";
  }
  return "Trigger";
}

function triggerRows(
  trigger: ZeroWorkflowTriggerSummary,
  displayTimezone: string,
): readonly WorkflowTriggerCardRow[] {
  const rows: WorkflowTriggerCardRow[] = [
    {
      label: trigger.kind === "schedule" ? "Schedule" : "Trigger",
      value: legacyTriggerRuleLabel(trigger, displayTimezone),
    },
    {
      label: "Last run",
      value: formatTriggerDate(trigger.lastRunAt, displayTimezone),
    },
    {
      label: "Next run",
      value: formatNextRun(trigger.nextRunAt, displayTimezone),
    },
  ];

  const matchSummary = gmailTriggerSummary(trigger);
  if (matchSummary) {
    rows.splice(1, 0, { label: "Match", value: matchSummary });
  }
  if (trigger.kind === "event" && trigger.eventType === "webhook-received") {
    rows.splice(1, 0, { label: "Webhook", value: trigger.webhookUrl });
  }
  return rows;
}

function TriggerCardHeader({
  entry,
}: {
  readonly entry: WorkflowTriggerAutomationEntry;
}) {
  return (
    <div className="mb-2 flex min-w-0 items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="min-w-0 truncate text-sm font-normal leading-snug text-muted-foreground">
          {workflowTitle(entry.workflow)}
        </p>
        <p className="mt-0.5 min-w-0 truncate text-xs text-muted-foreground/80">
          {agentLabel(entry.workflow)}
        </p>
      </div>
      <Link
        pathname={ROUTES.workflowDetail}
        options={{
          pathParams: {
            workflowId: entry.workflow.id,
          },
          searchParams: new URLSearchParams({
            [WORKFLOW_DETAIL_TAB_PARAM]: "automations",
          }),
        }}
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-gray-50 hover:text-foreground"
      >
        View
        <IconArrowUpRight size={12} stroke={1.5} />
      </Link>
    </div>
  );
}

function WorkflowAutomationTriggerCard({
  entry,
  displayTimezone,
}: {
  readonly entry: WorkflowTriggerAutomationEntry;
  readonly displayTimezone: string;
}) {
  const pageSignal = useGet(pageSignal$);
  const [runLoadable, runNow] = useLoadableSet(runWorkflowTriggerNow$);
  const running = runLoadable.state === "loading";
  const editLink = (
    <Link
      pathname={ROUTES.workflowDetail}
      options={{
        pathParams: {
          workflowId: entry.workflow.id,
        },
        searchParams: new URLSearchParams({
          [WORKFLOW_DETAIL_TAB_PARAM]: "automations",
        }),
      }}
      className="rounded-md px-1 py-1 text-sm font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
    >
      Edit
    </Link>
  );

  return (
    <div className="min-w-0">
      <TriggerCardHeader entry={entry} />
      <WorkflowTriggerCard
        rows={triggerRows(entry.trigger, displayTimezone)}
        dimmed={!entry.trigger.enabled}
        actions={
          <>
            {entry.workflow.canManage ? editLink : <span />}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="zero-btn-morandi h-8 shrink-0 gap-1.5 rounded-lg px-3 text-xs font-medium"
              disabled={running}
              onClick={() => {
                detach(
                  runNow(entry.trigger.id, pageSignal),
                  Reason.DomCallback,
                  "run workflow trigger from automations",
                );
              }}
            >
              {running ? (
                <IconLoader2 size={13} className="animate-spin" />
              ) : (
                <IconPlayerPlay size={13} stroke={1.5} />
              )}
              {running ? "Starting..." : "Run now"}
            </Button>
          </>
        }
      />
    </div>
  );
}

function TriggerGridSkeleton() {
  return (
    <div
      className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
      data-testid="workflow-trigger-grid-skeleton"
    >
      {["a", "b", "c"].map((key) => {
        return (
          <div key={key} className="min-w-0">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="grid min-w-0 flex-1 gap-1">
                <Skeleton className="h-4 w-32 rounded-md" />
                <Skeleton className="h-3 w-20 rounded-md" />
              </div>
              <Skeleton className="h-7 w-14 rounded-md" />
            </div>
            <div className="zero-card overflow-hidden">
              <div className="grid gap-0 px-5 py-1">
                <Skeleton className="my-3 h-4 w-full rounded-md" />
                <Skeleton className="my-3 h-4 w-4/5 rounded-md" />
                <Skeleton className="my-3 h-4 w-3/4 rounded-md" />
              </div>
              <div className="flex items-center justify-between px-5 pb-4 pt-2">
                <Skeleton className="h-6 w-10 rounded-md" />
                <Skeleton className="h-8 w-24 rounded-lg" />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TriggerListSkeleton() {
  return (
    <div
      className="flex flex-col gap-2.5"
      data-testid="workflow-trigger-list-skeleton"
    >
      {["a", "b", "c"].map((key) => {
        return (
          <div
            key={key}
            className="zero-card grid min-h-[5.5rem] grid-cols-[2.75rem_minmax(0,1fr)_auto] items-center gap-x-4 px-5 py-4"
          >
            <Skeleton className="row-span-2 h-11 w-11 rounded-xl" />
            <Skeleton className="h-4 w-48 max-w-full rounded-md" />
            <Skeleton className="row-span-2 h-5 w-9 rounded-full" />
            <div className="flex min-w-0 items-center gap-2">
              <Skeleton className="h-5 w-5 rounded-full" />
              <Skeleton className="h-3 w-64 max-w-full rounded-md" />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function agentInitials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`.toUpperCase();
  }
  return (words[0]?.slice(0, 2) || "??").toUpperCase();
}

function WorkflowAgentAvatar({
  agent,
  label,
}: {
  readonly agent: TeamComposeItem | undefined;
  readonly label: string;
}) {
  const className =
    "h-5 w-5 shrink-0 overflow-hidden rounded-full border border-border/60 bg-gray-50 object-cover object-top text-[9px] font-semibold text-muted-foreground";
  if (agent?.avatarUrl) {
    return (
      <AvatarFromUrl
        avatarUrl={agent.avatarUrl}
        alt={label}
        className={className}
        size={20}
      />
    );
  }
  return (
    <span className={cn("inline-flex items-center justify-center", className)}>
      {agentInitials(label)}
    </span>
  );
}

function TriggerListIcon({
  trigger,
}: {
  readonly trigger: ZeroWorkflowTriggerSummary;
}) {
  const Icon = (() => {
    if (trigger.kind === "schedule") {
      if (trigger.schedule.type === "loop") {
        return IconRepeat;
      }
      if (trigger.schedule.type === "once") {
        return IconClock;
      }
      return IconCalendarTime;
    }
    if (trigger.eventType === "webhook-received") {
      return IconLink;
    }
    if (trigger.eventType === "github-label-applied") {
      return IconBrandGithub;
    }
    if (trigger.eventType === "gmail-label-applied") {
      return IconTag;
    }
    return IconMail;
  })();
  const tone =
    trigger.kind === "schedule"
      ? "bg-blue-50 text-blue-600"
      : trigger.eventType === "webhook-received"
        ? "bg-amber-50 text-amber-700"
        : "bg-emerald-50 text-emerald-700";

  return (
    <span
      className={cn(
        "row-span-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border/60",
        tone,
      )}
      aria-hidden="true"
    >
      <Icon size={20} stroke={1.6} />
    </span>
  );
}

function WorkflowTriggerEnabledSwitch({
  entry,
}: {
  readonly entry: WorkflowTriggerAutomationEntry;
}) {
  const pageSignal = useGet(pageSignal$);
  const [enabledLoadable, setEnabled] = useLoadableSet(
    setWorkflowTriggerEnabled$,
  );
  const busy = enabledLoadable.state === "loading";
  const title = workflowTitle(entry.workflow);

  return (
    <Switch
      checked={entry.trigger.enabled}
      disabled={busy || !entry.workflow.canManage}
      aria-label={`${entry.trigger.enabled ? "Disable" : "Enable"} ${title}`}
      className="row-span-2 h-5 w-9 data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted [&>span]:h-4 [&>span]:w-4 [&>span]:data-[state=checked]:translate-x-4"
      onCheckedChange={(enabled) => {
        detach(
          setEnabled({ triggerId: entry.trigger.id, enabled }, pageSignal),
          Reason.DomCallback,
        );
      }}
    />
  );
}

function WorkflowTriggerIndexCard({
  entry,
  displayTimezone,
  agents,
}: {
  readonly entry: WorkflowTriggerAutomationEntry;
  readonly displayTimezone: string;
  readonly agents: readonly TeamComposeItem[];
}) {
  const title = workflowTitle(entry.workflow);
  const label = agentLabel(entry.workflow);
  const agent = agents.find((item) => {
    return item.id === entry.workflow.agentId;
  });

  return (
    <article
      className={cn(
        "zero-card grid min-w-0 grid-cols-[2.75rem_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-5 py-4 transition-colors hover:bg-gray-50",
        !entry.trigger.enabled && "opacity-75",
      )}
    >
      <TriggerListIcon trigger={entry.trigger} />
      <Link
        pathname={ROUTES.automationDetail}
        options={{ pathParams: { automationId: entry.trigger.id } }}
        className="min-w-0 truncate text-sm font-medium text-foreground no-underline underline-offset-4 hover:underline"
      >
        {title}
      </Link>
      <WorkflowTriggerEnabledSwitch entry={entry} />
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm leading-5 text-muted-foreground">
        <WorkflowAgentAvatar agent={agent} label={label} />
        <span className="max-w-[10rem] truncate">{label}</span>
        <span className="select-none text-muted-foreground/50">·</span>
        <span>{triggerTypeLabel(entry.trigger)}</span>
        <span className="select-none text-muted-foreground/50">·</span>
        <span className="min-w-0 font-medium text-foreground/85">
          {humanReadableTriggerRuleLabel(entry.trigger, displayTimezone)}
        </span>
      </div>
    </article>
  );
}

function EmptyTriggers({ onAdd }: { readonly onAdd: () => void }) {
  return (
    <div className="zero-card flex min-h-56 flex-col items-center justify-center px-6 py-10 text-center">
      <p className="text-sm font-medium text-foreground">No triggers yet</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Create a triggered workflow and it will show up here.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="zero-btn-morandi mt-4 h-9 gap-2 rounded-lg border"
        onClick={onAdd}
      >
        <IconPlus size={14} stroke={2} />
        Add automation
      </Button>
    </div>
  );
}

function WorkflowSelectionStep({
  workflows,
  agents,
  loading,
  onSelectWorkflow,
  onCreateWorkflow,
}: {
  readonly workflows: readonly ZeroWorkflowSummary[];
  readonly agents: readonly TeamComposeItem[];
  readonly loading: boolean;
  readonly onSelectWorkflow: (workflow: ZeroWorkflowSummary) => void;
  readonly onCreateWorkflow: () => void;
}) {
  if (loading) {
    return (
      <div className="grid gap-2 px-5 pb-4">
        {["a", "b", "c"].map((key) => {
          return (
            <div
              key={key}
              className="rounded-lg border border-border/60 px-3 py-3"
            >
              <Skeleton className="h-4 w-44 rounded-md" />
              <Skeleton className="mt-2 h-3 w-64 rounded-md" />
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
      <button
        type="button"
        className="mb-3 flex w-full min-w-0 items-start gap-3 rounded-lg border border-border/60 px-3 py-3 text-left transition-colors hover:bg-gray-50"
        onClick={onCreateWorkflow}
      >
        <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-50 text-muted-foreground">
          <IconMessageCircle size={16} stroke={1.6} />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">
            Create in chat
          </span>
          <span className="mt-0.5 block text-sm text-muted-foreground">
            Start from a conversation when no workflow fits yet.
          </span>
        </span>
      </button>

      {workflows.length > 0 ? (
        <div className="grid gap-2">
          {workflows.map((workflow) => {
            const label = agentLabel(workflow);
            const agent = agents.find((item) => {
              return item.id === workflow.agentId;
            });
            return (
              <button
                key={workflow.id}
                type="button"
                className="flex min-w-0 items-start gap-3 rounded-lg border border-border/60 px-3 py-3 text-left transition-colors hover:bg-gray-50"
                onClick={() => {
                  onSelectWorkflow(workflow);
                }}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {workflowTitle(workflow)}
                  </span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
                    <WorkflowAgentAvatar agent={agent} label={label} />
                    <span className="max-w-[10rem] shrink-0 truncate">
                      {label}
                    </span>
                    {workflow.description ? (
                      <>
                        <span className="select-none text-muted-foreground/50">
                          ·
                        </span>
                        <span className="min-w-0 truncate">
                          {workflow.description}
                        </span>
                      </>
                    ) : null}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="px-1 py-2 text-sm text-muted-foreground">
          No workflows yet. Create one in chat to continue.
        </p>
      )}
    </div>
  );
}

function AgentSelectionStep({
  agents,
  onSelectAgent,
}: {
  readonly agents: readonly TeamComposeItem[];
  readonly onSelectAgent: (agentId: string) => void;
}) {
  const query = useGet(workflowAutomationAgentQuery$);
  const setQuery = useSet(setWorkflowAutomationAgentQuery$);
  const pinnedIds = useLastResolved(pinnedAgentIds$) ?? [];
  const pinned = pinnedIds
    .map((id) => {
      return agents.find((agent) => {
        return agent.id === id;
      });
    })
    .filter((agent): agent is TeamComposeItem => {
      return agent !== undefined;
    });
  const unpinned = agents.filter((agent) => {
    return !pinnedIds.includes(agent.id);
  });
  const trimmedQuery = query.trim().toLowerCase();
  const filteredPinned = trimmedQuery
    ? pinned.filter((agent) => {
        return agentDialogMatchesQuery(agent, trimmedQuery);
      })
    : pinned;
  const filteredUnpinned = trimmedQuery
    ? unpinned.filter((agent) => {
        return agentDialogMatchesQuery(agent, trimmedQuery);
      })
    : unpinned;

  if (agents.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <AgentDialogSearch query={query} setQuery={setQuery} />
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
          <p className="px-1 py-2 text-xs text-muted-foreground">
            No agents yet
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AgentDialogSearch query={query} setQuery={setQuery} />
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {filteredPinned.length > 0 ? (
          <AgentDialogSection label="Pinned">
            {filteredPinned.map((agent) => {
              return (
                <div
                  key={agent.id}
                  className="flex items-center gap-2 rounded-lg px-1 py-2 transition-colors hover:bg-accent"
                >
                  <AgentDialogAgentButton
                    agent={agent}
                    onSelect={() => {
                      onSelectAgent(agent.id);
                    }}
                  />
                </div>
              );
            })}
          </AgentDialogSection>
        ) : null}

        {filteredUnpinned.length > 0 ? (
          <AgentDialogSection
            label={filteredPinned.length > 0 ? "Others" : "Agents"}
            className="pb-3"
          >
            {filteredUnpinned.map((agent) => {
              return (
                <div
                  key={agent.id}
                  className="flex items-center gap-2 rounded-lg px-1 py-2 transition-colors hover:bg-accent"
                >
                  <AgentDialogAgentButton
                    agent={agent}
                    onSelect={() => {
                      onSelectAgent(agent.id);
                    }}
                  />
                </div>
              );
            })}
          </AgentDialogSection>
        ) : null}

        {trimmedQuery &&
        filteredPinned.length === 0 &&
        filteredUnpinned.length === 0 ? (
          <div className="px-5 pb-5">
            <p className="px-1 py-2 text-xs text-muted-foreground">
              No agents found
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function WorkflowAutomationDialogFooter({
  onCancel,
}: {
  readonly onCancel: () => void;
}) {
  return (
    <DialogFooter className="shrink-0 border-t border-border/60 bg-card px-5 py-4">
      <Button type="button" variant="outline" onClick={onCancel}>
        Cancel
      </Button>
    </DialogFooter>
  );
}

export function CreateWorkflowAutomationDialog() {
  const agentsLoadable = useLastLoadable(agents$);
  const agents = agentsLoadable.state === "hasData" ? agentsLoadable.data : [];
  const workflowsLoadable = useLastLoadable(allVisibleWorkflows$);
  const workflows =
    workflowsLoadable.state === "hasData" ? workflowsLoadable.data : [];
  const workflowsLoading = workflowsLoadable.state === "loading";
  const open = useGet(workflowAutomationDialogOpen$);
  const setOpen = useSet(setWorkflowAutomationDialogOpen$);
  const intent = useGet(workflowAutomationDialogIntent$);
  const agentSelectionLocked = useGet(workflowAutomationAgentSelectionLocked$);
  const selectedAgentIdState = useGet(selectedWorkflowAutomationAgentId$);
  const startCreateWorkflow = useSet(startCreateWorkflowFromAutomationDialog$);
  const navigate = useSet(detachedNavigateTo$);
  const selectedAgentId = selectedAgentIdState;
  const selectedAgent =
    agents.find((agent) => {
      return agent.id === selectedAgentId;
    }) ?? null;

  const startChatCreation = (agentId: string, prompt: string) => {
    setOpen(false);
    navigate(ROUTES.agentChat, {
      pathParams: { agentId },
      searchParams: new URLSearchParams({ prompt }),
    });
  };

  const selectAgent = (agentId: string) => {
    startChatCreation(
      agentId,
      intent === "automation-chat"
        ? CREATE_AUTOMATION_CHAT_PROMPT
        : CREATE_WORKFLOW_WITH_CHAT_PROMPT,
    );
  };

  const openWorkflowTriggers = (workflow: ZeroWorkflowSummary) => {
    setOpen(false);
    navigate(ROUTES.workflowDetail, {
      pathParams: { workflowId: workflow.id },
      searchParams: new URLSearchParams({
        [WORKFLOW_DETAIL_TAB_PARAM]: "automations",
      }),
    });
  };

  const creatingAutomationInChat = intent === "automation-chat";
  const creatingWorkflow = intent === "workflow";
  const selectingExistingWorkflow = intent === "automation";
  const agentChoices =
    agentSelectionLocked && selectedAgent ? [selectedAgent] : agents;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="zero-app !flex max-h-[min(720px,calc(100dvh-2rem))] w-[calc(100vw-2rem)] !flex-col !overflow-hidden gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="shrink-0 px-5 pb-3 pt-5">
          <DialogTitle className="text-base font-semibold">
            {creatingAutomationInChat
              ? "Create Automation"
              : creatingWorkflow
                ? "Create workflow"
                : "Add automation"}
          </DialogTitle>
          <DialogDescription className="mt-1 text-sm text-muted-foreground">
            {selectingExistingWorkflow
              ? "Choose a workflow to automate, or create one in chat."
              : creatingAutomationInChat
                ? "Choose the agent for this automation"
                : "Choose the agent for this workflow."}
          </DialogDescription>
        </DialogHeader>

        {selectingExistingWorkflow ? (
          <WorkflowSelectionStep
            workflows={workflows}
            agents={agents}
            loading={workflowsLoading}
            onSelectWorkflow={openWorkflowTriggers}
            onCreateWorkflow={startCreateWorkflow}
          />
        ) : (
          <AgentSelectionStep
            agents={agentChoices}
            onSelectAgent={selectAgent}
          />
        )}

        <WorkflowAutomationDialogFooter
          onCancel={() => {
            setOpen(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

export function WorkflowTriggerAutomationList({
  entries,
  displayTimezone,
  loading,
  onAdd,
}: {
  readonly entries: readonly WorkflowTriggerAutomationEntry[];
  readonly displayTimezone: string;
  readonly loading: boolean;
  readonly onAdd: () => void;
}) {
  if (loading) {
    return <TriggerGridSkeleton />;
  }

  if (entries.length === 0) {
    return <EmptyTriggers onAdd={onAdd} />;
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {entries.map((entry) => {
        return (
          <WorkflowAutomationTriggerCard
            key={entry.trigger.id}
            entry={entry}
            displayTimezone={displayTimezone}
          />
        );
      })}
    </div>
  );
}

function WorkflowTriggerAutomationIndexList({
  entries,
  displayTimezone,
  agents,
  loading,
  onAdd,
}: {
  readonly entries: readonly WorkflowTriggerAutomationEntry[];
  readonly displayTimezone: string;
  readonly agents: readonly TeamComposeItem[];
  readonly loading: boolean;
  readonly onAdd: () => void;
}) {
  if (loading) {
    return <TriggerListSkeleton />;
  }

  if (entries.length === 0) {
    return <EmptyTriggers onAdd={onAdd} />;
  }

  return (
    <div className="flex flex-col gap-2.5">
      {entries.map((entry) => {
        return (
          <WorkflowTriggerIndexCard
            key={entry.trigger.id}
            entry={entry}
            displayTimezone={displayTimezone}
            agents={agents}
          />
        );
      })}
    </div>
  );
}

export function WorkflowTriggerAutomationsPage() {
  const entriesLoadable = useLastLoadable(allWorkflowTriggerEntries$);
  const prefsLoadable = useLastLoadable(userPreferences$);
  const agentsLoadable = useLastLoadable(agents$);
  const setCreateOpen = useSet(setWorkflowAutomationDialogOpen$);
  const entries =
    entriesLoadable.state === "hasData" ? entriesLoadable.data : [];
  const agents = agentsLoadable.state === "hasData" ? agentsLoadable.data : [];
  const displayTimezone =
    prefsLoadable.state === "hasData" && prefsLoadable.data?.timezone
      ? prefsLoadable.data.timezone
      : new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const loading = entriesLoadable.state === "loading";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 bg-transparent px-4 pb-0 pt-3 sm:px-6 md:pb-3 md:pt-10">
        <div className="mx-auto flex max-w-[900px] flex-wrap items-end justify-between gap-4">
          <div className="hidden min-w-0 md:block">
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              Automations
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Workflow triggers running across your workspace.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="zero-btn-morandi h-9 shrink-0 gap-2 rounded-lg border"
            onClick={() => {
              setCreateOpen(true);
            }}
          >
            <IconPlus size={14} stroke={2} />
            Add automation
          </Button>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 pb-8 pt-3 sm:px-6">
        <div className="mx-auto max-w-[900px]">
          <WorkflowTriggerAutomationIndexList
            entries={entries}
            displayTimezone={displayTimezone}
            agents={agents}
            loading={loading}
            onAdd={() => {
              setCreateOpen(true);
            }}
          />
        </div>
      </main>

      <CreateWorkflowAutomationDialog />
    </div>
  );
}
