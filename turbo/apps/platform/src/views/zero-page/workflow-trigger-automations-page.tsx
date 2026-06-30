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
  IconArrowLeft,
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
} from "@tabler/icons-react";
import { Button } from "@vm0/ui";
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
  setSelectedWorkflowAutomationAgentId$,
  setWorkflowAutomationAgentQuery$,
  setWorkflowAutomationDialogOpen$,
  setWorkflowAutomationDialogStep$,
  startCreateWorkflowFromAutomationDialog$,
  workflowAutomationAgentSelectionLocked$,
  workflowAutomationAgentQuery$,
  workflowAutomationDialogIntent$,
  workflowAutomationDialogOpen$,
  workflowAutomationDialogStep$,
} from "../../signals/automation-page/workflow-trigger-automation-dialog.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import {
  allWorkflowTriggerEntries$,
  allVisibleWorkflows$,
  runWorkflowTriggerNow$,
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
import { AgentAvatarImg } from "./zero-sidebar-shared.tsx";
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

type WorkflowAutomationKind =
  | "manual"
  | "interval"
  | "scheduled"
  | "once"
  | "webhook"
  | "google-calendar-event-created"
  | "gmail-new-message"
  | "gmail-label-applied"
  | "github-label-applied";

interface WorkflowAutomationOption {
  readonly kind: WorkflowAutomationKind;
  readonly title: string;
  readonly description: string;
  readonly Icon: typeof IconClock;
  readonly prompt: string;
}

export const CREATE_WORKFLOW_WITH_CHAT_PROMPT =
  "Help me create a Zero workflow for this agent. Use the workflow-setup skill, then ask me for the automation goal, trigger, action, and allowed side effects before creating the workflow and trigger.";

const WORKFLOW_AUTOMATION_OPTIONS: readonly WorkflowAutomationOption[] = [
  {
    kind: "manual",
    title: "Manual run",
    description:
      "Create a workflow you can run from chat or the workflows page.",
    Icon: IconPlayerPlay,
    prompt:
      "I'd like to create a workflow that I can run manually without an automation schedule or event. Help me define the workflow.",
  },
  {
    kind: "interval",
    title: "Fixed interval",
    description: "Run a workflow every few minutes or hours.",
    Icon: IconRepeat,
    prompt:
      "I'd like to set up a workflow automation that runs every few minutes or hours. Help me define the workflow.",
  },
  {
    kind: "scheduled",
    title: "Fixed schedule",
    description:
      "Run a workflow on a daily, weekly, monthly, or custom cron schedule.",
    Icon: IconCalendarTime,
    prompt:
      "I'd like to set up a workflow automation that runs on a daily, weekly, monthly, or custom cron schedule. Help me define the workflow.",
  },
  {
    kind: "once",
    title: "One-time run",
    description: "Run a workflow once at a specific date and time.",
    Icon: IconClock,
    prompt:
      "I'd like to set up a one-time workflow automation that runs at a specific date and time. Help me define the workflow.",
  },
  {
    kind: "webhook",
    title: "Webhook",
    description: "Run a workflow when an inbound webhook is received.",
    Icon: IconLink,
    prompt:
      "I'd like to set up a webhook workflow automation that runs when an inbound webhook is received. Help me define the workflow.",
  },
  {
    kind: "google-calendar-event-created",
    title: "Calendar event",
    description: "Run a workflow when a Google Calendar event is created.",
    Icon: IconCalendarTime,
    prompt:
      "I'd like to set up a Google Calendar workflow automation that runs when a new calendar event is created. Help me define the workflow.",
  },
  {
    kind: "gmail-new-message",
    title: "New email",
    description: "Run a workflow when a matching Gmail message arrives.",
    Icon: IconMail,
    prompt:
      "I'd like to set up an email workflow automation that runs when a Gmail message matches my criteria. Help me define the workflow.",
  },
  {
    kind: "gmail-label-applied",
    title: "Email label",
    description: "Run a workflow when a Gmail label is applied.",
    Icon: IconMail,
    prompt:
      "I'd like to set up an email-label workflow automation that runs when a Gmail label is applied. Help me define the workflow.",
  },
  {
    kind: "github-label-applied",
    title: "GitHub label",
    description: "Run a workflow when a GitHub label is applied.",
    Icon: IconBrandGithub,
    prompt:
      "I'd like to set up a GitHub workflow automation that runs when a label is applied. Help me define the workflow.",
  },
] as const;

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

