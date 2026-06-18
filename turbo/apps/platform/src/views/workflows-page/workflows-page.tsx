import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type {
  ZeroWorkflowAgentSummary,
  ZeroWorkflowDetailResponse,
  ZeroWorkflowSchedule,
  ZeroWorkflowScheduleType,
  ZeroWorkflowSummary,
  ZeroWorkflowTriggerSummary,
  WorkflowFileMetadata,
} from "@vm0/api-contracts/contracts/zero-workflows";
import {
  IconChevronRight,
  IconClock,
  IconFile,
  IconFolderOpen,
  IconGitBranch,
  IconLock,
  IconLoader2,
  IconPlus,
  IconSearch,
  IconUsers,
  IconWorld,
  IconX,
} from "@tabler/icons-react";
import {
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui";

import {
  attachSelectedWorkflowAgent$,
  createWorkflowScheduleTrigger$,
  deleteWorkflowScheduleTrigger$,
  detachSelectedWorkflowAgent$,
  filteredOrgWorkflows$,
  runWorkflowScheduleTrigger$,
  setWorkflowTriggerEnabled$,
  selectedWorkflowAgentId$,
  selectedWorkflowDetail$,
  selectedWorkflowFilePath$,
  selectedWorkflowName$,
  setSelectedWorkflowAgentId$,
  setSelectedWorkflowFilePath$,
  setSelectedWorkflowName$,
  setWorkflowAttachmentFilter$,
  setWorkflowSearch$,
  workflowAttachableAgents$,
  workflowAgentOptions$,
  workflowAttachmentFilter$,
  workflowSearch$,
  type WorkflowAttachmentFilter,
} from "../../signals/workflows-page/workflows-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { user$ } from "../../signals/auth.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Markdown } from "../components/markdown.tsx";
import { Link } from "../router/link.tsx";
import { AvatarFromUrl } from "../zero-page/zero-sidebar-shared.tsx";

const ALL_AGENTS_FILTER = "all";
const LIST_AVATAR_LIMIT = 5;
const WORKFLOW_LIST_GRID =
  "grid grid-cols-[minmax(11rem,1.05fr)_minmax(16rem,1.55fr)_7rem_8rem_2.5rem] gap-x-5 items-center";
const LEADING_YAML_FRONTMATTER_PATTERN =
  /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const FILE_TREE_BASE_PADDING_PX = 8;
const FILE_TREE_INDENT_PX = 16;

type WorkflowFileTreeNode =
  | WorkflowFileTreeFolderNode
  | WorkflowFileTreeFileNode;

type WorkflowFileTreeFolderNode = {
  readonly kind: "folder";
  readonly name: string;
  readonly path: string;
  readonly children: readonly WorkflowFileTreeNode[];
};

type WorkflowFileTreeFileNode = {
  readonly kind: "file";
  readonly name: string;
  readonly path: string;
  readonly size: number;
};

type MutableWorkflowFileTreeNode =
  | MutableWorkflowFileTreeFolderNode
  | WorkflowFileTreeFileNode;

type MutableWorkflowFileTreeFolderNode = {
  readonly kind: "folder";
  readonly name: string;
  readonly path: string;
  readonly children: MutableWorkflowFileTreeNode[];
  readonly folders: Map<string, MutableWorkflowFileTreeFolderNode>;
};

function workflowTitle(workflow: {
  readonly name: string;
  readonly displayName: string | null;
}): string {
  return workflow.displayName ?? workflow.name;
}

function agentTitle(agent: ZeroWorkflowAgentSummary): string {
  return agent.displayName ?? agent.agentId;
}

function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

function stripMarkdownFrontmatter(content: string): string {
  return content.replace(LEADING_YAML_FRONTMATTER_PATTERN, "");
}

function filePathSegments(path: string): readonly string[] {
  return path.split("/").filter((segment) => {
    return segment.length > 0;
  });
}

function toWorkflowFileTreeNode(
  node: MutableWorkflowFileTreeNode,
): WorkflowFileTreeNode {
  if (node.kind === "file") {
    return node;
  }

  return {
    kind: "folder",
    name: node.name,
    path: node.path,
    children: node.children.map(toWorkflowFileTreeNode),
  };
}

