// One agent's workflows: a list plus a create form. Lives at
// /agents/:agentId/workflows.
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { ZeroWorkflowSummary } from "@vm0/api-contracts/contracts/zero-workflows";
import { IconChevronRight, IconLoader2, IconPlus } from "@tabler/icons-react";
import { cn } from "@vm0/ui";

import { currentAgentId$ } from "../../signals/agent.ts";
import {
  agentWorkflows,
  createWorkflow$,
} from "../../signals/workflows-page/workflows-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import { Link } from "../router/link.tsx";
import { VisibilityBadge, workflowTitle } from "./workflow-shared.tsx";

const WORKFLOW_LIST_GRID =
  "grid grid-cols-[minmax(11rem,1.05fr)_minmax(16rem,1.7fr)_7rem_2.5rem] gap-x-5 items-center";
const FIELD_CLASS =
  "h-9 w-full rounded-md border border-border/60 bg-background px-2.5 text-sm outline-none focus:border-primary";

export function AgentWorkflowsPage() {
  const agentId = useGet(currentAgentId$);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 bg-transparent px-4 pb-0 pt-3 sm:px-6 md:pb-3 md:pt-10">
        <div className="mx-auto w-full max-w-[860px]">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            Workflows
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Workflows owned by this agent.
          </p>
        </div>
      </header>
      <main className="flex-1 overflow-auto px-4 pb-8 pt-3 sm:px-6">
        <div className="mx-auto flex max-w-[860px] flex-col gap-4">
          {agentId ? (
            <>
              <CreateWorkflowForm agentId={agentId} />
              <AgentWorkflowsList agentId={agentId} />
            </>
          ) : null}
        </div>
      </main>
    </div>
  );
}

function CreateWorkflowForm({ agentId }: { readonly agentId: string }) {
  const pageSignal = useGet(pageSignal$);
  const navigate = useSet(detachedNavigateTo$);
  const [createLoadable, createWorkflow] = useLoadableSet(createWorkflow$);
  const creating = createLoadable.state === "loading";

  return (
    <form
      aria-label="Create workflow"
      className="zero-card flex flex-col gap-2 p-4 sm:flex-row sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const name = String(form.get("name") ?? "").trim();
        const displayName = String(form.get("displayName") ?? "").trim();
        if (!name) {
          return;
        }
        detach(
          (async () => {
            const workflow = await createWorkflow(
              { agentId, name, displayName: displayName || undefined },
              pageSignal,
            );
            navigate(ROUTES.agentWorkflowDetail, {
              pathParams: { agentId, workflowId: workflow.id },
            });
          })(),
          Reason.DomCallback,
        );
      }}
    >
      <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
        Slug
        <input
          name="name"
          aria-label="Workflow slug"
          required
          disabled={creating}
          placeholder="daily-brief"
          className={FIELD_CLASS}
        />
      </label>
      <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
        Display name
        <input
          name="displayName"
          aria-label="Workflow display name"
          disabled={creating}
          placeholder="Daily Brief"
          className={FIELD_CLASS}
        />
      </label>
      <button
        type="submit"
        disabled={creating}
        className={cn(
          "zero-btn-morandi inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-sm",
          creating ? "cursor-not-allowed opacity-60" : "",
        )}
      >
        {creating ? (
          <IconLoader2 size={14} className="animate-spin" />
        ) : (
          <IconPlus size={14} stroke={1.5} />
        )}
        <span>Create</span>
      </button>
    </form>
  );
}

function AgentWorkflowsList({ agentId }: { readonly agentId: string }) {
  const workflowsLoadable = useLoadable(agentWorkflows(agentId));
  const workflows =
    workflowsLoadable.state === "hasData" ? workflowsLoadable.data : null;
  const loading = workflowsLoadable.state === "loading" && !workflows;

  return (
    <section className="zero-card overflow-hidden pb-3">
      <div className="overflow-x-auto">
        <div style={{ minWidth: "720px" }}>
          {(loading || (workflows && workflows.length > 0)) && (
            <div
              className={cn(
                WORKFLOW_LIST_GRID,
                "border-b border-border/40 px-5 py-3 text-sm font-medium text-muted-foreground",
              )}
            >
              <div className="text-left">Workflow</div>
              <div className="text-left">Description</div>
              <div className="text-left">Visibility</div>
              <div />
            </div>
          )}
          {loading ? (
            <WorkflowRowsSkeleton />
          ) : workflows && workflows.length > 0 ? (
            <div>
              {workflows.map((workflow) => {
                return (
                  <AgentWorkflowRow
                    key={workflow.id}
                    agentId={agentId}
                    workflow={workflow}
                  />
                );
              })}
            </div>
          ) : (
            <div className="flex min-h-[12rem] flex-col items-center justify-center px-6 text-center">
              <p className="text-sm font-medium text-foreground">
                No workflows yet
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Create one above to get started.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function AgentWorkflowRow({
  agentId,
  workflow,
}: {
  readonly agentId: string;
  readonly workflow: ZeroWorkflowSummary;
}) {
  return (
    <Link
      pathname={ROUTES.agentWorkflowDetail}
      options={{ pathParams: { agentId, workflowId: workflow.id } }}
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

function WorkflowRowsSkeleton() {
  return (
    <div className="divide-y divide-border/40" data-testid="workflows-loading">
      {[0, 1, 2].map((index) => {
        return (
          <div key={index} className={cn(WORKFLOW_LIST_GRID, "px-5 py-3")}>
            <div className="h-9 w-44 rounded bg-muted/50" />
            <div className="h-4 w-full rounded bg-muted/50" />
            <div className="h-6 w-16 rounded-full bg-muted/50" />
            <div className="h-4 w-4 rounded bg-muted/50" />
          </div>
        );
      })}
    </div>
  );
}
