// Workflow list surfaces for agent-scoped tabs and the workspace index page.
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import type { ZeroWorkflowSummary } from "@vm0/api-contracts/contracts/zero-workflows";
import { Button, Tabs, TabsList, TabsTrigger, cn } from "@vm0/ui";

import { openCreateWorkflowDialog$ } from "../../signals/automation-page/workflow-trigger-automation-dialog.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import {
  allVisibleWorkflows$,
  allWorkflowTriggerEntries$,
  setWorkflowIndexFilterTab$,
  workflowIndexFilterTab$,
  type WorkflowIndexFilterTab,
  type WorkflowTriggerAutomationEntry,
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

type WorkflowGroupKey = "pending" | "public" | "private";
type WorkflowTriggerEntryMap = ReadonlyMap<
  string,
  readonly WorkflowTriggerAutomationEntry[]
>;

const WORKFLOW_GROUPS: readonly {
  readonly key: WorkflowGroupKey;
  readonly label: string;
}[] = [
  { key: "pending", label: "Pending review" },
  { key: "public", label: "Public" },
  { key: "private", label: "Private" },
];

function workflowGroupKey(workflow: ZeroWorkflowSummary): WorkflowGroupKey {
  if (workflow.visibility === "private" && workflow.requestToPublish) {
    return "pending";
  }
  return workflow.visibility;
}

function groupWorkflows(
  workflows: readonly ZeroWorkflowSummary[],
): Record<WorkflowGroupKey, ZeroWorkflowSummary[]> {
  return workflows.reduce<Record<WorkflowGroupKey, ZeroWorkflowSummary[]>>(
    (groups, workflow) => {
      groups[workflowGroupKey(workflow)].push(workflow);
      return groups;
    },
    { pending: [], public: [], private: [] },
  );
}

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

function hasWorkflowTriggers(
  workflow: ZeroWorkflowSummary,
  triggerEntriesByWorkflowId: WorkflowTriggerEntryMap,
): boolean {
  return (triggerEntriesByWorkflowId.get(workflow.id)?.length ?? 0) > 0;
}

function filterWorkflows(
  workflows: readonly ZeroWorkflowSummary[],
  triggerEntriesByWorkflowId: WorkflowTriggerEntryMap,
  filterTab: WorkflowIndexFilterTab,
): readonly ZeroWorkflowSummary[] {
  if (filterTab === "automations") {
    return workflows.filter((workflow) => {
      return hasWorkflowTriggers(workflow, triggerEntriesByWorkflowId);
    });
  }

  return [...workflows].sort((a, b) => {
    const aHasTriggers = hasWorkflowTriggers(a, triggerEntriesByWorkflowId);
    const bHasTriggers = hasWorkflowTriggers(b, triggerEntriesByWorkflowId);
    if (aHasTriggers !== bHasTriggers) {
      return aHasTriggers ? -1 : 1;
    }
    return 0;
  });
}

function pluralizeWorkflow(count: number): string {
  return `${count} workflow${count === 1 ? "" : "s"}`;
}

function ownerLabel(workflow: ZeroWorkflowSummary): string {
  return workflow.ownerUserDisplayName?.trim() || workflow.ownerUserId;
}

