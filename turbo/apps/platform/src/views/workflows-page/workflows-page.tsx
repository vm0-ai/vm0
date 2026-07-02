// Workflow list surfaces for agent-scoped tabs and the workspace index page.
import type { ReactNode } from "react";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import type { ZeroWorkflowSummary } from "@vm0/api-contracts/contracts/zero-workflows";
import { IconBolt, IconLock, IconRoute, IconWorld } from "@tabler/icons-react";
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@vm0/ui";

import { nowDate } from "../../lib/time.ts";
import { openCreateWorkflowDialog$ } from "../../signals/automation-page/workflow-trigger-automation-dialog.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import {
  allVisibleWorkflows$,
  allWorkflowTriggerEntries$,
  setWorkflowAutomationFilter$,
  setWorkflowSortMode$,
  setWorkflowVisibilityFilter$,
  workflowAutomationFilter$,
  workflowSortMode$,
  workflowVisibilityFilter$,
  type WorkflowAutomationFilter,
  type WorkflowSortMode,
  type WorkflowTriggerAutomationEntry,
  type WorkflowVisibilityFilter,
} from "../../signals/workflows-page/workflows-signals.ts";
import { userPreferences$ } from "../../signals/zero-page/settings/user-preferences.ts";
import { Link } from "../router/link.tsx";
import {
  CreateWorkflowAutomationDialog,
  humanReadableTriggerRuleLabel,
  TriggerListIcon,
  triggerTypeLabel,
  WorkflowTriggerEnabledSwitch,
} from "../zero-page/workflow-trigger-automations-page.tsx";
import { agentLabel, workflowTitle } from "./workflow-shared.tsx";

type WorkflowTriggerEntryMap = ReadonlyMap<
  string,
  readonly WorkflowTriggerAutomationEntry[]
>;

function workflowTriggerEntryMap(
  entries: readonly WorkflowTriggerAutomationEntry[],
): WorkflowTriggerEntryMap {
  const grouped = new Map<string, WorkflowTriggerAutomationEntry[]>();
  for (const entry of entries) {
    const workflowEntries = grouped.get(entry.workflow.id) ?? [];
    workflowEntries.push(entry);
    grouped.set(entry.workflow.id, workflowEntries);
  }
  return grouped;
}

function ownerLabel(workflow: ZeroWorkflowSummary): string {
  return workflow.ownerUserDisplayName?.trim() || workflow.ownerUserId;
}

