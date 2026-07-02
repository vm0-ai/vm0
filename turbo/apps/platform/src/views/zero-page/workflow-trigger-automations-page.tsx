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
  IconBrandGithub,
  IconCalendarTime,
  IconClock,
  IconLink,
  IconMail,
  IconMessageCircle,
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
  allVisibleWorkflows$,
  setWorkflowTriggerEnabled$,
  type WorkflowTriggerAutomationEntry,
} from "../../signals/workflows-page/workflows-signals.ts";
import {
  atTimeInTimezone,
  cronWallTimeInTimezone,
} from "../../signals/zero-page/cron.ts";
import { pinnedAgentIds$ } from "../../signals/zero-page/zero-pinned-agents.ts";
import { detach, Reason } from "../../signals/utils.ts";
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
import { CREATE_WORKFLOW_WITH_CHAT_PROMPT } from "./workflow-chat-prompts.ts";

export { CREATE_WORKFLOW_WITH_CHAT_PROMPT };

const CREATE_AUTOMATION_CHAT_PROMPT =
  "Help me create a workflow automation for this agent. Use the workflow-setup skill, then ask me for the desired outcome, automation, and action before creating the workflow and automation.";

function formatClockTime(hour: number, minute: number): string {
  const ampm = hour >= 12 ? "PM" : "AM";
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${h12}:${String(minute).padStart(2, "0")} ${ampm}`;
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

function quote(value: string): string {
  return `"${value}"`;
}

export function humanReadableTriggerRuleLabel(
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
  if (trigger.eventType === "google-calendar-event-updated") {
    return `When calendar ${quote(trigger.eventConfig.calendarId)} event is updated`;
  }
  if (trigger.eventType === "google-calendar-event-cancelled") {
    return `When calendar ${quote(trigger.eventConfig.calendarId)} event is cancelled`;
  }
  if (trigger.eventType === "webhook-received") {
    return "When an inbound webhook is received";
  }
  return gmailTriggerTitle(trigger);
}

export function triggerTypeLabel(trigger: ZeroWorkflowTriggerSummary): string {
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
  if (
    trigger.eventType === "google-calendar-event-created" ||
    trigger.eventType === "google-calendar-event-updated" ||
    trigger.eventType === "google-calendar-event-cancelled"
  ) {
    return "Google Calendar";
  }
  if (trigger.eventType === "webhook-received") {
    return "Webhook";
  }
  return "Trigger";
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

export function TriggerListIcon({
  trigger,
  size = "md",
}: {
  readonly trigger: ZeroWorkflowTriggerSummary;
  readonly size?: "sm" | "md";
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

  const compact = size === "sm";
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center border border-border/60",
        compact ? "h-8 w-8 rounded-lg" : "h-11 w-11 rounded-xl",
        tone,
      )}
      aria-hidden="true"
    >
      <Icon size={compact ? 16 : 20} stroke={1.6} />
    </span>
  );
}

export function WorkflowTriggerEnabledSwitch({
  entry,
  size = "default",
}: {
  readonly entry: WorkflowTriggerAutomationEntry;
  readonly size?: "default" | "sm";
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
      size={size}
      aria-label={`${entry.trigger.enabled ? "Disable" : "Enable"} ${title}`}
      className="data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted"
      onCheckedChange={(enabled) => {
        detach(
          setEnabled({ triggerId: entry.trigger.id, enabled }, pageSignal),
          Reason.DomCallback,
        );
      }}
    />
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
    navigate(ROUTES.workflowDetailAutomations, {
      pathParams: { workflowId: workflow.id },
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