function ownerInitials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`.toUpperCase();
  }
  return (words[0]?.slice(0, 2) || "??").toUpperCase();
}

export function WorkflowListPanel({
  workflows,
  loading,
  showAgentColumn,
  emptyDescription,
  triggerEntriesByWorkflowId,
  displayTimezone = new Intl.DateTimeFormat().resolvedOptions().timeZone,
}: {
  readonly workflows: readonly ZeroWorkflowSummary[] | null;
  readonly loading: boolean;
  readonly showAgentColumn: boolean;
  readonly emptyDescription: string;
  readonly triggerEntriesByWorkflowId?: WorkflowTriggerEntryMap;
  readonly displayTimezone?: string;
}) {
  const resolvedTriggerEntriesByWorkflowId =
    triggerEntriesByWorkflowId ??
    new Map<string, readonly WorkflowTriggerAutomationEntry[]>();

  return (
    <section className="min-h-[520px]">
      {loading ? (
        <WorkflowIndexSkeleton />
      ) : workflows && workflows.length > 0 ? (
        <WorkflowGroups
          workflows={workflows}
          showAgentColumn={showAgentColumn}
          triggerEntriesByWorkflowId={resolvedTriggerEntriesByWorkflowId}
          displayTimezone={displayTimezone}
        />
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

function WorkflowGroups({
  workflows,
  showAgentColumn,
  triggerEntriesByWorkflowId,
  displayTimezone,
}: {
  readonly workflows: readonly ZeroWorkflowSummary[];
  readonly showAgentColumn: boolean;
  readonly triggerEntriesByWorkflowId: WorkflowTriggerEntryMap;
  readonly displayTimezone: string;
}) {
  const groups = groupWorkflows(workflows);

  return (
    <div className="flex flex-col gap-4">
      {WORKFLOW_GROUPS.map((group) => {
        const groupWorkflows = groups[group.key];
        if (groupWorkflows.length === 0) {
          return null;
        }

        return (
          <section key={group.key} className="flex flex-col gap-2">
            <div className="flex items-center justify-between px-0.5">
              <h2 className="text-sm font-medium text-muted-foreground">
                {group.label}
              </h2>
              <span className="text-xs text-muted-foreground">
                {pluralizeWorkflow(groupWorkflows.length)}
              </span>
            </div>
            <div className="flex flex-col gap-2.5">
              {groupWorkflows.map((workflow) => {
                return (
                  <WorkflowIndexCard
                    key={workflow.id}
                    workflow={workflow}
                    showAgentColumn={showAgentColumn}
                    triggerEntries={
                      triggerEntriesByWorkflowId.get(workflow.id) ?? []
                    }
                    displayTimezone={displayTimezone}
                  />
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function WorkflowOwner({
  workflow,
}: {
  readonly workflow: ZeroWorkflowSummary;
}) {
  const label = ownerLabel(workflow);
  const imageUrl = workflow.ownerUserImageUrl;

  return (
    <span className="flex min-w-0 shrink-0 items-center gap-2 text-xs font-medium text-muted-foreground">
      {imageUrl ? (
        <span className="h-6 w-6 shrink-0 overflow-hidden rounded-full border border-border/60 bg-gray-50">
          <img
            src={imageUrl}
            alt={label}
            className="h-full w-full object-cover"
          />
        </span>
      ) : (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border/60 bg-gray-50 text-[10px] font-semibold text-muted-foreground">
          {ownerInitials(label)}
        </span>
      )}
      <span className="max-w-[8rem] truncate">{label}</span>
    </span>
  );
}

function WorkflowSlug({ name }: { readonly name: string }) {
  return (
    <span className="inline-flex max-w-full items-center truncate rounded-full bg-gray-50 px-2 py-0.5 text-xs font-normal text-muted-foreground">
      {name}
    </span>
  );
}

function WorkflowIndexCard({
  workflow,
  showAgentColumn,
  triggerEntries,
  displayTimezone,
}: {
  readonly workflow: ZeroWorkflowSummary;
  readonly showAgentColumn: boolean;
  readonly triggerEntries: readonly WorkflowTriggerAutomationEntry[];
  readonly displayTimezone: string;
}) {
  const title = workflowTitle(workflow);

  return (
    <article
      className={cn(
        "zero-card relative px-5 py-4 text-left text-foreground transition-colors hover:bg-gray-50",
        triggerEntries.some((entry) => {
          return !entry.trigger.enabled;
        }) && "opacity-90",
      )}
    >
      <Link
        pathname={ROUTES.workflowDetailAutomations}
        options={{
          pathParams: {
            workflowId: workflow.id,
          },
        }}
        aria-label={`Open ${title}`}
        className="absolute inset-0 z-0 rounded-[inherit] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="sr-only">{title}</span>
      </Link>
      <div className="pointer-events-none relative z-10 flex items-start justify-between gap-4">
        <div className="min-w-0 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {title}
          </span>
          <WorkflowSlug name={workflow.name} />
          {showAgentColumn && <WorkflowSlug name={agentLabel(workflow)} />}
        </div>
        <WorkflowOwner workflow={workflow} />
      </div>
      <div className="pointer-events-none relative z-10 mt-3 text-sm leading-6 text-muted-foreground">
        {workflow.description ?? workflow.name}
      </div>
      <WorkflowCardTriggerFooter
        entries={triggerEntries}
        displayTimezone={displayTimezone}
      />
    </article>
  );
}

function WorkflowCardTriggerFooter({
  entries,
  displayTimezone,
}: {
  readonly entries: readonly WorkflowTriggerAutomationEntry[];
  readonly displayTimezone: string;
}) {
  const [primaryEntry] = entries;
  if (!primaryEntry) {
    return null;
  }
  const remainingCount = entries.length - 1;
  const trigger = primaryEntry.trigger;

  return (
    <div className="pointer-events-none relative z-10 mt-4 border-t border-border/60 pt-3">
      <div
        className={cn(
          "flex min-w-0 items-center gap-3",
          !trigger.enabled && "opacity-75",
        )}
      >
        <TriggerListIcon trigger={trigger} />
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm leading-5 text-muted-foreground">
          <span className="shrink-0">{triggerTypeLabel(trigger)}</span>
          <span className="shrink-0 select-none text-muted-foreground/50">
            ·
          </span>
          <span className="min-w-0 truncate font-medium text-foreground/85">
            {humanReadableTriggerRuleLabel(trigger, displayTimezone)}
          </span>
          {remainingCount > 0 ? (
            <span className="shrink-0 text-xs text-muted-foreground">
              +{remainingCount} more
            </span>
          ) : null}
        </div>
        <div className="pointer-events-auto relative z-20 shrink-0">
          <WorkflowTriggerEnabledSwitch entry={primaryEntry} />
        </div>
      </div>
    </div>
  );
}

function WorkflowFilterTabs({
  value,
  onValueChange,
}: {
  readonly value: WorkflowIndexFilterTab;
  readonly onValueChange: (value: WorkflowIndexFilterTab) => void;
}) {
  return (
    <Tabs
      value={value}
      onValueChange={(nextValue) => {
        if (nextValue === "automations" || nextValue === "all") {
          onValueChange(nextValue);
        }
      }}
    >
      <TabsList className="zero-tabs h-9 gap-1 px-1 py-1">
        <TabsTrigger
          value="automations"
          className="px-3 text-sm data-[state=active]:bg-background"
        >
          Automations
        </TabsTrigger>
        <TabsTrigger
          value="all"
          className="px-3 text-sm data-[state=active]:bg-background"
        >
          All
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

export function WorkflowsPage() {
  const filterTab = useGet(workflowIndexFilterTab$);
  const setFilterTab = useSet(setWorkflowIndexFilterTab$);
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
    ? filterWorkflows(workflows, triggerEntriesByWorkflowId, filterTab)
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
              Reusable instructions your team can run, edit, or trigger.
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
        <div className="mx-auto flex max-w-[900px] flex-col gap-3">
          <WorkflowFilterTabs value={filterTab} onValueChange={setFilterTab} />
          <WorkflowListPanel
            workflows={filteredWorkflows}
            loading={loading}
            showAgentColumn
            emptyDescription={
              filterTab === "automations"
                ? "Add a trigger to a workflow and it will show up here."
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
    <div className="flex flex-col gap-4" data-testid="workflows-loading">
      {[0, 1, 2].map((groupIndex) => {
        return (
          <div key={groupIndex} className="flex flex-col gap-2">
            <div className="flex items-center justify-between px-0.5">
              <div className="h-4 w-24 rounded bg-muted/50" />
              <div className="h-3 w-16 rounded bg-muted/40" />
            </div>
            <div className="zero-card px-5 py-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <div className="h-4 w-40 rounded bg-muted/50" />
                  <div className="h-5 w-28 rounded-full bg-muted/40" />
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <div className="h-6 w-6 rounded-full bg-muted/40" />
                  <div className="h-4 w-16 rounded bg-muted/40" />
                </div>
              </div>
              <div className="mt-3 h-4 w-full rounded bg-muted/40" />
              <div className="mt-2 h-4 w-3/4 rounded bg-muted/30" />
            </div>
          </div>
        );
      })}
    </div>
  );
}