function initials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`.toUpperCase();
  }
  return (words[0]?.slice(0, 2) || "??").toUpperCase();
}

function triggerDotClass(entry: WorkflowTriggerAutomationEntry): string {
  const trigger = entry.trigger;
  if (trigger.kind === "schedule") {
    return "bg-blue-500";
  }
  return trigger.eventType === "webhook-received"
    ? "bg-amber-500"
    : "bg-emerald-500";
}

function connectorNames(
  entries: readonly WorkflowTriggerAutomationEntry[],
): string {
  return entries
    .slice(0, 2)
    .map((entry) => {
      return triggerTypeLabel(entry.trigger);
    })
    .join(", ");
}

/** The agent that runs the workflow, drawn as a rounded square. */
function AgentAvatar({ workflow }: { readonly workflow: ZeroWorkflowSummary }) {
  const label = agentLabel(workflow);
  return (
    <span
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border/60 bg-gray-50 text-[10px] font-semibold text-muted-foreground"
      aria-label={`Runs as ${label}`}
    >
      {initials(label)}
    </span>
  );
}

function MemberAvatar({
  workflow,
}: {
  readonly workflow: ZeroWorkflowSummary;
}) {
  const label = ownerLabel(workflow);
  if (workflow.ownerUserImageUrl) {
    return (
      <span className="h-6 w-6 shrink-0 overflow-hidden rounded-full border border-border/60 bg-gray-50">
        <img
          src={workflow.ownerUserImageUrl}
          alt={label}
          className="h-full w-full object-cover"
        />
      </span>
    );
  }
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border/60 bg-gray-50 text-[10px] font-semibold text-muted-foreground">
      {initials(label)}
    </span>
  );
}

function VisibilityIcon({
  workflow,
}: {
  readonly workflow: ZeroWorkflowSummary;
}) {
  const isPublic = workflow.visibility === "public";
  const Icon = isPublic ? IconWorld : IconLock;
  return (
    <Icon
      size={15}
      stroke={1.7}
      className={cn(
        "shrink-0",
        isPublic ? "text-blue-500" : "text-muted-foreground/70",
      )}
      aria-label={isPublic ? "Public" : "Private"}
    />
  );
}

/** The connector pill's list of automations, shown when the pill is clicked. */
function ConnectorPopoverList({
  entries,
  displayTimezone,
}: {
  readonly entries: readonly WorkflowTriggerAutomationEntry[];
  readonly displayTimezone: string;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1.5 px-2 pb-1.5 pt-1 text-xs font-semibold text-muted-foreground">
        <span>Automations</span>
        <span className="font-normal text-muted-foreground/70">
          {entries.length}
        </span>
      </div>
      {entries.map((entry) => {
        return (
          <div
            key={entry.trigger.id}
            className="rounded-lg px-2 py-2 hover:bg-gray-50"
          >
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-50 px-2 py-0.5 text-xs font-medium text-muted-foreground">
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    triggerDotClass(entry),
                  )}
                />
                {triggerTypeLabel(entry.trigger)}
              </span>
              <div className="ml-auto">
                <WorkflowTriggerEnabledSwitch entry={entry} />
              </div>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {humanReadableTriggerRuleLabel(entry.trigger, displayTimezone)}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function ConnectorCell({
  entries,
  displayTimezone,
}: {
  readonly entries: readonly WorkflowTriggerAutomationEntry[];
  readonly displayTimezone: string;
}) {
  if (entries.length === 0) {
    return (
      <span className="inline-flex shrink-0 items-center gap-2 rounded-full bg-gray-50 px-2.5 py-1 text-xs font-medium text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
        Manual
      </span>
    );
  }

  const [lead] = entries;
  const remaining = entries.length - 2;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-2 rounded-full bg-gray-50 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-gray-100"
        >
          {lead ? (
            <span
              className={cn("h-1.5 w-1.5 rounded-full", triggerDotClass(lead))}
            />
          ) : null}
          <span>{connectorNames(entries)}</span>
          {remaining > 0 ? (
            <span className="text-muted-foreground">+{remaining}</span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-1">
        <ConnectorPopoverList
          entries={entries}
          displayTimezone={displayTimezone}
        />
      </PopoverContent>
    </Popover>
  );
}

function WorkflowHoverContent({
  workflow,
}: {
  readonly workflow: ZeroWorkflowSummary;
}) {
  const title = workflowTitle(workflow);
  return (
    <div className="max-w-xs">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {workflow.description ?? workflow.name}
      </p>
      <div className="mt-2.5 flex flex-col gap-1.5 border-t border-border/60 pt-2.5 text-xs text-foreground/80">
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-muted-foreground">
            Created by
          </span>
          <MemberAvatar workflow={workflow} />
          <span className="truncate">{ownerLabel(workflow)}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-muted-foreground">Runs as</span>
          <AgentAvatar workflow={workflow} />
          <span className="truncate">{agentLabel(workflow)}</span>
        </div>
      </div>
    </div>
  );
}

function WorkflowRowIcon({
  entries,
}: {
  readonly entries: readonly WorkflowTriggerAutomationEntry[];
}) {
  const [lead] = entries;
  if (lead) {
    return <TriggerListIcon trigger={lead.trigger} />;
  }
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-muted-foreground">
      <IconRoute size={16} stroke={1.7} />
    </span>
  );
}

function WorkflowRow({
  workflow,
  entries,
  displayTimezone,
}: {
  readonly workflow: ZeroWorkflowSummary;
  readonly entries: readonly WorkflowTriggerAutomationEntry[];
  readonly displayTimezone: string;
}) {
  const title = workflowTitle(workflow);
  return (
    <article className="zero-card flex items-center gap-3 px-5 py-4 text-left text-foreground transition-colors hover:bg-gray-50">
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              pathname={ROUTES.workflowDetailAutomations}
              options={{ pathParams: { workflowId: workflow.id } }}
              aria-label={`Open ${title}`}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            >
              <WorkflowRowIcon entries={entries} />
              <span className="min-w-0 truncate text-sm font-medium">
                {title}
              </span>
            </Link>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="start" className="p-3">
            <WorkflowHoverContent workflow={workflow} />
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <ConnectorCell entries={entries} displayTimezone={displayTimezone} />
      <VisibilityIcon workflow={workflow} />
      <AgentAvatar workflow={workflow} />
    </article>
  );
}

function hasTriggers(
  workflowId: string,
  entriesByWorkflowId: WorkflowTriggerEntryMap,
): boolean {
  return (entriesByWorkflowId.get(workflowId)?.length ?? 0) > 0;
}

function applyWorkflowFilters(
  workflows: readonly ZeroWorkflowSummary[],
  entriesByWorkflowId: WorkflowTriggerEntryMap,
  automation: WorkflowAutomationFilter,
  visibility: WorkflowVisibilityFilter,
): readonly ZeroWorkflowSummary[] {
  return workflows.filter((workflow) => {
    const automated = hasTriggers(workflow.id, entriesByWorkflowId);
    if (automation === "automated" && !automated) {
      return false;
    }
    if (automation === "without" && automated) {
      return false;
    }
    if (visibility !== "all" && workflow.visibility !== visibility) {
      return false;
    }
    return true;
  });
}

type NextRunBucket = "today" | "week" | "later" | "event" | "manual";

const NEXT_RUN_SECTIONS: readonly {
  readonly key: NextRunBucket;
  readonly label: string;
}[] = [
  { key: "today", label: "Runs today" },
  { key: "week", label: "This week" },
  { key: "later", label: "Later" },
  { key: "event", label: "On event" },
  { key: "manual", label: "Manual" },
];

function dayKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function workflowNextRunBucket(
  entries: readonly WorkflowTriggerAutomationEntry[],
  now: Date,
  timezone: string,
): NextRunBucket {
  if (entries.length === 0) {
    return "manual";
  }
  const upcoming = entries
    .filter((entry) => {
      return (
        entry.trigger.kind === "schedule" &&
        entry.trigger.enabled &&
        entry.trigger.nextRunAt !== null
      );
    })
    .map((entry) => {
      return new Date(entry.trigger.nextRunAt as string);
    });
  if (upcoming.length === 0) {
    return "event";
  }
  const soonest = upcoming.reduce((earliest, candidate) => {
    return candidate < earliest ? candidate : earliest;
  });
  if (dayKey(soonest, timezone) === dayKey(now, timezone)) {
    return "today";
  }
  const weekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  return soonest <= weekAhead ? "week" : "later";
}

function WorkflowSectionHeader({
  label,
  count,
}: {
  readonly label: string;
  readonly count: number;
}) {
  return (
    <div className="flex items-center gap-2 px-0.5">
      <span className="text-xs font-semibold text-foreground/80">{label}</span>
      <span className="text-xs text-muted-foreground/70">{count}</span>
      <span className="h-px flex-1 bg-border/70" />
    </div>
  );
}

function WorkflowRowList({
  workflows,
  entriesByWorkflowId,
  displayTimezone,
}: {
  readonly workflows: readonly ZeroWorkflowSummary[];
  readonly entriesByWorkflowId: WorkflowTriggerEntryMap;
  readonly displayTimezone: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {workflows.map((workflow) => {
        return (
          <WorkflowRow
            key={workflow.id}
            workflow={workflow}
            entries={entriesByWorkflowId.get(workflow.id) ?? []}
            displayTimezone={displayTimezone}
          />
        );
      })}
    </div>
  );
}

function WorkflowNextRunGroups({
  workflows,
  entriesByWorkflowId,
  displayTimezone,
}: {
  readonly workflows: readonly ZeroWorkflowSummary[];
  readonly entriesByWorkflowId: WorkflowTriggerEntryMap;
  readonly displayTimezone: string;
}) {
  const now = nowDate();
  const buckets = new Map<NextRunBucket, ZeroWorkflowSummary[]>();
  for (const workflow of workflows) {
    const entries = entriesByWorkflowId.get(workflow.id) ?? [];
    const bucket = workflowNextRunBucket(entries, now, displayTimezone);
    const list = buckets.get(bucket) ?? [];
    list.push(workflow);
    buckets.set(bucket, list);
  }

  return (
    <div className="flex flex-col gap-5">
      {NEXT_RUN_SECTIONS.map((section) => {
        const sectionWorkflows = buckets.get(section.key);
        if (!sectionWorkflows || sectionWorkflows.length === 0) {
          return null;
        }
        return (
          <section key={section.key} className="flex flex-col gap-2">
            <WorkflowSectionHeader
              label={section.label}
              count={sectionWorkflows.length}
            />
            <WorkflowRowList
              workflows={sectionWorkflows}
              entriesByWorkflowId={entriesByWorkflowId}
              displayTimezone={displayTimezone}
            />
          </section>
        );
      })}
    </div>
  );
}

export function WorkflowListPanel({
  workflows,
  loading,
  emptyDescription,
  sortMode = "recent",
  triggerEntriesByWorkflowId,
  displayTimezone = new Intl.DateTimeFormat().resolvedOptions().timeZone,
}: {
  readonly workflows: readonly ZeroWorkflowSummary[] | null;
  readonly loading: boolean;
  readonly showAgentColumn?: boolean;
  readonly emptyDescription: string;
  readonly sortMode?: WorkflowSortMode;
  readonly triggerEntriesByWorkflowId?: WorkflowTriggerEntryMap;
  readonly displayTimezone?: string;
}) {
  const entriesByWorkflowId =
    triggerEntriesByWorkflowId ??
    new Map<string, readonly WorkflowTriggerAutomationEntry[]>();

  return (
    <section className="min-h-[520px]">
      {loading ? (
        <WorkflowIndexSkeleton />
      ) : workflows && workflows.length > 0 ? (
        sortMode === "next-run" ? (
          <WorkflowNextRunGroups
            workflows={workflows}
            entriesByWorkflowId={entriesByWorkflowId}
            displayTimezone={displayTimezone}
          />
        ) : (
          <WorkflowRowList
            workflows={workflows}
            entriesByWorkflowId={entriesByWorkflowId}
            displayTimezone={displayTimezone}
          />
        )
      ) : (
        <div className="zero-card flex min-h-[20rem] flex-col items-center justify-center px-6 text-center">
          <p className="text-sm font-medium text-foreground">No workflows</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {emptyDescription}
          </p>
        </div>
      )}
    </section>
  );
}

function FilterTabs<T extends string>({
  value,
  options,
  onChange,
}: {
  readonly value: T;
  readonly options: readonly {
    readonly value: T;
    readonly label: ReactNode;
  }[];
  readonly onChange: (value: T) => void;
}) {
  return (
    <Tabs
      value={value}
      onValueChange={(next) => {
        const match = options.find((option) => {
          return option.value === next;
        });
        if (match) {
          onChange(match.value);
        }
      }}
    >
      <TabsList className="zero-tabs h-9 gap-1 px-1 py-1">
        {options.map((option) => {
          return (
            <TabsTrigger
              key={option.value}
              value={option.value}
              className="gap-1.5 px-3 text-sm data-[state=active]:bg-background"
            >
              {option.label}
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}

function WorkflowFilterBar({
  automation,
  visibility,
  sortMode,
}: {
  readonly automation: WorkflowAutomationFilter;
  readonly visibility: WorkflowVisibilityFilter;
  readonly sortMode: WorkflowSortMode;
}) {
  const setAutomation = useSet(setWorkflowAutomationFilter$);
  const setVisibility = useSet(setWorkflowVisibilityFilter$);
  const setSortMode = useSet(setWorkflowSortMode$);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterTabs
        value={automation}
        onChange={setAutomation}
        options={[
          { value: "all", label: "All" },
          {
            value: "automated",
            label: (
              <>
                <IconBolt size={13} stroke={1.8} />
                Automated
              </>
            ),
          },
          { value: "without", label: "Without automation" },
        ]}
      />
      <FilterTabs
        value={visibility}
        onChange={setVisibility}
        options={[
          { value: "all", label: "Any" },
          {
            value: "private",
            label: (
              <>
                <IconLock size={13} stroke={1.8} />
                Private
              </>
            ),
          },
          {
            value: "public",
            label: (
              <>
                <IconWorld size={13} stroke={1.8} />
                Public
              </>
            ),
          },
        ]}
      />
      <div className="ml-auto">
        <FilterTabs
          value={sortMode}
          onChange={setSortMode}
          options={[
            { value: "recent", label: "Recent" },
            { value: "next-run", label: "Next run" },
          ]}
        />
      </div>
    </div>
  );
}

export function WorkflowsPage() {
  const automation = useGet(workflowAutomationFilter$);
  const visibility = useGet(workflowVisibilityFilter$);
  const sortMode = useGet(workflowSortMode$);
  const workflowsLoadable = useLastLoadable(allVisibleWorkflows$);
  const triggerEntriesLoadable = useLastLoadable(allWorkflowTriggerEntries$);
  const preferences = useLastResolved(userPreferences$);
  const openCreateWorkflowDialog = useSet(openCreateWorkflowDialog$);
  const loading =
    workflowsLoadable.state === "loading" ||
    triggerEntriesLoadable.state === "loading";
  const workflows =
    workflowsLoadable.state === "hasData" ? workflowsLoadable.data : null;
  const triggerEntries =
    triggerEntriesLoadable.state === "hasData"
      ? triggerEntriesLoadable.data
      : [];
  const triggerEntriesByWorkflowId = workflowTriggerEntryMap(triggerEntries);
  const displayTimezone =
    preferences?.timezone ??
    new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const filteredWorkflows = workflows
    ? applyWorkflowFilters(
        workflows,
        triggerEntriesByWorkflowId,
        automation,
        visibility,
      )
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 bg-transparent px-4 pb-0 pt-3 sm:px-6 md:pb-3 md:pt-10">
        <div className="mx-auto flex max-w-[900px] flex-wrap items-end justify-between gap-4">
          <div className="hidden min-w-0 md:block">
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              Workflows
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Reusable instructions your team can run, edit, or automate.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            className="h-9 shrink-0 rounded-lg bg-foreground px-3 text-background hover:bg-foreground/90"
            onClick={() => {
              openCreateWorkflowDialog();
            }}
          >
            Create in chat
          </Button>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 pb-8 pt-3 sm:px-6">
        <div className="mx-auto flex max-w-[900px] flex-col gap-4">
          <WorkflowFilterBar
            automation={automation}
            visibility={visibility}
            sortMode={sortMode}
          />
          <WorkflowListPanel
            workflows={filteredWorkflows}
            loading={loading}
            sortMode={sortMode}
            emptyDescription={
              automation === "without"
                ? "Every workflow here runs on a schedule or event."
                : automation === "automated"
                  ? "Add a schedule or trigger to a workflow and it shows up here."
                  : "Create a workflow from chat or save one from a useful run."
            }
            triggerEntriesByWorkflowId={triggerEntriesByWorkflowId}
            displayTimezone={displayTimezone}
          />
        </div>
      </main>

      <CreateWorkflowAutomationDialog />
    </div>
  );
}

function WorkflowIndexSkeleton() {
  return (
    <div className="flex flex-col gap-1.5" data-testid="workflows-loading">
      {[0, 1, 2, 3].map((rowIndex) => {
        return (
          <div
            key={rowIndex}
            className="zero-card flex items-center gap-3 px-4 py-3"
          >
            <div className="h-8 w-8 shrink-0 rounded-lg bg-muted/40" />
            <div className="h-4 w-40 rounded bg-muted/50" />
            <div className="ml-auto h-6 w-28 rounded-full bg-muted/40" />
            <div className="h-5 w-5 rounded-full bg-muted/40" />
          </div>
        );
      })}
    </div>
  );
}
