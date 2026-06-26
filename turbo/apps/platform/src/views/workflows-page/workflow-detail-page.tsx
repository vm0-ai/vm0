// Agent-scoped workflow detail at /agents/:agentId/workflows/:workflowId. Hosts
// the instruction editor, supplementary file manager (SKILL.md is never shown),
// triggers, visibility controls, metadata editing, run-once, copy, and delete.
import type { CSSProperties, FormEvent, ReactNode } from "react";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type {
  GmailNewMessageEventConfig,
  WorkflowFileEntry,
  WorkflowFileMetadata,
  ZeroWorkflowDetailResponse,
  ZeroWorkflowSchedule,
  ZeroWorkflowScheduleType,
  ZeroWorkflowTriggerSummary,
  ZeroWorkflowUpdateRequest,
} from "@vm0/api-contracts/contracts/zero-workflows";
import {
  IconAlertTriangle,
  IconChevronDown,
  IconClock,
  IconCopy,
  IconDotsVertical,
  IconFileText,
  IconLoader2,
  IconMail,
  IconPencil,
  IconPlus,
  IconShieldLock,
  IconTrash,
  IconUpload,
  IconUsers,
  IconX,
} from "@tabler/icons-react";
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui";

import { agents$ } from "../../signals/agent.ts";
import { user$ } from "../../signals/auth.ts";
import {
  changeWorkflowVisibility$,
  createWorkflowGmailNewMessageTrigger$,
  createWorkflowScheduleTrigger$,
  currentWorkflowId$,
  copyWorkflow$,
  deleteWorkflow$,
  deleteWorkflowTrigger$,
  editingGmailTriggerId$,
  runWorkflow$,
  scheduleTriggerType$,
  selectedWorkflowFilePath$,
  setScheduleTriggerType$,
  setEditingGmailTriggerId$,
  setSelectedWorkflowFilePath$,
  setWorkflowActionDialog$,
  setWorkflowDetailTriggerSidebarOpen$,
  setWorkflowFileDraft$,
  setWorkflowTriggerCreateDialog$,
  setWorkflowTriggerEnabled$,
  setWorkflowTriggerPermissionsDrawerTriggerId$,
  updateWorkflowGmailNewMessageTrigger$,
  updateWorkflow$,
  workflowActionDialog$,
  workflowTriggerCreateDialog$,
  workflowDetailTriggerSidebarOpen$,
  workflowFileDraft$,
  workflowDetail,
  workflowTriggerPermissionsDrawerTriggerId$,
} from "../../signals/workflows-page/workflows-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { TriggerPermissionsDrawer } from "../trigger-permissions/trigger-permissions-page.tsx";
import { TiptapInstructionsEditor } from "../zero-page/tiptap-instructions-editor.tsx";
import { ZeroUnsavedBar } from "../zero-page/zero-unsaved-bar.tsx";
import {
  agentLabel,
  isMarkdownPath,
  triggerKindLabel,
  workflowTitle,
} from "./workflow-shared.tsx";

const FIELD_CLASS =
  "h-9 w-full rounded-md border border-border/60 bg-background px-2.5 text-sm outline-none focus:border-primary";
const TRIGGER_FIELD_CLASS =
  "h-8 w-full rounded-md border border-border/60 bg-background px-2 text-xs";
const TRIGGER_TIMEZONE = "UTC";
const WORKFLOW_SIDEBAR_WIDTH = "min(520px, 42vw)";

type GmailMatchRules = NonNullable<GmailNewMessageEventConfig["match"]>;
type GmailTextMatcher = NonNullable<GmailMatchRules["from"]>;
type GmailTextField = "from" | "subject" | "body" | "to" | "cc";

const GMAIL_TEXT_FIELDS: readonly {
  readonly field: GmailTextField;
  readonly label: string;
}[] = [
  { field: "from", label: "From" },
  { field: "subject", label: "Subject" },
  { field: "body", label: "Body" },
  { field: "to", label: "To" },
  { field: "cc", label: "Cc" },
];

export function WorkflowDetailPage() {
  const workflowId = useGet(currentWorkflowId$);

  if (!workflowId) {
    return null;
  }

  return <WorkflowDetailContent workflowId={workflowId} />;
}

