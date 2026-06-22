// Read-only cross-agent index of every workflow visible to the user. Each row
// links into the agent-scoped detail page; there are no write actions here.
import { useGet, useLoadable, useSet } from "ccstate-react";
import type { ZeroWorkflowSummary } from "@vm0/api-contracts/contracts/zero-workflows";
import { IconChevronRight, IconSearch } from "@tabler/icons-react";
import { cn } from "@vm0/ui";

import {
  filteredVisibleWorkflows$,
  setWorkflowSearch$,
  workflowSearch$,
} from "../../signals/workflows-page/workflows-signals.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { Link } from "../router/link.tsx";
import {
  agentLabel,
  VisibilityBadge,
  workflowTitle,
} from "./workflow-shared.tsx";

const WORKFLOW_LIST_GRID =
  "grid grid-cols-[minmax(11rem,1.05fr)_minmax(16rem,1.55fr)_9rem_7rem_2.5rem] gap-x-5 items-center";

export function WorkflowsPage() {
  const workflowsLoadable = useLoadable(filteredVisibleWorkflows$);
  const workflows =
    workflowsLoadable.state === "hasData" ? workflowsLoadable.data : null;
  const loading = workflowsLoadable.state === "loading" && !workflows;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 bg-transparent px-4 pb-0 pt-3 sm:px-6 md:pb-3 md:pt-10">
        <div className="mx-auto w-full max-w-[980px]">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
            <div className="hidden min-w-0 md:block">
              <h1 className="text-lg font-semibold tracking-tight text-foreground">
                Workflows
              </h1>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Every workflow you can see, across all agents.
              </p>
            </div>
            <WorkflowsSearch />
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 pb-8 pt-3 sm:px-6">
        <div className="mx-auto max-w-[980px]">
          <WorkflowsIndexPanel workflows={workflows} loading={loading} />
        </div>
      </main>
    </div>
  );
}

function WorkflowsSearch() {
  const search = useGet(workflowSearch$);
  const setSearch = useSet(setWorkflowSearch$);

  return (
    <div className="relative w-full sm:w-64">
      <IconSearch
        size={15}
        stroke={1.5}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60"
      />
      <input
        aria-label="Search workflows"
        type="text"
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
        }}
        placeholder="Search workflows"
        className="h-9 w-full rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input pl-9 pr-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-[3px] focus:ring-primary/10"
      />
    </div>
  );
}

function WorkflowsIndexPanel({
  workflows,
  loading,
}: {
  readonly workflows: readonly ZeroWorkflowSummary[] | null;
  readonly loading: boolean;
}) {
  return (
    <section className="zero-card min-h-[520px] overflow-hidden pb-3">
      <div className="overflow-x-auto">
        <div style={{ minWidth: "940px" }}>
          {(loading || (workflows && workflows.length > 0)) && (
            <div
              className={cn(
                WORKFLOW_LIST_GRID,
                "sticky top-0 z-10 border-b border-border/40 bg-card px-5 py-3 text-sm font-medium text-muted-foreground",
              )}
            >
              <div className="text-left">Workflow</div>
              <div className="text-left">Description</div>
              <div className="text-left">Agent</div>
              <div className="text-left">Visibility</div>
              <div />
            </div>
          )}
          {loading ? (
            <WorkflowIndexSkeleton />
          ) : workflows && workflows.length > 0 ? (
            <div>
              {workflows.map((workflow) => {
                return (
                  <WorkflowIndexRow key={workflow.id} workflow={workflow} />
                );
              })}
            </div>
          ) : (
            <div className="flex min-h-[20rem] flex-col items-center justify-center px-6 text-center">
              <p className="text-sm font-medium text-foreground">
                No workflows
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Workflows you can see across your agents appear here.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function WorkflowIndexRow({
  workflow,
}: {
  readonly workflow: ZeroWorkflowSummary;
}) {
  return (
    <Link
      pathname={ROUTES.agentWorkflowDetail}
      options={{
        pathParams: {
          agentId: workflow.agentId,
          workflowId: workflow.id,
        },
      }}
      className="block w-full border-b border-border/40 px-5 py-3 text-left text-foreground transition-colors last:border-b-0 hover:bg-muted/50"
    >
      <div className={cn(WORKFLOW_LIST_GRID)}>
        <div className="min-w-0 text-left">
          <span className="block truncate text-sm font-medium text-foreground">
            {workflowTitle(workflow)}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {workflow.name}
          </span>
        </div>
        <span className="line-clamp-2 min-w-0 text-left text-sm leading-5 text-muted-foreground">
          {workflow.description ?? workflow.name}
        </span>
        <span className="min-w-0 truncate text-left text-sm text-muted-foreground">
          {agentLabel(workflow)}
        </span>
        <VisibilityBadge
          visibility={workflow.visibility}
          requestToPublish={workflow.requestToPublish}
        />
        <span className="justify-self-start rounded p-1 text-muted-foreground">
          <IconChevronRight size={14} stroke={1.5} />
        </span>
      </div>
    </Link>
  );
}

function WorkflowIndexSkeleton() {
  return (
    <div className="divide-y divide-border/40" data-testid="workflows-loading">
      {[0, 1, 2, 3].map((index) => {
        return (
          <div key={index} className={cn(WORKFLOW_LIST_GRID, "px-5 py-3")}>
            <div className="h-9 w-44 rounded bg-muted/50" />
            <div className="h-4 w-full rounded bg-muted/50" />
            <div className="h-4 w-24 rounded bg-muted/50" />
            <div className="h-6 w-16 rounded-full bg-muted/50" />
            <div className="h-4 w-4 rounded bg-muted/50" />
          </div>
        );
      })}
    </div>
  );
}