function triggerRuleLabel(
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

function triggerRows(
  trigger: ZeroWorkflowTriggerSummary,
  displayTimezone: string,
): readonly WorkflowTriggerCardRow[] {
  const rows: WorkflowTriggerCardRow[] = [
    {
      label: trigger.kind === "schedule" ? "Schedule" : "Automation",
      value: triggerRuleLabel(trigger, displayTimezone),
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

function EmptyTriggers({ onAdd }: { readonly onAdd: () => void }) {
  return (
    <div className="zero-card flex min-h-56 flex-col items-center justify-center px-6 py-10 text-center">
      <p className="text-sm font-medium text-foreground">No automations yet</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Create a workflow automation and it will show up here.
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
  loading,
  onSelectWorkflow,
  onCreateWorkflow,
}: {
  readonly workflows: readonly ZeroWorkflowSummary[];
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
            Create with Zero
          </span>
          <span className="mt-0.5 block text-sm text-muted-foreground">
            Build a new workflow in chat before adding an automation.
          </span>
        </span>
      </button>

      {workflows.length > 0 ? (
        <div className="grid gap-2">
          {workflows.map((workflow) => {
            return (
              <button
                key={workflow.id}
                type="button"
                className="flex min-w-0 items-start justify-between gap-3 rounded-lg border border-border/60 px-3 py-3 text-left transition-colors hover:bg-gray-50"
                onClick={() => {
                  onSelectWorkflow(workflow);
                }}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {workflowTitle(workflow)}
                  </span>
                  <span className="mt-0.5 block truncate text-sm text-muted-foreground">
                    {agentLabel(workflow)}
                    {workflow.description ? ` · ${workflow.description}` : ""}
                  </span>
                </span>
                <span className="shrink-0 text-xs font-medium text-muted-foreground">
                  Choose
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="px-1 py-2 text-sm text-muted-foreground">
          No workflows yet. Create one with Zero to continue.
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

function TriggerSelectionStep({
  selectedAgent,
  onSelectOption,
}: {
  readonly selectedAgent: TeamComposeItem | null;
  readonly onSelectOption: (option: WorkflowAutomationOption) => void;
}) {
  const selectedAgentName = selectedAgent?.displayName ?? "Selected agent";
  return (
    <div className="grid gap-2">
      <div className="mb-2 flex min-w-0 items-center gap-2 px-1 py-1">
        {selectedAgent ? (
          <AgentAvatarImg
            name={selectedAgent.id}
            alt={selectedAgentName}
            className="h-8 w-8 shrink-0 rounded-lg bg-gray-100 object-cover object-top"
          />
        ) : (
          <span className="h-8 w-8 shrink-0 rounded-lg bg-gray-100" />
        )}
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-foreground">
            {selectedAgentName}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            What do you want me to do?
          </span>
        </span>
      </div>
      {WORKFLOW_AUTOMATION_OPTIONS.map((option) => {
        const Icon = option.Icon;
        return (
          <button
            key={option.kind}
            type="button"
            className="flex min-w-0 items-start gap-3 rounded-lg border border-border/60 px-3 py-3 text-left transition-colors hover:bg-gray-50"
            onClick={() => {
              onSelectOption(option);
            }}
          >
            <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-50 text-muted-foreground">
              <Icon size={16} stroke={1.6} />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">
                {option.title}
              </span>
              <span className="mt-0.5 block text-sm text-muted-foreground">
                {option.description}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function WorkflowAutomationDialogFooter({
  showBack,
  onBack,
  onCancel,
}: {
  readonly showBack: boolean;
  readonly onBack: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <DialogFooter className="shrink-0 border-t border-border/60 bg-card px-5 py-4">
      {showBack ? (
        <Button
          type="button"
          variant="outline"
          className="gap-1.5"
          onClick={onBack}
        >
          <IconArrowLeft size={14} stroke={1.5} />
          Back
        </Button>
      ) : null}
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
  const step = useGet(workflowAutomationDialogStep$);
  const setStep = useSet(setWorkflowAutomationDialogStep$);
  const agentSelectionLocked = useGet(workflowAutomationAgentSelectionLocked$);
  const selectedAgentIdState = useGet(selectedWorkflowAutomationAgentId$);
  const setSelectedAgentId = useSet(setSelectedWorkflowAutomationAgentId$);
  const startCreateWorkflow = useSet(startCreateWorkflowFromAutomationDialog$);
  const navigate = useSet(detachedNavigateTo$);
  const selectedAgentId = selectedAgentIdState;
  const selectedAgent =
    agents.find((agent) => {
      return agent.id === selectedAgentId;
    }) ?? null;
  const creatingWorkflow = intent === "workflow" || intent === "workflow-chat";
  const creatingWorkflowWithChat = intent === "workflow-chat";

  const selectAgent = (agentId: string) => {
    if (creatingWorkflowWithChat) {
      setOpen(false);
      navigate(ROUTES.agentChat, {
        pathParams: { agentId },
        searchParams: new URLSearchParams({
          prompt: CREATE_WORKFLOW_WITH_CHAT_PROMPT,
        }),
      });
      return;
    }
    setSelectedAgentId(agentId);
    setStep(2);
  };

  const startWorkflowCreation = (option: WorkflowAutomationOption) => {
    if (!selectedAgentId) {
      return;
    }
    setOpen(false);
    navigate(ROUTES.agentChat, {
      pathParams: { agentId: selectedAgentId },
      searchParams: new URLSearchParams({ prompt: option.prompt }),
    });
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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="zero-app !flex max-h-[min(720px,calc(100dvh-2rem))] w-[calc(100vw-2rem)] !flex-col !overflow-hidden gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="shrink-0 px-5 pb-3 pt-5">
          <DialogTitle className="text-base font-semibold">
            {creatingWorkflow ? "Create workflow" : "Add automation"}
          </DialogTitle>
          <DialogDescription className="mt-1 text-sm text-muted-foreground">
            {creatingWorkflow
              ? step === 1
                ? "Choose the agent for this workflow."
                : "Choose how this workflow should run."
              : "Choose a workflow to automate, or create one with Zero."}
          </DialogDescription>
        </DialogHeader>

        {!creatingWorkflow ? (
          <WorkflowSelectionStep
            workflows={workflows}
            loading={workflowsLoading}
            onSelectWorkflow={openWorkflowTriggers}
            onCreateWorkflow={startCreateWorkflow}
          />
        ) : step === 1 ? (
          <AgentSelectionStep agents={agents} onSelectAgent={selectAgent} />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
            <TriggerSelectionStep
              selectedAgent={selectedAgent}
              onSelectOption={startWorkflowCreation}
            />
          </div>
        )}

        <WorkflowAutomationDialogFooter
          showBack={step === 2 && !agentSelectionLocked}
          onBack={() => {
            setStep(1);
          }}
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

export function WorkflowTriggerAutomationsPage() {
  const entriesLoadable = useLastLoadable(allWorkflowTriggerEntries$);
  const prefsLoadable = useLastLoadable(userPreferences$);
  const setCreateOpen = useSet(setWorkflowAutomationDialogOpen$);
  const entries =
    entriesLoadable.state === "hasData" ? entriesLoadable.data : [];
  const displayTimezone =
    prefsLoadable.state === "hasData" && prefsLoadable.data?.timezone
      ? prefsLoadable.data.timezone
      : new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const loading = entriesLoadable.state === "loading";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 bg-transparent px-4 pb-0 pt-3 sm:px-6 md:pb-3 md:pt-10">
        <div className="mx-auto flex max-w-[1120px] flex-wrap items-end justify-between gap-4">
          <div className="hidden min-w-0 md:block">
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              Automations
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Workflow automations running across your workspace.
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
        <div className="mx-auto max-w-[1120px]">
          <WorkflowTriggerAutomationList
            entries={entries}
            displayTimezone={displayTimezone}
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
