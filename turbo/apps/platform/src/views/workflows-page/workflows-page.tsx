// Workflow list surfaces for agent-scoped tabs and the workspace index page.
import type { ReactNode } from "react";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import type { ZeroWorkflowSummary } from "@vm0/api-contracts/contracts/zero-workflows";
import {
  IconArrowsSort,
  IconChevronDown,
  IconLock,
  IconPlus,
  IconRoute,
  IconWorld,
} from "@tabler/icons-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
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
  setWorkflowFilter$,
  setWorkflowSortMode$,
  workflowFilter$,
  workflowSortMode$,
  type WorkflowFilter,
  type WorkflowSortMode,
  type WorkflowTriggerAutomationEntry,
} from "../../signals/workflows-page/workflows-signals.ts";
import { userPreferences$ } from "../../signals/zero-page/settings/user-preferences.ts";
import { AgentAvatarImg } from "../zero-page/zero-sidebar-shared.tsx";
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

function connectorPillClassName({
  interactive = false,
  muted = false,
}: {
  readonly interactive?: boolean;
  readonly muted?: boolean;
}) {
  return cn(
    "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-white px-2 text-[11px] font-normal leading-none",
    muted ? "text-muted-foreground" : "text-foreground/70",
    interactive &&
      "cursor-pointer transition-colors hover:border-border hover:bg-gray-50 hover:text-foreground",
  );
}

function ConnectorPillMarker({
  dotClassName,
}: {
  readonly dotClassName: string;
}) {
  return (
    <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotClassName)} />
  );
}