function buildWorkflowFileTree(
  files: readonly WorkflowFileMetadata[],
): readonly WorkflowFileTreeNode[] {
  const root: MutableWorkflowFileTreeFolderNode = {
    kind: "folder",
    name: "",
    path: "",
    children: [],
    folders: new Map(),
  };

  for (const file of files) {
    const segments = filePathSegments(file.path);
    const fileName = segments.at(-1);
    if (!fileName) {
      continue;
    }

    let currentFolder = root;
    for (const folderName of segments.slice(0, -1)) {
      const folderPath = currentFolder.path
        ? `${currentFolder.path}/${folderName}`
        : folderName;
      const existingFolder = currentFolder.folders.get(folderName);
      if (existingFolder) {
        currentFolder = existingFolder;
        continue;
      }

      const folder: MutableWorkflowFileTreeFolderNode = {
        kind: "folder",
        name: folderName,
        path: folderPath,
        children: [],
        folders: new Map(),
      };
      currentFolder.folders.set(folderName, folder);
      currentFolder.children.push(folder);
      currentFolder = folder;
    }

    currentFolder.children.push({
      kind: "file",
      name: fileName,
      path: file.path,
      size: file.size,
    });
  }

  return root.children.map(toWorkflowFileTreeNode);
}

export function WorkflowsPage() {
  const workflowsLoadable = useLoadable(filteredOrgWorkflows$);
  const selectedWorkflowName = useGet(selectedWorkflowName$);
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
                Browse workflow packages and attached agents.
              </p>
            </div>
            <WorkflowsToolbar />
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 pb-8 pt-3 sm:px-6">
        <div className="mx-auto max-w-[980px]">
          <WorkflowsListPanel
            workflows={workflows}
            loading={loading}
            selectedWorkflowName={selectedWorkflowName}
          />
        </div>
      </main>
      <WorkflowDetailDialog open={selectedWorkflowName !== null} />
    </div>
  );
}

