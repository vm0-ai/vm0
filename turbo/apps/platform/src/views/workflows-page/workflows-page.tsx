// Workflow list surfaces for agent-scoped tabs and the workspace index page.
import { useLastLoadable, useSet } from "ccstate-react";
import type { ZeroWorkflowSummary } from "@vm0/api-contracts/contracts/zero-workflows";
import { IconChevronDown, IconMessageCircle } from "@tabler/icons-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@vm0/ui";

import { openCreateWorkflowDialog$ } from "../../signals/automation-page/workflow-trigger-automation-dialog.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { allVisibleWorkflows$ } from "../../signals/workflows-page/workflows-signals.ts";
import { Link } from "../router/link.tsx";
import { CreateWorkflowAutomationDialog } from "../zero-page/workflow-trigger-automations-page.tsx";
import { agentLabel, workflowTitle } from "./workflow-shared.tsx";

type WorkflowGroupKey = "pending" | "public" | "private";

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
}: {
  readonly workflows: readonly ZeroWorkflowSummary[] | null;
  readonly loading: boolean;
  readonly showAgentColumn: boolean;
  readonly emptyDescription: string;
}) {
  return (
    <section className="min-h-[520px]">
      {loading ? (
        <WorkflowIndexSkeleton />
      ) : workflows && workflows.length > 0 ? (
        <WorkflowGroups
          workflows={workflows}
          showAgentColumn={showAgentColumn}
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
}: {
  readonly workflows: readonly ZeroWorkflowSummary[];
  readonly showAgentColumn: boolean;
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
}: {
  readonly workflow: ZeroWorkflowSummary;
  readonly showAgentColumn: boolean;
}) {
  return (
    <Link
      pathname={ROUTES.workflowDetail}
      options={{ pathParams: { workflowId: workflow.id } }}
      className="zero-card block px-5 py-4 text-left text-foreground no-underline transition-colors hover:bg-gray-50"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {workflowTitle(workflow)}
          </span>
          <WorkflowSlug name={workflow.name} />
          {showAgentColumn && <WorkflowSlug name={agentLabel(workflow)} />}
        </div>
        <WorkflowOwner workflow={workflow} />
      </div>
      <div className="mt-3 text-sm leading-6 text-muted-foreground">
        {workflow.description ?? workflow.name}
      </div>
    </Link>
  );
}

export function WorkflowsPage() {
  const workflowsLoadable = useLastLoadable(allVisibleWorkflows$);
  const openCreateWorkflowDialog = useSet(openCreateWorkflowDialog$);
  const loading = workflowsLoadable.state === "loading";
  const workflows =
    workflowsLoadable.state === "hasData" ? workflowsLoadable.data : null;

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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="sm"
                className="h-9 shrink-0 gap-2 rounded-lg bg-foreground px-3 text-background hover:bg-foreground/90"
              >
                Create with chat
                <IconChevronDown size={14} stroke={1.5} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem
                className="gap-2"
                onClick={() => {
                  openCreateWorkflowDialog();
                }}
              >
                <IconMessageCircle size={14} stroke={1.5} />
                Create with Zero
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 pb-8 pt-3 sm:px-6">
        <div className="mx-auto max-w-[900px]">
          <WorkflowListPanel
            workflows={workflows}
            loading={loading}
            showAgentColumn
            emptyDescription="Create a workflow from chat or save one from a useful run."
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