/** The agent that runs the workflow, drawn as its real avatar. */
function AgentAvatar({ workflow }: { readonly workflow: ZeroWorkflowSummary }) {
  const label = agentLabel(workflow);
  return (
    <AgentAvatarImg
      name={workflow.agentId}
      alt={`Runs as ${label}`}
      className="h-6 w-6 shrink-0 rounded-md"
      size={24}
    />
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
        const ruleLabel = humanReadableTriggerRuleLabel(
          entry.trigger,
          displayTimezone,
        );
        return (
          <div
            key={entry.trigger.id}
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-gray-50"
          >
            <span className={connectorPillClassName({})}>
              <ConnectorPillMarker dotClassName={triggerDotClass(entry)} />
              {triggerTypeLabel(entry.trigger)}
            </span>
            <span
              title={ruleLabel}
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
            >
              {ruleLabel}
            </span>
            <WorkflowTriggerEnabledSwitch entry={entry} size="sm" />
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
      <span className={connectorPillClassName({ muted: true })}>
        <ConnectorPillMarker dotClassName="bg-muted-foreground/40" />
        Manual
      </span>
    );
  }

  const [lead] = entries;
  const remaining = entries.length - 2;
  return (
    <Popover>
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={connectorPillClassName({ interactive: true })}
              >
                {lead ? (
                  <ConnectorPillMarker dotClassName={triggerDotClass(lead)} />
                ) : null}
                <span>{connectorNames(entries)}</span>
                {remaining > 0 ? (
                  <span className="text-muted-foreground">+{remaining}</span>
                ) : null}
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">View automations</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent
        align="end"
        className="w-max min-w-[16rem] max-w-[min(28rem,var(--radix-popover-content-available-width))] p-1"
      >
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
      <div className="mt-2.5 flex flex-col gap-3 border-t border-border/60 pt-2.5 text-xs text-foreground/80">
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
    return <TriggerListIcon trigger={lead.trigger} size="sm" />;
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
    <article className="flex items-center gap-3 px-5 py-3.5 text-left text-foreground transition-colors hover:bg-gray-50">
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
              <span className="min-w-0 truncate text-sm font-medium underline decoration-dotted decoration-foreground/40 decoration-[1px] underline-offset-2">
                {title}
              </span>
            </Link>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            align="start"
            className="rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] p-3"
            style={{
              backgroundColor: "hsl(var(--card))",
              color: "hsl(var(--card-foreground))",
              boxShadow:
                "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)",
            }}
          >
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
  filter: WorkflowFilter,
): readonly ZeroWorkflowSummary[] {
  return workflows.filter((workflow) => {
    const automated = hasTriggers(workflow.id, entriesByWorkflowId);
    switch (filter) {
      case "automated": {
        return automated;
      }
      case "without": {
        return !automated;
      }
      case "private": {
        return workflow.visibility === "private";
      }
      case "public": {
        return workflow.visibility === "public";
      }
      default: {
        return true;
      }
    }
  });
}

function emptyDescriptionForFilter(filter: WorkflowFilter): string {
  switch (filter) {
    case "without": {
      return "Every workflow here runs on a schedule or event.";
    }
    case "automated": {
      return "Add a schedule or trigger to a workflow and it shows up here.";
    }
    case "private": {
      return "No private workflows yet.";
    }
    case "public": {
      return "No public workflows yet.";
    }
    default: {
      return "Create a workflow from chat or save one from a useful run.";
    }
  }
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

function WorkflowSectionHeader({ label }: { readonly label: string }) {
  return (
    <div className="px-5 pb-1.5 pt-4">
      <span className="text-[13px] font-medium leading-4 text-foreground/50">
        {label}
      </span>
    </div>
  );
}

function WorkflowRowDivider() {
  return <div className="mx-5 h-px bg-border/50" />;
}

function WorkflowRowList({
  workflows,
  entriesByWorkflowId,
  displayTimezone,
  framed = true,
}: {
  readonly workflows: readonly ZeroWorkflowSummary[];
  readonly entriesByWorkflowId: WorkflowTriggerEntryMap;
  readonly displayTimezone: string;
  readonly framed?: boolean;
}) {
  const rows = (
    <>
      {workflows.map((workflow, index) => {
        return (
          <div key={workflow.id}>
            {index > 0 ? <WorkflowRowDivider /> : null}
            <WorkflowRow
              workflow={workflow}
              entries={entriesByWorkflowId.get(workflow.id) ?? []}
              displayTimezone={displayTimezone}
            />
          </div>
        );
      })}
    </>
  );
  if (!framed) {
    return <div>{rows}</div>;
  }
  return <div className="zero-card overflow-hidden">{rows}</div>;
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
  const visibleSections = NEXT_RUN_SECTIONS.flatMap((section) => {
    const sectionWorkflows = buckets.get(section.key);
    if (!sectionWorkflows || sectionWorkflows.length === 0) {
      return [];
    }
    return [{ section, sectionWorkflows }];
  });

  return (
    <div className="zero-card overflow-hidden">
      {visibleSections.map(({ section, sectionWorkflows }, index) => {
        return (
          <section key={section.key}>
            {index > 0 ? <WorkflowRowDivider /> : null}
            <WorkflowSectionHeader label={section.label} />
            <WorkflowRowList
              workflows={sectionWorkflows}
              entriesByWorkflowId={entriesByWorkflowId}
              displayTimezone={displayTimezone}
              framed={false}
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
  sortMode = "next-run",
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

function FilterPills<T extends string>({
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
    <>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => {
              onChange(option.value);
            }}
            className={cn(
              "inline-flex h-7 shrink-0 cursor-pointer items-center rounded-md border border-border px-2.5 text-sm font-medium leading-none transition-colors",
              active
                ? "bg-muted text-foreground"
                : "bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </>
  );
}

const SORT_OPTIONS: readonly {
  readonly value: WorkflowSortMode;
  readonly label: string;
}[] = [
  { value: "alphabetical", label: "Alphabetical" },
  { value: "created", label: "Created time" },
  { value: "next-run", label: "Next run" },
];

function SortDropdown({
  value,
  onChange,
}: {
  readonly value: WorkflowSortMode;
  readonly onChange: (value: WorkflowSortMode) => void;
}) {
  const current = SORT_OPTIONS.find((option) => {
    return option.value === value;
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="zero-btn-morandi h-9 shrink-0 gap-1.5 rounded-lg border"
        >
          <IconArrowsSort
            size={15}
            stroke={1.8}
            className="text-muted-foreground"
          />
          {current?.label ?? "Next run"}
          <IconChevronDown size={14} stroke={1.8} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {SORT_OPTIONS.map((option) => {
          return (
            <DropdownMenuItem
              key={option.value}
              onSelect={() => {
                onChange(option.value);
              }}
            >
              {option.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function sortWorkflows(
  workflows: readonly ZeroWorkflowSummary[],
  sortMode: WorkflowSortMode,
): readonly ZeroWorkflowSummary[] {
  if (sortMode === "created") {
    return [...workflows].sort((a, b) => {
      return b.createdAt.localeCompare(a.createdAt);
    });
  }
  if (sortMode === "alphabetical") {
    return [...workflows].sort((a, b) => {
      return workflowTitle(a).localeCompare(workflowTitle(b));
    });
  }
  return workflows;
}

function WorkflowFilterBar({
  filter,
  sortMode,
}: {
  readonly filter: WorkflowFilter;
  readonly sortMode: WorkflowSortMode;
}) {
  const setFilter = useSet(setWorkflowFilter$);
  const setSortMode = useSet(setWorkflowSortMode$);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <FilterPills
        value={filter}
        onChange={setFilter}
        options={[
          { value: "all", label: "All" },
          { value: "automated", label: "Automated" },
          { value: "without", label: "Without automation" },
          { value: "private", label: "Private" },
          { value: "public", label: "Public" },
        ]}
      />
      <div className="ml-auto">
        <SortDropdown value={sortMode} onChange={setSortMode} />
      </div>
    </div>
  );
}

export function WorkflowsPage() {
  const filter = useGet(workflowFilter$);
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
    ? sortWorkflows(
        applyWorkflowFilters(workflows, triggerEntriesByWorkflowId, filter),
        sortMode,
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
            variant="outline"
            size="sm"
            className="zero-btn-morandi h-9 shrink-0 gap-2 rounded-lg border"
            onClick={() => {
              openCreateWorkflowDialog();
            }}
          >
            <IconPlus size={14} stroke={2} />
            Create in chat
          </Button>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 pb-8 pt-3 sm:px-6">
        <div className="mx-auto flex max-w-[900px] flex-col gap-4">
          <WorkflowFilterBar filter={filter} sortMode={sortMode} />
          <WorkflowListPanel
            workflows={filteredWorkflows}
            loading={loading}
            sortMode={sortMode}
            emptyDescription={emptyDescriptionForFilter(filter)}
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
    <div className="zero-card overflow-hidden" data-testid="workflows-loading">
      {[0, 1, 2, 3].map((rowIndex) => {
        return (
          <div key={rowIndex}>
            {rowIndex > 0 ? <WorkflowRowDivider /> : null}
            <div className="flex items-center gap-3 px-5 py-3.5">
              <div className="h-8 w-8 shrink-0 rounded-lg bg-muted/40" />
              <div className="h-4 w-40 rounded bg-muted/50" />
              <div className="ml-auto h-8 w-32 rounded-full bg-muted/40" />
              <div className="h-5 w-5 rounded-full bg-muted/40" />
            </div>
          </div>
        );
      })}
    </div>
  );
}