function WorkflowDetailContent({
  workflowId,
}: {
  readonly workflowId: string;
}) {
  const detailLoadable = useLoadable(workflowDetail(workflowId));
  const detail =
    detailLoadable.state === "hasData" ? detailLoadable.data : null;
  const triggerSidebarOpen = useGet(workflowDetailTriggerSidebarOpen$);
  const setTriggerSidebarOpen = useSet(setWorkflowDetailTriggerSidebarOpen$);
  const permissionTriggerId = useGet(
    workflowTriggerPermissionsDrawerTriggerId$,
  );
  const setPermissionTriggerId = useSet(
    setWorkflowTriggerPermissionsDrawerTriggerId$,
  );
  const permissionTrigger =
    detail?.triggers.find((trigger) => {
      return trigger.id === permissionTriggerId;
    }) ?? null;
  const shellStyle = {
    "--workflow-trigger-sidebar-width": WORKFLOW_SIDEBAR_WIDTH,
  } as CSSProperties;

  return (
    <div className="flex min-h-0 flex-1" style={shellStyle}>
      <div
        className={cn(
          "min-h-0 min-w-0 flex-col",
          triggerSidebarOpen ? "hidden flex-1 basis-0 xl:flex" : "flex flex-1",
        )}
      >
        <DetailHeader
          detail={detail}
          triggerSidebarOpen={triggerSidebarOpen}
          onTriggerSidebarOpenChange={setTriggerSidebarOpen}
        />
        <main className="min-h-0 flex-1 overflow-auto px-4 pb-10 pt-4 sm:px-6">
          <div className="mx-auto w-full max-w-[900px]">
            {detail ? (
              <WorkflowDetailBody detail={detail} />
            ) : detailLoadable.state === "hasData" ? (
              <p className="text-sm text-muted-foreground">
                Workflow not found.
              </p>
            ) : (
              <DetailSkeleton />
            )}
          </div>
        </main>
      </div>
      {triggerSidebarOpen && detail ? (
        <div className="hidden w-px shrink-0 bg-border/60 xl:block" />
      ) : null}
      <div
        className={cn(
          "min-h-0 min-w-0 overflow-hidden",
          triggerSidebarOpen
            ? "flex flex-1 basis-0 xl:w-[var(--workflow-trigger-sidebar-width)] xl:flex-none xl:basis-[var(--workflow-trigger-sidebar-width)]"
            : "pointer-events-none hidden w-0 flex-none basis-0",
        )}
        aria-hidden={!triggerSidebarOpen}
      >
        {triggerSidebarOpen && detail ? (
          <TriggersSection
            detail={detail}
            onClose={() => {
              setTriggerSidebarOpen(false);
            }}
            onOpenTriggerPermissions={setPermissionTriggerId}
          />
        ) : null}
      </div>
      {permissionTrigger && detail ? (
        <TriggerPermissionsDrawer
          agentId={detail.agentId}
          workflowId={detail.id}
          trigger={permissionTrigger}
          open
          onOpenChange={(open) => {
            if (!open) {
              setPermissionTriggerId(null);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function WorkflowBreadcrumb({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse | null;
}) {
  if (!detail) {
    return (
      <div className="h-7 w-56 rounded-md bg-muted/50" aria-hidden="true" />
    );
  }

  return (
    <nav
      aria-label="Breadcrumb"
      className="hidden min-w-0 items-center gap-1 text-sm text-muted-foreground sm:flex"
    >
      <BreadcrumbLink
        pathname={ROUTES.agents}
        icon={<IconUsers size={14} stroke={1.5} className="shrink-0" />}
      >
        Agents
      </BreadcrumbLink>
      <span className="select-none text-muted-foreground/40">/</span>
      <BreadcrumbLink
        pathname={ROUTES.agentDetail}
        options={{ pathParams: { agentId: detail.agentId } }}
      >
        {agentLabel(detail)}
      </BreadcrumbLink>
      <span className="select-none text-muted-foreground/40">/</span>
      <BreadcrumbLink
        pathname={ROUTES.agentWorkflows}
        options={{ pathParams: { agentId: detail.agentId } }}
      >
        workflows
      </BreadcrumbLink>
      <span className="select-none text-muted-foreground/40">/</span>
      <span className="min-w-0 truncate rounded-md px-1.5 py-0.5 text-inherit">
        {workflowTitle(detail)}
      </span>
      <span className="select-none text-muted-foreground/40">/</span>
      <WorkflowFilePicker detail={detail} />
    </nav>
  );
}

function BreadcrumbLink({
  pathname,
  options,
  icon,
  children,
}: {
  readonly pathname: (typeof ROUTES)[keyof typeof ROUTES];
  readonly options?: Parameters<typeof Link>[0]["options"];
  readonly icon?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Link
      pathname={pathname}
      options={options}
      className="inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-inherit no-underline transition-colors hover:bg-muted hover:text-foreground"
    >
      {icon}
      <span className="truncate">{children}</span>
    </Link>
  );
}

function WorkflowMobileCascade({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse | null;
}) {
  const navigate = useSet(detachedNavigateTo$);
  const selectedFilePath = useGet(selectedWorkflowFilePath$);
  const setSelectedFilePath = useSet(setSelectedWorkflowFilePath$);

  if (!detail) {
    return (
      <div
        className="h-8 w-48 rounded-md bg-muted/50 sm:hidden"
        aria-hidden="true"
      />
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-foreground transition-colors hover:bg-muted sm:hidden"
        >
          <IconFileText size={14} stroke={1.5} className="shrink-0" />
          <span className="min-w-0 truncate">
            {workflowTitle(detail)} / {selectedFilePath ?? "instructions"}
          </span>
          <IconChevronDown
            size={14}
            stroke={1.5}
            className="shrink-0 text-muted-foreground"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuItem
          onSelect={() => {
            navigate(ROUTES.agents);
          }}
        >
          Agents
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            navigate(ROUTES.agentDetail, {
              pathParams: { agentId: detail.agentId },
            });
          }}
        >
          {agentLabel(detail)}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            navigate(ROUTES.agentWorkflows, {
              pathParams: { agentId: detail.agentId },
            });
          }}
        >
          workflows
        </DropdownMenuItem>
        <div className="my-1 h-px bg-border/60" />
        <DropdownMenuItem
          className={cn(!selectedFilePath ? "bg-muted" : "")}
          onSelect={() => {
            setSelectedFilePath(null);
          }}
        >
          instructions
        </DropdownMenuItem>
        {(detail.files ?? []).map((file) => {
          return (
            <DropdownMenuItem
              key={file.path}
              className={cn(selectedFilePath === file.path ? "bg-muted" : "")}
              onSelect={() => {
                setSelectedFilePath(file.path);
              }}
            >
              {file.path}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorkflowDetailBody({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  return (
    <div className="flex min-h-[calc(100vh-8rem)] flex-col">
      <ShadowWarning detail={detail} />
      <WorkflowFilePreview detail={detail} />
    </div>
  );
}

function DetailHeader({
  detail,
  triggerSidebarOpen,
  onTriggerSidebarOpenChange,
}: {
  readonly detail: ZeroWorkflowDetailResponse | null;
  readonly triggerSidebarOpen: boolean;
  readonly onTriggerSidebarOpenChange: (open: boolean) => void;
}) {
  return (
    <header className="flex shrink-0 items-center justify-between gap-3 px-4 pt-4 sm:px-6">
      <div className="min-w-0 flex-1">
        <WorkflowBreadcrumb detail={detail} />
        <WorkflowMobileCascade detail={detail} />
      </div>
      {detail ? (
        <div className="flex shrink-0 items-center gap-2">
          <WorkflowRunOnceButton detail={detail} />
          <button
            type="button"
            className={cn(
              "zero-btn-morandi inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm",
              triggerSidebarOpen ? "bg-muted" : "",
            )}
            aria-pressed={triggerSidebarOpen}
            onClick={() => {
              onTriggerSidebarOpenChange(!triggerSidebarOpen);
            }}
          >
            <IconClock size={14} stroke={1.5} />
            <span className="hidden sm:inline">Trigger</span>
          </button>
          <WorkflowActionsMenu detail={detail} />
        </div>
      ) : null}
    </header>
  );
}

function WorkflowRunOnceButton({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  const pageSignal = useGet(pageSignal$);
  const navigate = useSet(detachedNavigateTo$);
  const [runLoadable, runWorkflow] = useLoadableSet(runWorkflow$);
  const running = runLoadable.state === "loading";

  return (
    <button
      type="button"
      disabled={running}
      className={cn(
        "zero-btn-morandi inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm",
        running ? "cursor-not-allowed opacity-60" : "",
      )}
      onClick={() => {
        detach(
          (async () => {
            const result = await runWorkflow(detail.id, pageSignal);
            navigate(ROUTES.chat, {
              pathParams: { threadId: result.chatThreadId },
            });
          })(),
          Reason.DomCallback,
        );
      }}
    >
      {running ? (
        <IconLoader2 size={14} className="animate-spin" />
      ) : (
        <IconClock size={14} stroke={1.5} />
      )}
      <span className="hidden sm:inline">Run once</span>
    </button>
  );
}

function ShadowWarning({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  if (!detail.shadowedBy) {
    return null;
  }

  return (
    <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
      <IconAlertTriangle size={16} stroke={1.5} className="mt-0.5 shrink-0" />
      <p className="min-w-0">
        <span className="font-medium">/{detail.name}</span> currently resolves
        to{" "}
        <span className="font-medium">{workflowTitle(detail.shadowedBy)}</span>{" "}
        for you. This workflow is shadowed by the same-slug priority rule.
      </p>
    </div>
  );
}

function WorkflowActionsMenu({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  const actionDialog = useGet(workflowActionDialog$);
  const setActionDialog = useSet(setWorkflowActionDialog$);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Workflow actions"
            className="zero-btn-morandi inline-flex size-9 items-center justify-center rounded-md"
          >
            <IconDotsVertical size={16} stroke={1.5} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuItem
            disabled={!detail.canManage}
            className="gap-2"
            onSelect={() => {
              setActionDialog("edit");
            }}
          >
            <IconPencil size={15} stroke={1.5} />
            Edit
          </DropdownMenuItem>
          <div className="px-2 py-2">
            <WorkflowPublicToggle detail={detail} />
          </div>
          <div className="my-1 h-px bg-border/60" />
          <DropdownMenuItem
            className="gap-2"
            onSelect={() => {
              setActionDialog("copy");
            }}
          >
            <IconCopy size={15} stroke={1.5} />
            Copy
          </DropdownMenuItem>
          {detail.canManage ? (
            <DropdownMenuItem
              className="gap-2 text-destructive focus:text-destructive"
              onSelect={() => {
                setActionDialog("delete");
              }}
            >
              <IconTrash size={15} stroke={1.5} />
              Delete
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <WorkflowEditDialog
        detail={detail}
        open={actionDialog === "edit"}
        onOpenChange={(open) => {
          setActionDialog(open ? "edit" : null);
        }}
      />
      <WorkflowCopyDialog
        detail={detail}
        open={actionDialog === "copy"}
        onOpenChange={(open) => {
          setActionDialog(open ? "copy" : null);
        }}
      />
      <WorkflowDeleteDialog
        detail={detail}
        open={actionDialog === "delete"}
        onOpenChange={(open) => {
          setActionDialog(open ? "delete" : null);
        }}
      />
    </>
  );
}

function WorkflowEditDialog({
  detail,
  open,
  onOpenChange,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [saveLoadable, updateWorkflow] = useLoadableSet(updateWorkflow$);
  const saving = saveLoadable.state === "loading";
  const disabled = !detail.canManage || saving;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit workflow</DialogTitle>
          <DialogDescription>
            Update the workflow name and description.
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label="Workflow metadata"
          className="flex flex-col gap-4"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (!detail.canManage) {
              return;
            }
            const form = new FormData(event.currentTarget);
            const displayName = String(form.get("displayName") ?? "").trim();
            const description = String(form.get("description") ?? "").trim();
            detach(
              (async () => {
                await updateWorkflow(
                  {
                    workflowId: detail.id,
                    body: {
                      displayName: displayName || null,
                      description: description || null,
                    },
                  },
                  pageSignal,
                );
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Name
            <input
              name="displayName"
              aria-label="Name"
              defaultValue={detail.displayName ?? ""}
              disabled={disabled}
              className={FIELD_CLASS}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Description
            <textarea
              name="description"
              aria-label="Description"
              defaultValue={detail.description ?? ""}
              disabled={disabled}
              rows={3}
              className="w-full rounded-md border border-border/60 bg-background px-2.5 py-2 text-sm outline-none focus:border-primary"
            />
          </label>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={disabled}>
              {saving ? (
                <IconLoader2 size={14} className="animate-spin" />
              ) : null}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function WorkflowPublicToggle({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  const pageSignal = useGet(pageSignal$);
  const [changeLoadable, changeVisibility] = useLoadableSet(
    changeWorkflowVisibility$,
  );
  const busy = changeLoadable.state === "loading";
  const requested = detail.visibility === "private" && detail.requestToPublish;
  const isPublic = detail.visibility === "public";
  const checked = requested || isPublic;
  const statusLabel = isPublic
    ? "Public"
    : requested
      ? "Requested to public"
      : "Private";
  const toggleAction: Parameters<typeof changeVisibility>[0]["action"] | null =
    isPublic
      ? detail.canManage
        ? "demote"
        : null
      : requested
        ? "cancel-publish-request"
        : "request-publish";
  const submitVisibilityAction = (
    action: Parameters<typeof changeVisibility>[0]["action"],
  ) => {
    detach(
      changeVisibility({ workflowId: detail.id, action }, pageSignal),
      Reason.DomCallback,
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Public</p>
          <p className="text-xs text-muted-foreground">{statusLabel}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          disabled={busy || !toggleAction}
          className={cn(
            "relative h-5 w-9 shrink-0 rounded-full transition-colors",
            isPublic ? "bg-primary/70" : "bg-muted",
            busy || !toggleAction ? "cursor-not-allowed opacity-60" : "",
          )}
          onClick={() => {
            if (toggleAction) {
              submitVisibilityAction(toggleAction);
            }
          }}
        >
          <span
            className={cn(
              "absolute left-0.5 top-0.5 size-4 rounded-full bg-background shadow-sm transition-transform",
              checked ? "translate-x-4" : "translate-x-0",
            )}
          />
        </button>
      </div>
      {requested ? (
        <p className="text-xs leading-5 text-muted-foreground">
          This workflow is waiting for the agent owner to review before it can
          go public.
        </p>
      ) : null}
      {requested && detail.canManage ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            className="zero-btn-morandi inline-flex h-8 items-center rounded-md px-2 text-xs"
            onClick={() => {
              submitVisibilityAction("approve-publish");
            }}
          >
            Approve
          </button>
          <button
            type="button"
            disabled={busy}
            className="zero-btn-morandi inline-flex h-8 items-center rounded-md px-2 text-xs text-destructive/90"
            onClick={() => {
              submitVisibilityAction("reject-publish");
            }}
          >
            Reject
          </button>
        </div>
      ) : null}
    </div>
  );
}

function WorkflowCopyDialog({
  detail,
  open,
  onOpenChange,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const agentsLoadable = useLoadable(agents$);
  const agents =
    agentsLoadable.state === "hasData"
      ? agentsLoadable.data.filter((agent) => {
          return agent.id !== detail.agentId;
        })
      : [];
  const pageSignal = useGet(pageSignal$);
  const [copyLoadable, copyWorkflow] = useLoadableSet(copyWorkflow$);
  const copying = copyLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Copy workflow</DialogTitle>
          <DialogDescription>
            Copy to another agent as a new private workflow.
          </DialogDescription>
        </DialogHeader>
        {agents.length > 0 ? (
          <div className="max-h-[360px] overflow-auto rounded-md border border-border/60">
            {agents.map((agent) => {
              return (
                <button
                  key={agent.id}
                  type="button"
                  disabled={copying}
                  className="flex w-full items-center justify-between gap-3 border-b border-border/60 px-3 py-2 text-left last:border-b-0 transition-colors hover:bg-muted disabled:opacity-60"
                  onClick={() => {
                    detach(
                      (async () => {
                        await copyWorkflow(
                          {
                            workflowId: detail.id,
                            toAgentId: agent.id,
                          },
                          pageSignal,
                        );
                        onOpenChange(false);
                      })(),
                      Reason.DomCallback,
                    );
                  }}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {agent.displayName ?? agent.id}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {agent.visibility === "private"
                        ? "Private agent"
                        : "Public agent"}
                    </span>
                  </span>
                  {copying ? (
                    <IconLoader2
                      size={14}
                      className="shrink-0 animate-spin text-muted-foreground"
                    />
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : agentsLoadable.state === "hasData" ? (
          <p className="text-sm text-muted-foreground">
            No other agents are available.
          </p>
        ) : (
          <div className="h-24 rounded-md bg-muted/50" aria-hidden="true" />
        )}
      </DialogContent>
    </Dialog>
  );
}

function WorkflowDeleteDialog({
  detail,
  open,
  onOpenChange,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const navigate = useSet(detachedNavigateTo$);
  const [deleteLoadable, deleteWorkflow] = useLoadableSet(deleteWorkflow$);
  const deleting = deleteLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete workflow</DialogTitle>
          <DialogDescription>
            This is a dangerous operation. Deleting this workflow also deletes
            every trigger bound to it, including triggers other users created.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {workflowTitle(detail)} and all bound triggers will be deleted.
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={deleting}
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={deleting}
            onClick={() => {
              detach(
                (async () => {
                  await deleteWorkflow(detail.id, pageSignal);
                  onOpenChange(false);
                  navigate(ROUTES.agentWorkflows, {
                    pathParams: { agentId: detail.agentId },
                  });
                })(),
                Reason.DomCallback,
              );
            }}
          >
            {deleting ? (
              <IconLoader2 size={14} className="animate-spin" />
            ) : null}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WorkflowFilePicker({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  const selectedFilePath = useGet(selectedWorkflowFilePath$);
  const setSelectedFilePath = useSet(setSelectedWorkflowFilePath$);
  const files: readonly WorkflowFileMetadata[] = detail.files ?? [];
  const fileContents: readonly WorkflowFileEntry[] = detail.fileContents ?? [];
  const pageSignal = useGet(pageSignal$);
  const [saveLoadable, updateWorkflow] = useLoadableSet(updateWorkflow$);
  const saving = saveLoadable.state === "loading";
  const selectedLabel = selectedFilePath ?? "instructions";
  const uploadFiles = (selected: FileList) => {
    detach(
      (async () => {
        const uploaded = await readUploadedWorkflowFiles(selected);
        const byPath = new Map(
          fileContents.map((file) => {
            return [file.path, file];
          }),
        );
        for (const file of uploaded) {
          byPath.set(file.path, file);
        }
        await updateWorkflow(
          {
            workflowId: detail.id,
            body: { files: [...byPath.values()] },
          },
          pageSignal,
        );
        setSelectedFilePath(uploaded[0]?.path ?? null);
      })(),
      Reason.DomCallback,
    );
  };
  const deleteSelectedFile = () => {
    if (!selectedFilePath) {
      return;
    }
    detach(
      (async () => {
        const nextFiles = fileContents.filter((file) => {
          return file.path !== selectedFilePath;
        });
        await updateWorkflow(
          {
            workflowId: detail.id,
            body: { files: nextFiles },
          },
          pageSignal,
        );
        setSelectedFilePath(null);
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-foreground transition-colors hover:bg-muted"
        >
          <span className="min-w-0 truncate">{selectedLabel}</span>
          <IconChevronDown
            size={14}
            stroke={1.5}
            className="shrink-0 text-muted-foreground"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <WorkflowFileNavigationItems
          files={files}
          selectedFilePath={selectedFilePath}
          onSelectFile={setSelectedFilePath}
        />
        {detail.canManage ? (
          <WorkflowFileManagementItems
            saving={saving}
            selectedFilePath={selectedFilePath}
            onUpload={uploadFiles}
            onDeleteSelectedFile={deleteSelectedFile}
          />
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorkflowFileNavigationItems({
  files,
  selectedFilePath,
  onSelectFile,
}: {
  readonly files: readonly WorkflowFileMetadata[];
  readonly selectedFilePath: string | null;
  readonly onSelectFile: (filePath: string | null) => void;
}) {
  return (
    <>
      <DropdownMenuItem
        className={cn(!selectedFilePath ? "bg-muted" : "")}
        onSelect={() => {
          onSelectFile(null);
        }}
      >
        instructions
      </DropdownMenuItem>
      {files.map((file) => {
        return (
          <DropdownMenuItem
            key={file.path}
            className={cn(selectedFilePath === file.path ? "bg-muted" : "")}
            onSelect={() => {
              onSelectFile(file.path);
            }}
          >
            <span className="min-w-0 truncate">{file.path}</span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {file.size} B
            </span>
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

function WorkflowFileManagementItems({
  saving,
  selectedFilePath,
  onUpload,
  onDeleteSelectedFile,
}: {
  readonly saving: boolean;
  readonly selectedFilePath: string | null;
  readonly onUpload: (files: FileList) => void;
  readonly onDeleteSelectedFile: () => void;
}) {
  return (
    <>
      <div className="my-1 h-px bg-border/60" />
      <label
        className={cn(
          "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
          saving ? "pointer-events-none opacity-60" : "",
        )}
      >
        {saving ? (
          <IconLoader2 size={15} className="animate-spin" />
        ) : (
          <IconUpload size={15} stroke={1.5} />
        )}
        <span>Upload text files</span>
        <input
          aria-label="Upload workflow files"
          type="file"
          multiple
          disabled={saving}
          className="sr-only"
          onChange={(event) => {
            const selected = event.currentTarget.files;
            if (!selected || selected.length === 0) {
              return;
            }
            onUpload(selected);
            event.currentTarget.value = "";
          }}
        />
      </label>
      {selectedFilePath ? (
        <button
          type="button"
          aria-label={`Delete ${selectedFilePath}`}
          disabled={saving}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-destructive transition-colors hover:bg-accent disabled:opacity-60"
          onClick={onDeleteSelectedFile}
        >
          <IconTrash size={15} stroke={1.5} />
          <span>Delete selected file</span>
        </button>
      ) : null}
    </>
  );
}

function workflowDraftUpdateBody(
  selectedFilePath: string | null,
  draft: string,
  fileContents: readonly WorkflowFileEntry[],
): ZeroWorkflowUpdateRequest {
  if (!selectedFilePath) {
    return { instruction: draft || null };
  }

  return {
    files: fileContents.map((file) => {
      return file.path === selectedFilePath
        ? { path: file.path, content: draft }
        : file;
    }),
  };
}

function selectedWorkflowFile(
  fileContents: readonly WorkflowFileEntry[],
  selectedFilePath: string | null,
): WorkflowFileEntry | null {
  if (!selectedFilePath) {
    return null;
  }

  return (
    fileContents.find((file) => {
      return file.path === selectedFilePath;
    }) ?? null
  );
}

function workflowSelectedSourceContent(
  detail: ZeroWorkflowDetailResponse,
  selectedFilePath: string | null,
  selectedFile: WorkflowFileEntry | null,
): string {
  if (!selectedFilePath) {
    return detail.instruction ?? "";
  }

  return selectedFile?.content ?? "";
}

function WorkflowFilePreview({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  const selectedFilePath = useGet(selectedWorkflowFilePath$);
  const fileContents: readonly WorkflowFileEntry[] = detail.fileContents ?? [];
  const selectedFile = selectedWorkflowFile(fileContents, selectedFilePath);
  const sourceContent = workflowSelectedSourceContent(
    detail,
    selectedFilePath,
    selectedFile,
  );

  if (selectedFilePath && !selectedFile) {
    return (
      <div className="flex min-h-[360px] items-center justify-center text-sm text-muted-foreground">
        No content available for this file.
      </div>
    );
  }

  return (
    <WorkflowSelectedFileEditor
      detail={detail}
      fileContents={fileContents}
      selectedFilePath={selectedFilePath}
      sourceContent={sourceContent}
    />
  );
}

function WorkflowSelectedFileEditor({
  detail,
  fileContents,
  selectedFilePath,
  sourceContent,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
  readonly fileContents: readonly WorkflowFileEntry[];
  readonly selectedFilePath: string | null;
  readonly sourceContent: string;
}) {
  const draftState = useGet(workflowFileDraft$);
  const setDraftState = useSet(setWorkflowFileDraft$);
  const pageSignal = useGet(pageSignal$);
  const [saveLoadable, updateWorkflow] = useLoadableSet(updateWorkflow$);
  const saving = saveLoadable.state === "loading";
  const draftMatches =
    draftState?.workflowId === detail.id &&
    draftState.filePath === selectedFilePath &&
    draftState.sourceContent === sourceContent;
  const draft = draftMatches ? draftState.content : null;
  const content = draft ?? sourceContent;
  const dirty = draft !== null && draft !== sourceContent;
  const markdown =
    selectedFilePath === null || isMarkdownPath(selectedFilePath);
  const setDraft = (nextContent: string) => {
    setDraftState({
      workflowId: detail.id,
      filePath: selectedFilePath,
      sourceContent,
      content: nextContent,
    });
  };

  const saveDraft = () => {
    if (!detail.canManage || draft === null) {
      return;
    }
    const body = workflowDraftUpdateBody(selectedFilePath, draft, fileContents);
    detach(
      (async () => {
        await updateWorkflow(
          {
            workflowId: detail.id,
            body,
          },
          pageSignal,
        );
        setDraftState(null);
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <div className="flex flex-1 flex-col">
      {markdown ? (
        <TiptapInstructionsEditor
          key={`${detail.id}:${selectedFilePath ?? "instructions"}:${sourceContent}`}
          initialContent={content}
          onChange={setDraft}
          disabled={!detail.canManage || saving}
          footerHint={null}
          surface="canvas"
          ariaLabel={
            selectedFilePath ? "Workflow file content" : "Workflow instruction"
          }
          placeholder={
            selectedFilePath
              ? "Edit this markdown file..."
              : "Write workflow instructions..."
          }
        />
      ) : (
        <textarea
          aria-label="Workflow file content"
          value={content}
          disabled={!detail.canManage || saving}
          spellCheck={false}
          className="min-h-[calc(100vh-10rem)] w-full resize-none bg-transparent px-0 py-3 font-mono text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
          onChange={(event) => {
            setDraft(event.currentTarget.value);
          }}
        />
      )}
      {dirty ? (
        <ZeroUnsavedBar
          saving={saving}
          onDiscard={() => {
            setDraftState(null);
          }}
          onSave={saveDraft}
        />
      ) : null}
    </div>
  );
}

async function readUploadedWorkflowFiles(
  files: FileList,
): Promise<WorkflowFileEntry[]> {
  return await Promise.all(
    Array.from(files).map(async (file) => {
      const uploadFile = file as File & {
        readonly webkitRelativePath?: string;
      };
      const path = (uploadFile.webkitRelativePath || file.name).replace(
        /^\.\//,
        "",
      );
      return { path, content: await file.text() };
    }),
  );
}

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

function formTextValue(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildGmailNewMessageEventConfig(
  form: FormData,
  baseConfig?: GmailNewMessageEventConfig,
): GmailNewMessageEventConfig {
  const baseMatch = baseConfig?.match;
  const match: GmailMatchRules = {};
  for (const { field } of GMAIL_TEXT_FIELDS) {
    const existing = baseMatch?.[field];
    const contains = formTextValue(form, `${field}Contains`);
    const doesNotContain = formTextValue(form, `${field}DoesNotContain`);
    const matcher: GmailTextMatcher = {};
    if (existing?.containsAny) {
      matcher.containsAny = existing.containsAny;
    }
    if (existing?.doesNotContainAny) {
      matcher.doesNotContainAny = existing.doesNotContainAny;
    }
    if (contains) {
      matcher.contains = contains;
    }
    if (doesNotContain) {
      matcher.doesNotContain = doesNotContain;
    }
    if (Object.keys(matcher).length > 0) {
      match[field] = matcher;
    }
  }
  return Object.keys(match).length > 0
    ? { provider: "gmail", event: "new_message", match }
    : { provider: "gmail", event: "new_message" };
}

function quote(value: string): string {
  return `"${value}"`;
}

function quoteList(values: readonly string[]): string {
  return values.map(quote).join(", ");
}

function textMatcherParts(
  field: GmailTextField,
  matcher: GmailTextMatcher,
): string[] {
  const parts: string[] = [];
  if (matcher.contains) {
    parts.push(`${field} contains ${quote(matcher.contains)}`);
  }
  if (matcher.containsAny) {
    parts.push(`${field} contains any of ${quoteList(matcher.containsAny)}`);
  }
  if (matcher.doesNotContain) {
    parts.push(`${field} does not contain ${quote(matcher.doesNotContain)}`);
  }
  if (matcher.doesNotContainAny) {
    parts.push(
      `${field} does not contain any of ${quoteList(matcher.doesNotContainAny)}`,
    );
  }
  return parts;
}

function formatGmailMatchSummary(config: GmailNewMessageEventConfig): string {
  const match = config.match;
  if (!match) {
    return "all inbound messages";
  }

  const parts: string[] = [];
  for (const { field } of GMAIL_TEXT_FIELDS) {
    const matcher = match[field];
    if (matcher) {
      parts.push(...textMatcherParts(field, matcher));
    }
  }
  return parts.length > 0 ? parts.join("; ") : "all inbound messages";
}

function gmailMatcherDefaultValue(
  config: GmailNewMessageEventConfig,
  field: GmailTextField,
  key: "contains" | "doesNotContain",
): string {
  return config.match?.[field]?.[key] ?? "";
}

function TriggersSection({
  detail,
  onClose,
  onOpenTriggerPermissions,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
  readonly onClose: () => void;
  readonly onOpenTriggerPermissions: (triggerId: string) => void;
}) {
  const createDialog = useGet(workflowTriggerCreateDialog$);
  const setCreateDialog = useSet(setWorkflowTriggerCreateDialog$);
  const userLoadable = useLoadable(user$);
  const currentUserId =
    userLoadable.state === "hasData" ? (userLoadable.data?.id ?? "") : "";
  const triggers = detail.triggers;

  return (
    <aside className="flex min-h-0 w-full flex-col bg-background">
      <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-medium text-foreground">Trigger</span>
          <span className="text-xs text-muted-foreground">
            {triggers.length}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="zero-btn-morandi inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs"
              >
                <IconPlus size={13} stroke={1.5} />
                <span>Add trigger</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem
                className="items-start gap-2 py-2"
                onSelect={() => {
                  setCreateDialog("schedule");
                }}
              >
                <IconClock
                  size={15}
                  stroke={1.5}
                  className="mt-0.5 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">Schedule</span>
                  <span className="block text-xs text-muted-foreground">
                    Run this workflow from a time rule.
                  </span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="items-start gap-2 py-2"
                onSelect={() => {
                  setCreateDialog("gmail");
                }}
              >
                <IconMail
                  size={15}
                  stroke={1.5}
                  className="mt-0.5 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">
                    Gmail new message
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Run this workflow from matching email.
                  </span>
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            aria-label="Close trigger sidebar"
            className="zero-btn-morandi inline-flex size-8 items-center justify-center rounded-md"
            onClick={onClose}
          >
            <IconX size={15} stroke={1.5} />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {triggers.length > 0 ? (
          <div className="flex flex-col gap-1">
            {triggers.map((trigger) => {
              return (
                <TriggerRow
                  key={trigger.id}
                  trigger={trigger}
                  canManage={trigger.ownerUserId === currentUserId}
                  onOpenPermissions={onOpenTriggerPermissions}
                />
              );
            })}
          </div>
        ) : (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            No triggers.
          </p>
        )}
      </div>
      <CreateScheduleTriggerDialog
        workflowId={detail.id}
        open={createDialog === "schedule"}
        onOpenChange={(open) => {
          setCreateDialog(open ? "schedule" : null);
        }}
      />
      <CreateGmailNewMessageTriggerDialog
        workflowId={detail.id}
        open={createDialog === "gmail"}
        onOpenChange={(open) => {
          setCreateDialog(open ? "gmail" : null);
        }}
      />
    </aside>
  );
}

function CreateScheduleTriggerDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const scheduleType = useGet(scheduleTriggerType$);
  const setScheduleType = useSet(setScheduleTriggerType$);
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createScheduleTrigger] = useLoadableSet(
    createWorkflowScheduleTrigger$,
  );
  const creating = createLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add schedule trigger</DialogTitle>
          <DialogDescription>
            Choose when this workflow should run.
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label="Add schedule trigger"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const schedule = buildTriggerSchedule(scheduleType, {
              cronExpression: String(form.get("cronExpression") ?? ""),
              intervalSeconds: String(form.get("intervalSeconds") ?? ""),
              atTime: String(form.get("atTime") ?? ""),
            });
            if (!schedule) {
              return;
            }
            detach(
              (async () => {
                await createScheduleTrigger(
                  { workflowId, schedule },
                  pageSignal,
                );
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Schedule type
            <Select
              value={scheduleType}
              disabled={creating}
              onValueChange={(value) => {
                setScheduleType(value as ZeroWorkflowScheduleType);
              }}
            >
              <SelectTrigger className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cron">Repeat with cron</SelectItem>
                <SelectItem value="loop">Loop every interval</SelectItem>
                <SelectItem value="once">Run once</SelectItem>
              </SelectContent>
            </Select>
          </label>

          <ScheduleTriggerFields
            scheduleType={scheduleType}
            creating={creating}
          />

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={creating}
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={creating}>
              {creating ? (
                <IconLoader2 size={14} className="animate-spin" />
              ) : null}
              Add schedule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ScheduleTriggerFields({
  scheduleType,
  creating,
}: {
  readonly scheduleType: ZeroWorkflowScheduleType;
  readonly creating: boolean;
}) {
  if (scheduleType === "loop") {
    return (
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Interval seconds
        <input
          name="intervalSeconds"
          aria-label="Interval seconds"
          type="number"
          min="1"
          defaultValue="3600"
          disabled={creating}
          className={FIELD_CLASS}
        />
      </label>
    );
  }

  if (scheduleType === "once") {
    return (
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Run at
        <input
          name="atTime"
          aria-label="Run at"
          type="datetime-local"
          disabled={creating}
          className={FIELD_CLASS}
        />
        <span className="text-xs text-muted-foreground">
          Uses {TRIGGER_TIMEZONE}.
        </span>
      </label>
    );
  }

  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      Cron expression
      <input
        name="cronExpression"
        aria-label="Cron expression"
        defaultValue="0 9 * * *"
        disabled={creating}
        placeholder="0 9 * * *"
        className={FIELD_CLASS}
      />
      <span className="text-xs text-muted-foreground">
        Runs in {TRIGGER_TIMEZONE}.
      </span>
    </label>
  );
}

function CreateGmailNewMessageTriggerDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  readonly workflowId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createGmailTrigger] = useLoadableSet(
    createWorkflowGmailNewMessageTrigger$,
  );
  const creating = createLoadable.state === "loading";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add Gmail trigger</DialogTitle>
          <DialogDescription>
            Run this workflow when a matching message arrives.
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label="Add Gmail trigger"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            detach(
              (async () => {
                await createGmailTrigger(
                  {
                    workflowId,
                    eventConfig: buildGmailNewMessageEventConfig(form),
                  },
                  pageSignal,
                );
                onOpenChange(false);
              })(),
              Reason.DomCallback,
            );
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {GMAIL_TEXT_FIELDS.map(({ field, label }) => {
              return (
                <div key={field} className="grid grid-cols-2 gap-2">
                  <input
                    name={`${field}Contains`}
                    aria-label={`${label} contains`}
                    disabled={creating}
                    placeholder={`${label} contains`}
                    className={FIELD_CLASS}
                  />
                  <input
                    name={`${field}DoesNotContain`}
                    aria-label={`${label} does not contain`}
                    disabled={creating}
                    placeholder={`${label} does not contain`}
                    className={FIELD_CLASS}
                  />
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={creating}
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={creating}>
              {creating ? (
                <IconLoader2 size={14} className="animate-spin" />
              ) : null}
              Add Gmail trigger
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TriggerRow({
  trigger,
  canManage,
  onOpenPermissions,
}: {
  readonly trigger: ZeroWorkflowTriggerSummary;
  readonly canManage: boolean;
  readonly onOpenPermissions: (triggerId: string) => void;
}) {
  const editingTriggerId = useGet(editingGmailTriggerId$);
  const setEditingTriggerId = useSet(setEditingGmailTriggerId$);
  const editingMatch = editingTriggerId === trigger.id;
  const title =
    trigger.kind === "schedule" ? trigger.scheduleSummary : "Gmail new message";
  const matchSummary =
    trigger.kind === "event"
      ? formatGmailMatchSummary(trigger.eventConfig)
      : null;
  const TriggerIcon = trigger.kind === "schedule" ? IconClock : IconMail;

  return (
    <div className="flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground">
        <TriggerIcon size={13} stroke={1.5} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-xs font-medium text-foreground">
            {title}
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
          {triggerKindLabel(trigger.kind)}
        </p>
        {matchSummary ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {matchSummary}
          </p>
        ) : null}
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
          <TriggerControls
            trigger={trigger}
            editingMatch={editingMatch}
            onOpenPermissions={onOpenPermissions}
          />
        ) : null}
        {canManage && trigger.kind === "event" && editingMatch ? (
          <UpdateGmailNewMessageTriggerForm
            trigger={trigger}
            onCancel={() => {
              setEditingTriggerId(null);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function TriggerControls({
  trigger,
  editingMatch,
  onOpenPermissions,
}: {
  readonly trigger: ZeroWorkflowTriggerSummary;
  readonly editingMatch: boolean;
  readonly onOpenPermissions: (triggerId: string) => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const setEditingTriggerId = useSet(setEditingGmailTriggerId$);
  const [enabledLoadable, setEnabled] = useLoadableSet(
    setWorkflowTriggerEnabled$,
  );
  const [deleteLoadable, deleteTrigger] = useLoadableSet(
    deleteWorkflowTrigger$,
  );
  const busy =
    enabledLoadable.state === "loading" || deleteLoadable.state === "loading";

  return (
    <div className="mt-1 flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
        onClick={() => {
          onOpenPermissions(trigger.id);
        }}
      >
        <IconShieldLock size={13} stroke={1.5} />
        <span>Permissions</span>
      </button>
      {trigger.kind === "event" && !editingMatch ? (
        <button
          type="button"
          disabled={busy}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
          onClick={() => {
            setEditingTriggerId(trigger.id);
          }}
        >
          Edit match
        </button>
      ) : null}
      <button
        type="button"
        disabled={busy}
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
          detach(deleteTrigger(trigger.id, pageSignal), Reason.DomCallback);
        }}
      >
        Delete
      </button>
    </div>
  );
}

function UpdateGmailNewMessageTriggerForm({
  trigger,
  onCancel,
}: {
  readonly trigger: Extract<ZeroWorkflowTriggerSummary, { kind: "event" }>;
  readonly onCancel: () => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [updateLoadable, updateGmailTrigger] = useLoadableSet(
    updateWorkflowGmailNewMessageTrigger$,
  );
  const saving = updateLoadable.state === "loading";

  return (
    <form
      aria-label="Update Gmail new message trigger"
      className="mt-2 rounded-md border border-border/60 bg-background/70 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        detach(
          (async () => {
            await updateGmailTrigger(
              {
                triggerId: trigger.id,
                eventConfig: buildGmailNewMessageEventConfig(
                  form,
                  trigger.eventConfig,
                ),
              },
              pageSignal,
            );
            onCancel();
          })(),
          Reason.DomCallback,
        );
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        {GMAIL_TEXT_FIELDS.map(({ field, label }) => {
          return (
            <div key={field} className="grid grid-cols-2 gap-1.5">
              <input
                name={`${field}Contains`}
                aria-label={`${label} contains`}
                defaultValue={gmailMatcherDefaultValue(
                  trigger.eventConfig,
                  field,
                  "contains",
                )}
                disabled={saving}
                placeholder={`${label} contains`}
                className={TRIGGER_FIELD_CLASS}
              />
              <input
                name={`${field}DoesNotContain`}
                aria-label={`${label} does not contain`}
                defaultValue={gmailMatcherDefaultValue(
                  trigger.eventConfig,
                  field,
                  "doesNotContain",
                )}
                disabled={saving}
                placeholder={`${label} does not contain`}
                className={TRIGGER_FIELD_CLASS}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="submit"
          disabled={saving}
          className={cn(
            "zero-btn-morandi inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs",
            saving ? "cursor-not-allowed opacity-60" : "",
          )}
        >
          {saving ? (
            <IconLoader2 size={13} className="animate-spin" />
          ) : (
            <IconMail size={13} stroke={1.5} />
          )}
          <span>Save match</span>
        </button>
        <button
          type="button"
          disabled={saving}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-4" data-testid="workflow-detail-loading">
      <div className="h-7 w-52 rounded bg-muted/50" />
      <div className="zero-card h-32 p-4">
        <div className="h-4 w-40 rounded bg-muted/40" />
      </div>
      <div className="zero-card h-64 p-4">
        <div className="h-4 w-40 rounded bg-muted/40" />
      </div>
    </div>
  );
}