function WorkflowsListPanel({
  workflows,
  loading,
  selectedWorkflowName,
}: {
  readonly workflows: readonly ZeroWorkflowSummary[] | null;
  readonly loading: boolean;
  readonly selectedWorkflowName: string | null | undefined;
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
              <div className="text-left">Visibility</div>
              <div className="text-left">Attached to</div>
              <div />
            </div>
          )}
          {loading ? (
            <WorkflowListSkeleton />
          ) : workflows && workflows.length > 0 ? (
            <div>
              {workflows.map((workflow) => {
                return (
                  <WorkflowListItem
                    key={workflow.name}
                    workflow={workflow}
                    selected={workflow.name === selectedWorkflowName}
                  />
                );
              })}
            </div>
          ) : (
            <div className="flex min-h-[20rem] flex-col items-center justify-center px-6 text-center">
              <p className="text-sm font-medium text-foreground">
                No workflows
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                New workflow packages appear here.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function WorkflowsToolbar() {
  const search = useGet(workflowSearch$);
  const selectedAgentId = useGet(selectedWorkflowAgentId$);
  const attachmentFilter = useGet(workflowAttachmentFilter$);
  const setSearch = useSet(setWorkflowSearch$);
  const setSelectedAgentId = useSet(setSelectedWorkflowAgentId$);
  const setAttachmentFilter = useSet(setWorkflowAttachmentFilter$);
  const agentsLoadable = useLoadable(workflowAgentOptions$);
  const agents = agentsLoadable.state === "hasData" ? agentsLoadable.data : [];

  return (
    <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
      <div className="sm:w-36">
        <Select
          value={attachmentFilter}
          onValueChange={(value) => {
            setAttachmentFilter(value as WorkflowAttachmentFilter);
          }}
        >
          <SelectTrigger
            aria-label="Attachment filter"
            className="zero-btn-morandi h-9 w-full gap-1.5 rounded-lg px-3.5 text-sm font-medium"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="attached">Attached</SelectItem>
            <SelectItem value="unbound">Unbound</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="sm:w-48">
        <Select
          value={selectedAgentId ?? ALL_AGENTS_FILTER}
          onValueChange={(value) => {
            setSelectedAgentId(value === ALL_AGENTS_FILTER ? null : value);
          }}
        >
          <SelectTrigger
            aria-label="Agent filter"
            className="zero-btn-morandi h-9 w-full gap-1.5 rounded-lg px-3.5 text-sm font-medium"
          >
            <IconUsers size={14} stroke={1.5} className="shrink-0" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_AGENTS_FILTER}>All agents</SelectItem>
            {agents.map((agent) => {
              return (
                <SelectItem key={agent.agentId} value={agent.agentId}>
                  {agentTitle(agent)}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>
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
    </div>
  );
}

function WorkflowListItem({
  workflow,
  selected,
}: {
  readonly workflow: ZeroWorkflowSummary;
  readonly selected: boolean;
}) {
  const selectWorkflow = useSet(setSelectedWorkflowName$);

  return (
    <button
      type="button"
      className={cn(
        "block w-full cursor-pointer border-b border-border/40 px-5 py-3 text-left text-inherit transition-colors last:border-b-0",
        selected
          ? "bg-muted/60 text-foreground"
          : "text-foreground hover:bg-muted/50",
      )}
      onClick={() => {
        selectWorkflow(workflow.name);
      }}
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
        <VisibilityBadge visibility={workflow.visibility} />
        <AgentAvatarStack
          agents={workflow.attachedAgents}
          count={workflow.attachedAgentCount}
        />
        <span className="justify-self-start rounded p-1 text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground">
          <IconChevronRight size={14} stroke={1.5} />
        </span>
      </div>
    </button>
  );
}

function WorkflowListSkeleton() {
  return (
    <div className="divide-y divide-border/40" data-testid="workflows-loading">
      {[0, 1, 2, 3].map((index) => {
        return (
          <div key={index} className={cn(WORKFLOW_LIST_GRID, "px-5 py-3")}>
            <div className="h-9 w-44 rounded bg-muted/50" />
            <div className="h-4 w-full rounded bg-muted/50" />
            <div className="h-6 w-16 rounded-full bg-muted/50" />
            <div className="h-7 w-20 rounded-full bg-muted/50" />
            <div className="h-4 w-4 rounded bg-muted/50" />
          </div>
        );
      })}
    </div>
  );
}

function WorkflowDetailDialog({ open }: { readonly open: boolean }) {
  const setSelectedWorkflowName = useSet(setSelectedWorkflowName$);
  const detailLoadable = useLoadable(selectedWorkflowDetail$);
  const selectedWorkflowName = useGet(selectedWorkflowName$);
  const detail =
    detailLoadable.state === "hasData" ? detailLoadable.data : null;
  const loading = detailLoadable.state === "loading" && !detail;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setSelectedWorkflowName(null);
        }
      }}
    >
      <DialogContent
        aria-describedby="workflow-detail-dialog-description"
        className="max-w-[940px] gap-0 overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">Workflow details</DialogTitle>
        <DialogDescription
          id="workflow-detail-dialog-description"
          className="sr-only"
        >
          View workflow package content, visibility, attachments, triggers, and
          files.
        </DialogDescription>
        {loading || !selectedWorkflowName || !detail ? (
          <WorkflowDetailSkeleton />
        ) : (
          <WorkflowViewer detail={detail} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function WorkflowViewer({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  const explicitSelectedFilePath = useGet(selectedWorkflowFilePath$);
  const setSelectedFilePath = useSet(setSelectedWorkflowFilePath$);
  const files = detail.files ?? [];
  const preferredFilePath =
    files.find((file) => {
      return file.path === "SKILL.md";
    })?.path ??
    files[0]?.path ??
    (detail.content !== null ? "SKILL.md" : null);
  const selectedFilePath = explicitSelectedFilePath ?? preferredFilePath;
  const selectedFile = selectedFilePath
    ? (detail.fileContents ?? []).find((file) => {
        return file.path === selectedFilePath;
      })
    : null;
  const selectedContent = selectedFilePath
    ? (selectedFile?.content ??
      (selectedFilePath === "SKILL.md" ? detail.content : null))
    : null;

  return (
    <div className="flex max-h-[88vh] min-w-0 flex-col overflow-hidden">
      <DialogHeader className="shrink-0 border-b border-border/70 px-5 py-4 pr-14">
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold leading-none tracking-tight">
              {workflowTitle(detail)}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {detail.description ?? detail.name}
            </p>
          </div>
          <VisibilityBadge visibility={detail.visibility} />
        </div>
      </DialogHeader>

      <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="flex min-h-0 flex-col">
          <div className="flex h-9 shrink-0 items-center border-b border-border/70 px-4 text-xs font-medium text-muted-foreground">
            <span className="truncate">
              {selectedFilePath ?? "No file selected"}
            </span>
          </div>
          {selectedFilePath && selectedContent !== null ? (
            isMarkdownPath(selectedFilePath) ? (
              <div
                aria-label="Workflow package content"
                className="min-h-[420px] flex-1 overflow-auto bg-background px-4 py-3"
              >
                <Markdown source={stripMarkdownFrontmatter(selectedContent)} />
              </div>
            ) : (
              <pre
                aria-label="Workflow package content"
                className="min-h-[420px] flex-1 overflow-auto whitespace-pre-wrap bg-background px-4 py-3 font-mono text-sm leading-6 text-foreground"
              >
                {selectedContent}
              </pre>
            )
          ) : (
            <div className="flex min-h-[420px] flex-1 items-center justify-center px-4 text-sm text-muted-foreground">
              {selectedFilePath
                ? "No content available for this file."
                : "No files."}
            </div>
          )}
        </div>
        <aside className="min-h-0 border-t border-border/70 bg-muted/20 lg:border-l lg:border-t-0">
          <AttachedAgentsPanel workflow={detail} />
          <WorkflowTriggersPanel workflow={detail} />
          <WorkflowFiles
            files={files}
            selectedPath={selectedFilePath}
            onSelectFile={setSelectedFilePath}
          />
        </aside>
      </div>
    </div>
  );
}

function VisibilityBadge({
  visibility,
}: {
  readonly visibility: ZeroWorkflowSummary["visibility"];
}) {
  const isPrivate = visibility === "private";
  const Icon = isPrivate ? IconLock : IconWorld;

  return (
    <span className="inline-flex h-6 max-w-full items-center gap-1 rounded-full border border-border/60 px-2 text-xs font-medium capitalize text-muted-foreground">
      <Icon size={12} stroke={1.5} className="shrink-0" />
      <span className="truncate">{visibility}</span>
    </span>
  );
}

function triggerKindLabel(kind: ZeroWorkflowTriggerSummary["kind"]): string {
  if (kind === "schedule") {
    return "Schedule trigger";
  }

  if (kind === "webhook") {
    return "Webhook trigger";
  }

  return "Event trigger";
}

const TRIGGER_TIMEZONE = "UTC";

function buildTriggerSchedule(
  type: ZeroWorkflowScheduleType,
  fields: {
    readonly cronExpression: string;
    readonly intervalSeconds: string;
    readonly atTime: string;
  },
): ZeroWorkflowSchedule | null {
  if (type === "cron") {
    const cronExpression = fields.cronExpression.trim();
    return cronExpression
      ? { type: "cron", cronExpression, timezone: TRIGGER_TIMEZONE }
      : null;
  }
  if (type === "loop") {
    const intervalSeconds = Number(fields.intervalSeconds);
    return Number.isInteger(intervalSeconds) && intervalSeconds > 0
      ? { type: "loop", intervalSeconds }
      : null;
  }
  if (!fields.atTime) {
    return null;
  }
  const atTime = new Date(fields.atTime);
  return Number.isNaN(atTime.getTime())
    ? null
    : {
        type: "once",
        atTime: atTime.toISOString(),
        timezone: TRIGGER_TIMEZONE,
      };
}

const TRIGGER_FIELD_CLASS =
  "h-8 w-full rounded-md border border-border/60 bg-background px-2 text-xs";

function CreateWorkflowTriggerForm({
  agents,
}: {
  readonly agents: readonly ZeroWorkflowAgentSummary[];
}) {
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createTrigger] = useLoadableSet(
    createWorkflowScheduleTrigger$,
  );
  const creating = createLoadable.state === "loading";

  // Uncontrolled form (the platform forbids React local state): the fields are
  // read from FormData on submit, and all three schedule inputs are shown so the
  // user fills the one matching the selected type.
  return (
    <form
      aria-label="Create schedule trigger"
      className="flex flex-col gap-1.5 px-2 pb-2"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const agentId = String(form.get("agentId") ?? "");
        const scheduleType = String(
          form.get("scheduleType") ?? "cron",
        ) as ZeroWorkflowScheduleType;
        const schedule = buildTriggerSchedule(scheduleType, {
          cronExpression: String(form.get("cronExpression") ?? ""),
          intervalSeconds: String(form.get("intervalSeconds") ?? ""),
          atTime: String(form.get("atTime") ?? ""),
        });
        if (!schedule || agentId === "") {
          return;
        }
        detach(
          createTrigger({ agentId, schedule }, pageSignal),
          Reason.DomCallback,
        );
      }}
    >
      <select
        name="agentId"
        aria-label="Trigger agent"
        defaultValue={agents[0]?.agentId}
        disabled={creating}
        className={TRIGGER_FIELD_CLASS}
      >
        {agents.map((agent) => {
          return (
            <option key={agent.agentId} value={agent.agentId}>
              {agentTitle(agent)}
            </option>
          );
        })}
      </select>
      <select
        name="scheduleType"
        aria-label="Schedule type"
        defaultValue="cron"
        disabled={creating}
        className={TRIGGER_FIELD_CLASS}
      >
        <option value="cron">Repeat (cron)</option>
        <option value="loop">Loop (interval)</option>
        <option value="once">Once</option>
      </select>
      <input
        name="cronExpression"
        aria-label="Cron expression"
        defaultValue="0 9 * * *"
        disabled={creating}
        placeholder="cron, e.g. 0 9 * * *"
        className={TRIGGER_FIELD_CLASS}
      />
      <input
        name="intervalSeconds"
        aria-label="Interval seconds"
        type="number"
        min="1"
        defaultValue="3600"
        disabled={creating}
        placeholder="loop interval seconds"
        className={TRIGGER_FIELD_CLASS}
      />
      <input
        name="atTime"
        aria-label="Run at"
        type="datetime-local"
        disabled={creating}
        className={TRIGGER_FIELD_CLASS}
      />
      <button
        type="submit"
        disabled={creating}
        className={cn(
          "zero-btn-morandi inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-xs",
          creating ? "cursor-not-allowed opacity-60" : "",
        )}
      >
        {creating ? (
          <IconLoader2 size={13} className="animate-spin" />
        ) : (
          <IconPlus size={13} stroke={1.5} />
        )}
        <span>Add trigger</span>
      </button>
    </form>
  );
}

function WorkflowTriggersPanel({
  workflow,
}: {
  readonly workflow: ZeroWorkflowDetailResponse;
}) {
  const userLoadable = useLoadable(user$);
  const currentUserId =
    userLoadable.state === "hasData" ? (userLoadable.data?.id ?? "") : "";
  const triggers = workflow.triggers;

  return (
    <div className="border-b border-border/70">
      <div className="flex h-9 items-center justify-between px-3">
        <span className="text-xs font-medium text-muted-foreground">
          Triggers
        </span>
        <span className="text-xs text-muted-foreground">{triggers.length}</span>
      </div>
      {workflow.attachedAgents.length > 0 ? (
        <CreateWorkflowTriggerForm agents={workflow.attachedAgents} />
      ) : null}
      <div className="max-h-[260px] overflow-auto px-2 pb-2">
        {triggers.length > 0 ? (
          <div className="flex flex-col gap-1">
            {triggers.map((trigger) => {
              return (
                <WorkflowTriggerRow
                  key={trigger.id}
                  trigger={trigger}
                  canManage={trigger.ownerUserId === currentUserId}
                />
              );
            })}
          </div>
        ) : (
          <p className="px-2 pb-3 text-xs text-muted-foreground">
            No triggers.
          </p>
        )}
      </div>
    </div>
  );
}

function WorkflowTriggerRow({
  trigger,
  canManage,
}: {
  readonly trigger: ZeroWorkflowTriggerSummary;
  readonly canManage: boolean;
}) {
  const pageSignal = useGet(pageSignal$);
  const [enabledLoadable, setEnabled] = useLoadableSet(
    setWorkflowTriggerEnabled$,
  );
  const [deleteLoadable, deleteTrigger] = useLoadableSet(
    deleteWorkflowScheduleTrigger$,
  );
  const [runLoadable, runTrigger] = useLoadableSet(runWorkflowScheduleTrigger$);
  const busy =
    enabledLoadable.state === "loading" ||
    deleteLoadable.state === "loading" ||
    runLoadable.state === "loading";
  const Icon = trigger.kind === "schedule" ? IconClock : IconGitBranch;
  const reassignNeeded = trigger.agentId === null;
  const secondaryLabel = reassignNeeded
    ? "Agent deleted — reassign an agent"
    : triggerKindLabel(trigger.kind);

  return (
    <div className="flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground">
        <Icon size={13} stroke={1.5} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-xs font-medium text-foreground">
            {trigger.scheduleSummary}
          </span>
          <span
            className={cn(
              "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
              trigger.enabled
                ? "bg-emerald-500/10 text-emerald-700"
                : "bg-muted text-muted-foreground",
            )}
          >
            {trigger.enabled ? "Enabled" : "Paused"}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {secondaryLabel}
        </p>
        {trigger.chatThreadId ? (
          <Link
            pathname={ROUTES.chat}
            options={{ pathParams: { threadId: trigger.chatThreadId } }}
            className="mt-1 inline-flex text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Open thread
          </Link>
        ) : null}
        {canManage ? (
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              className="text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
              onClick={() => {
                detach(runTrigger(trigger.id, pageSignal), Reason.DomCallback);
              }}
            >
              Test run
            </button>
            <button
              type="button"
              disabled={busy || reassignNeeded}
              className="text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
              onClick={() => {
                detach(
                  setEnabled(
                    { triggerId: trigger.id, enabled: !trigger.enabled },
                    pageSignal,
                  ),
                  Reason.DomCallback,
                );
              }}
            >
              {trigger.enabled ? "Pause" : "Resume"}
            </button>
            <button
              type="button"
              disabled={busy}
              className="text-xs text-destructive/80 transition-colors hover:text-destructive disabled:opacity-60"
              onClick={() => {
                detach(
                  deleteTrigger(trigger.id, pageSignal),
                  Reason.DomCallback,
                );
              }}
            >
              Delete
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AttachedAgentsPanel({
  workflow,
}: {
  readonly workflow: ZeroWorkflowDetailResponse;
}) {
  const attachableAgentsLoadable = useLoadable(workflowAttachableAgents$);
  const pageSignal = useGet(pageSignal$);
  const [attachLoadable, attachAgent] = useLoadableSet(
    attachSelectedWorkflowAgent$,
  );
  const [detachLoadable, detachAgent] = useLoadableSet(
    detachSelectedWorkflowAgent$,
  );
  const attachableAgents =
    attachableAgentsLoadable.state === "hasData"
      ? attachableAgentsLoadable.data
      : [];
  const attachableAgentsLoading = attachableAgentsLoadable.state === "loading";
  const attaching = attachLoadable.state === "loading";
  const detaching = detachLoadable.state === "loading";
  const busy = attaching || detaching;
  const attachDisabled =
    busy || attachableAgentsLoading || attachableAgents.length === 0;
  const attachPlaceholder = attachableAgentsLoading
    ? "Loading agents"
    : attachableAgents.length === 0
      ? "No agents available"
      : "Attach agent";

  return (
    <div className="border-b border-border/70">
      <div className="flex h-9 items-center justify-between px-3">
        <span className="text-xs font-medium text-muted-foreground">
          Attached agents
        </span>
        <span className="text-xs text-muted-foreground">
          {workflow.attachedAgentCount}
        </span>
      </div>
      {workflow.canManage ? (
        <div className="px-2 pb-2">
          <Select
            value=""
            disabled={attachDisabled}
            onValueChange={(agentId) => {
              detach(attachAgent(agentId, pageSignal), Reason.DomCallback);
            }}
          >
            <SelectTrigger
              aria-label="Attach workflow to agent"
              className="zero-btn-morandi h-8 w-full gap-1.5 rounded-md px-2 text-xs"
            >
              {attaching ? (
                <IconLoader2 size={13} className="shrink-0 animate-spin" />
              ) : (
                <IconPlus size={13} stroke={1.5} className="shrink-0" />
              )}
              <SelectValue placeholder={attachPlaceholder} />
            </SelectTrigger>
            <SelectContent>
              {attachableAgents.map((agent) => {
                return (
                  <SelectItem key={agent.agentId} value={agent.agentId}>
                    {agentTitle(agent)}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <div className="max-h-[180px] overflow-auto px-2 pb-2">
        {workflow.attachedAgents.length > 0 ? (
          <div className="flex flex-col gap-1">
            {workflow.attachedAgents.map((agent) => {
              const title = agentTitle(agent);
              return (
                <div
                  key={agent.agentId}
                  className="flex min-w-0 items-center gap-1 rounded-md"
                >
                  <Link
                    pathname={ROUTES.agentDetail}
                    options={{ pathParams: { agentId: agent.agentId } }}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                  >
                    <AgentAvatar agent={agent} />
                    <span className="truncate">{title}</span>
                  </Link>
                  {workflow.canManage ? (
                    <button
                      type="button"
                      aria-label={`Detach workflow from ${title}`}
                      disabled={busy}
                      className={cn(
                        "inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors",
                        busy
                          ? "cursor-not-allowed opacity-60"
                          : "hover:bg-accent hover:text-foreground",
                      )}
                      onClick={() => {
                        detach(
                          detachAgent(agent.agentId, pageSignal),
                          Reason.DomCallback,
                        );
                      }}
                    >
                      {detaching ? (
                        <IconLoader2 size={13} className="animate-spin" />
                      ) : (
                        <IconX size={13} stroke={1.5} />
                      )}
                      <span>Detach</span>
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="px-2 pb-3 text-xs text-muted-foreground">
            Not attached to any agent.
          </p>
        )}
      </div>
    </div>
  );
}

function AgentAvatar({ agent }: { readonly agent: ZeroWorkflowAgentSummary }) {
  const title = agentTitle(agent);
  if (agent.avatarUrl) {
    return (
      <AvatarFromUrl
        avatarUrl={agent.avatarUrl}
        alt={title}
        size={24}
        className="size-6 shrink-0 rounded-full object-cover"
      />
    );
  }

  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-background text-[10px] text-muted-foreground">
      {title.slice(0, 1).toUpperCase()}
    </span>
  );
}

function AgentAvatarStack({
  agents,
  count,
}: {
  readonly agents: readonly ZeroWorkflowAgentSummary[];
  readonly count: number;
}) {
  if (count === 0) {
    return (
      <span className="text-xs text-muted-foreground" aria-label="Unbound">
        Unbound
      </span>
    );
  }

  const visibleAgents = agents.slice(0, LIST_AVATAR_LIMIT);
  const overflow = count - visibleAgents.length;

  return (
    <span
      className="flex min-w-0 items-center"
      aria-label={`${count} ${count === 1 ? "agent" : "agents"} attached to this workflow`}
    >
      {visibleAgents.map((agent, index) => {
        return (
          <span
            key={agent.agentId}
            className={`rounded-full ring-2 ring-background ${
              index === 0 ? "" : "-ml-2"
            }`}
          >
            <AgentAvatar agent={agent} />
          </span>
        );
      })}
      {overflow > 0 ? (
        <span
          className="-ml-2 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground ring-2 ring-background"
          aria-label={`${overflow} more ${overflow === 1 ? "agent" : "agents"}`}
        >
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}

function WorkflowFiles({
  files,
  selectedPath,
  onSelectFile,
}: {
  readonly files: readonly WorkflowFileMetadata[];
  readonly selectedPath: string | null;
  readonly onSelectFile: (path: string) => void;
}) {
  const tree = buildWorkflowFileTree(files);

  return (
    <div className="min-h-0">
      <div className="flex h-9 items-center justify-between border-b border-border/70 px-3">
        <span className="text-xs font-medium text-muted-foreground">
          Package files
        </span>
        <span className="text-xs text-muted-foreground">{files.length}</span>
      </div>
      <div className="max-h-[240px] overflow-auto p-2 lg:max-h-none">
        {files.length > 0 ? (
          <WorkflowFileTree
            nodes={tree}
            depth={0}
            selectedPath={selectedPath}
            onSelectFile={onSelectFile}
          />
        ) : (
          <p className="px-2 pb-3 text-xs text-muted-foreground">No files.</p>
        )}
      </div>
    </div>
  );
}

function WorkflowFileTree({
  nodes,
  depth,
  selectedPath,
  onSelectFile,
}: {
  readonly nodes: readonly WorkflowFileTreeNode[];
  readonly depth: number;
  readonly selectedPath: string | null;
  readonly onSelectFile: (path: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      {nodes.map((node) => {
        if (node.kind === "folder") {
          return (
            <div key={node.path} className="min-w-0">
              <div
                className="flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-foreground"
                style={{
                  paddingLeft:
                    FILE_TREE_BASE_PADDING_PX + depth * FILE_TREE_INDENT_PX,
                }}
              >
                <IconFolderOpen
                  size={14}
                  stroke={1.5}
                  className="shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 truncate text-xs font-medium">
                  {node.name}
                </span>
              </div>
              <WorkflowFileTree
                nodes={node.children}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelectFile={onSelectFile}
              />
            </div>
          );
        }

        const selected = node.path === selectedPath;
        return (
          <button
            key={node.path}
            type="button"
            aria-label={`Open ${node.path}`}
            aria-pressed={selected}
            className={cn(
              "flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-md py-1.5 pr-2 text-left transition-colors",
              selected
                ? "bg-accent text-accent-foreground"
                : "text-foreground hover:bg-accent/70",
            )}
            style={{
              paddingLeft:
                FILE_TREE_BASE_PADDING_PX + depth * FILE_TREE_INDENT_PX,
            }}
            onClick={() => {
              onSelectFile(node.path);
            }}
          >
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <IconFile
                size={14}
                stroke={1.5}
                className="shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 truncate text-xs">{node.name}</span>
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatBytes(node.size)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function WorkflowDetailSkeleton() {
  return (
    <div className="flex h-[640px] flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border/70 px-5 py-4 pr-14">
        <div className="h-5 w-52 rounded bg-muted/60" />
        <div className="mt-2 h-4 w-80 rounded bg-muted/40" />
      </div>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="flex min-h-0 flex-col">
          <div className="h-9 shrink-0 border-b border-border/70 px-4 py-2">
            <div className="h-4 w-40 rounded bg-muted/40" />
          </div>
          <div className="flex-1 space-y-3 px-4 py-3">
            <div className="h-4 w-full rounded bg-muted/40" />
            <div className="h-4 w-5/6 rounded bg-muted/40" />
            <div className="h-4 w-2/3 rounded bg-muted/40" />
          </div>
        </div>
        <aside className="hidden border-l border-border/70 bg-muted/20 p-3 lg:block">
          <div className="h-4 w-24 rounded bg-muted/40" />
          <div className="mt-4 h-8 w-full rounded bg-muted/40" />
          <div className="mt-2 h-8 w-full rounded bg-muted/40" />
        </aside>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(1)} KiB`;
  }

  const mib = kib / 1024;
  return `${mib.toFixed(1)} MiB`;
}
