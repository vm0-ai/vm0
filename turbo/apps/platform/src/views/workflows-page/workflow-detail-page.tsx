// Agent-scoped workflow detail at /agents/:agentId/workflows/:workflowId. Hosts
// the instruction editor, supplementary file manager (SKILL.md is never shown),
// triggers, visibility controls, metadata editing, run-once, copy, and delete.
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type {
  WorkflowFileEntry,
  WorkflowFileMetadata,
  ZeroWorkflowDetailResponse,
  ZeroWorkflowSchedule,
  ZeroWorkflowScheduleType,
  ZeroWorkflowTriggerSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";
import {
  IconArrowLeft,
  IconAlertTriangle,
  IconClock,
  IconLoader2,
  IconPlus,
  IconTrash,
  IconUpload,
} from "@tabler/icons-react";
import {
  cn,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui";

import { agents$, currentAgentId$ } from "../../signals/agent.ts";
import { user$ } from "../../signals/auth.ts";
import {
  changeWorkflowVisibility$,
  createWorkflowScheduleTrigger$,
  currentWorkflowId$,
  deleteWorkflow$,
  deleteWorkflowScheduleTrigger$,
  copyWorkflow$,
  runWorkflow$,
  runWorkflowScheduleTrigger$,
  selectedWorkflowFilePath$,
  setSelectedWorkflowFilePath$,
  setWorkflowTriggerEnabled$,
  updateWorkflow$,
  workflowDetail,
} from "../../signals/workflows-page/workflows-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Markdown } from "../components/markdown.tsx";
import { Link } from "../router/link.tsx";
import {
  buildWorkflowFileTree,
  isMarkdownPath,
  stripMarkdownFrontmatter,
  triggerKindLabel,
  VisibilityBadge,
  WorkflowFileTree,
  workflowTitle,
} from "./workflow-shared.tsx";

const FIELD_CLASS =
  "h-9 w-full rounded-md border border-border/60 bg-background px-2.5 text-sm outline-none focus:border-primary";
const TRIGGER_FIELD_CLASS =
  "h-8 w-full rounded-md border border-border/60 bg-background px-2 text-xs";
const TRIGGER_TIMEZONE = "UTC";

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
  const agentId = useGet(currentAgentId$);
  const detailLoadable = useLoadable(workflowDetail(workflowId));
  const detail =
    detailLoadable.state === "hasData" ? detailLoadable.data : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 px-4 pb-3 pt-3 sm:px-6 md:pt-8">
        <div className="mx-auto w-full max-w-[900px]">
          {agentId ? (
            <Link
              pathname={ROUTES.agentWorkflows}
              options={{ pathParams: { agentId } }}
              className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <IconArrowLeft size={14} stroke={1.5} />
              <span>Back to workflows</span>
            </Link>
          ) : null}
        </div>
      </header>
      <main className="flex-1 overflow-auto px-4 pb-10 sm:px-6">
        <div className="mx-auto w-full max-w-[900px]">
          {detail ? (
            <WorkflowDetailBody detail={detail} />
          ) : detailLoadable.state === "hasData" ? (
            <p className="text-sm text-muted-foreground">Workflow not found.</p>
          ) : (
            <DetailSkeleton />
          )}
        </div>
      </main>
    </div>
  );
}

function WorkflowDetailBody({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  return (
    <div className="flex flex-col gap-4">
      <DetailHeader detail={detail} />
      <ShadowWarning detail={detail} />
      <MetadataEditor detail={detail} />
      <InstructionEditor detail={detail} />
      <SupplementaryFiles detail={detail} />
      <TriggersSection detail={detail} />
      <VisibilitySection detail={detail} />
      <DangerZone detail={detail} />
    </div>
  );
}

function DetailHeader({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  const pageSignal = useGet(pageSignal$);
  const navigate = useSet(detachedNavigateTo$);
  const [runLoadable, runWorkflow] = useLoadableSet(runWorkflow$);
  const running = runLoadable.state === "loading";

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">
          {workflowTitle(detail)}
        </h1>
        <p className="mt-0.5 truncate text-sm text-muted-foreground">
          /{detail.name}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <VisibilityBadge
          visibility={detail.visibility}
          requestToPublish={detail.requestToPublish}
        />
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
          <span>Run once</span>
        </button>
      </div>
    </div>
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
    <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
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

function MetadataEditor({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  const pageSignal = useGet(pageSignal$);
  const [saveLoadable, updateWorkflow] = useLoadableSet(updateWorkflow$);
  const saving = saveLoadable.state === "loading";
  const disabled = !detail.canManage || saving;

  return (
    <form
      aria-label="Workflow metadata"
      className="zero-card flex flex-col gap-3 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!detail.canManage) {
          return;
        }
        const form = new FormData(event.currentTarget);
        const displayName = String(form.get("displayName") ?? "").trim();
        const description = String(form.get("description") ?? "").trim();
        detach(
          updateWorkflow(
            {
              workflowId: detail.id,
              body: {
                displayName: displayName || null,
                description: description || null,
              },
            },
            pageSignal,
          ),
          Reason.DomCallback,
        );
      }}
    >
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Display name
        <input
          name="displayName"
          aria-label="Display name"
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
          rows={2}
          className="w-full rounded-md border border-border/60 bg-background px-2.5 py-2 text-sm outline-none focus:border-primary"
        />
      </label>
      {detail.canManage ? (
        <button
          type="submit"
          disabled={saving}
          className={cn(
            "zero-btn-morandi inline-flex h-9 w-fit items-center gap-1.5 rounded-md px-3 text-sm",
            saving ? "cursor-not-allowed opacity-60" : "",
          )}
        >
          {saving ? <IconLoader2 size={14} className="animate-spin" /> : null}
          <span>Save details</span>
        </button>
      ) : null}
    </form>
  );
}

function InstructionEditor({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  const pageSignal = useGet(pageSignal$);
  const [saveLoadable, updateWorkflow] = useLoadableSet(updateWorkflow$);
  const saving = saveLoadable.state === "loading";
  const disabled = !detail.canManage || saving;

  return (
    <form
      aria-label="Workflow instruction"
      className="zero-card flex flex-col gap-3 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!detail.canManage) {
          return;
        }
        const form = new FormData(event.currentTarget);
        const instruction = String(form.get("instruction") ?? "");
        detach(
          updateWorkflow(
            {
              workflowId: detail.id,
              body: { instruction: instruction || null },
            },
            pageSignal,
          ),
          Reason.DomCallback,
        );
      }}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">Instruction</span>
      </div>
      <textarea
        name="instruction"
        aria-label="Instruction"
        defaultValue={detail.instruction ?? ""}
        disabled={disabled}
        rows={10}
        placeholder="Describe what this workflow does when it runs…"
        className="w-full rounded-md border border-border/60 bg-background px-3 py-2 font-mono text-sm leading-6 outline-none focus:border-primary"
      />
      {detail.canManage ? (
        <button
          type="submit"
          disabled={saving}
          className={cn(
            "zero-btn-morandi inline-flex h-9 w-fit items-center gap-1.5 rounded-md px-3 text-sm",
            saving ? "cursor-not-allowed opacity-60" : "",
          )}
        >
          {saving ? <IconLoader2 size={14} className="animate-spin" /> : null}
          <span>Save instruction</span>
        </button>
      ) : null}
    </form>
  );
}

function SupplementaryFiles({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  const explicitSelectedFilePath = useGet(selectedWorkflowFilePath$);
  const setSelectedFilePath = useSet(setSelectedWorkflowFilePath$);
  const files: readonly WorkflowFileMetadata[] = detail.files ?? [];
  const fileContents: readonly WorkflowFileEntry[] = detail.fileContents ?? [];
  const preferredFilePath = explicitSelectedFilePath ?? files[0]?.path ?? null;
  const selectedFile = preferredFilePath
    ? fileContents.find((file) => {
        return file.path === preferredFilePath;
      })
    : null;

  return (
    <div className="zero-card overflow-hidden">
      <SupplementaryFilesHeader
        detail={detail}
        fileCount={files.length}
        fileContents={fileContents}
        preferredFilePath={preferredFilePath}
      />
      <div className="grid gap-0 lg:grid-cols-[220px_minmax(0,1fr)]">
        <div className="max-h-[280px] overflow-auto border-b border-border/60 p-2 lg:border-b-0 lg:border-r">
          {files.length > 0 ? (
            <WorkflowFileTree
              nodes={buildWorkflowFileTree(files)}
              depth={0}
              selectedPath={preferredFilePath}
              onSelectFile={setSelectedFilePath}
            />
          ) : (
            <p className="px-2 py-3 text-xs text-muted-foreground">No files.</p>
          )}
        </div>
        <WorkflowFilePreview
          preferredFilePath={preferredFilePath}
          selectedFile={selectedFile}
        />
      </div>
    </div>
  );
}

function SupplementaryFilesHeader({
  detail,
  fileCount,
  fileContents,
  preferredFilePath,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
  readonly fileCount: number;
  readonly fileContents: readonly WorkflowFileEntry[];
  readonly preferredFilePath: string | null;
}) {
  const setSelectedFilePath = useSet(setSelectedWorkflowFilePath$);
  const pageSignal = useGet(pageSignal$);
  const [saveLoadable, updateWorkflow] = useLoadableSet(updateWorkflow$);
  const saving = saveLoadable.state === "loading";
  const canManage = detail.canManage && !saving;
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
      })(),
      Reason.DomCallback,
    );
  };
  const deleteFile = (filePath: string) => {
    detach(
      (async () => {
        const nextFiles = fileContents.filter((file) => {
          return file.path !== filePath;
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
    <div className="flex h-10 items-center justify-between border-b border-border/60 px-4">
      <span className="text-sm font-medium text-foreground">Files</span>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{fileCount}</span>
        {detail.canManage ? (
          <>
            <WorkflowFileUploadButton
              canManage={canManage}
              onUpload={uploadFiles}
              saving={saving}
            />
            <WorkflowFileDeleteButton
              canManage={canManage}
              onDelete={deleteFile}
              preferredFilePath={preferredFilePath}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

function WorkflowFileUploadButton({
  canManage,
  onUpload,
  saving,
}: {
  readonly canManage: boolean;
  readonly onUpload: (files: FileList) => void;
  readonly saving: boolean;
}) {
  return (
    <label
      className={cn(
        "zero-btn-morandi inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs",
        saving ? "pointer-events-none opacity-60" : "",
      )}
    >
      {saving ? (
        <IconLoader2 size={13} className="animate-spin" />
      ) : (
        <IconUpload size={13} stroke={1.5} />
      )}
      <span>Upload</span>
      <input
        type="file"
        multiple
        disabled={!canManage}
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
  );
}

function WorkflowFileDeleteButton({
  canManage,
  onDelete,
  preferredFilePath,
}: {
  readonly canManage: boolean;
  readonly onDelete: (filePath: string) => void;
  readonly preferredFilePath: string | null;
}) {
  if (!preferredFilePath) {
    return null;
  }

  return (
    <button
      type="button"
      aria-label={`Delete ${preferredFilePath}`}
      disabled={!canManage}
      className={cn(
        "zero-btn-morandi inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-destructive/90",
        !canManage ? "cursor-not-allowed opacity-60" : "",
      )}
      onClick={() => {
        onDelete(preferredFilePath);
      }}
    >
      <IconTrash size={13} stroke={1.5} />
      <span>Delete</span>
    </button>
  );
}

function WorkflowFilePreview({
  preferredFilePath,
  selectedFile,
}: {
  readonly preferredFilePath: string | null;
  readonly selectedFile: WorkflowFileEntry | null | undefined;
}) {
  if (preferredFilePath && selectedFile) {
    if (isMarkdownPath(preferredFilePath)) {
      return (
        <div
          aria-label="Workflow file content"
          className="max-h-[420px] overflow-auto px-4 py-3"
        >
          <Markdown source={stripMarkdownFrontmatter(selectedFile.content)} />
        </div>
      );
    }

    return (
      <pre
        aria-label="Workflow file content"
        className="max-h-[420px] overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-sm leading-6 text-foreground"
      >
        {selectedFile.content}
      </pre>
    );
  }

  return (
    <div className="flex min-h-[200px] items-center justify-center px-4 text-sm text-muted-foreground">
      {preferredFilePath ? "No content available for this file." : "No files."}
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

function TriggersSection({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  const userLoadable = useLoadable(user$);
  const currentUserId =
    userLoadable.state === "hasData" ? (userLoadable.data?.id ?? "") : "";
  const triggers = detail.triggers;

  return (
    <div className="zero-card overflow-hidden">
      <div className="flex h-10 items-center justify-between border-b border-border/60 px-4">
        <span className="text-sm font-medium text-foreground">Triggers</span>
        <span className="text-xs text-muted-foreground">{triggers.length}</span>
      </div>
      <CreateTriggerForm workflowId={detail.id} />
      <div className="max-h-[320px] overflow-auto p-2">
        {triggers.length > 0 ? (
          <div className="flex flex-col gap-1">
            {triggers.map((trigger) => {
              return (
                <TriggerRow
                  key={trigger.id}
                  trigger={trigger}
                  canManage={trigger.ownerUserId === currentUserId}
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
    </div>
  );
}

function CreateTriggerForm({ workflowId }: { readonly workflowId: string }) {
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createTrigger] = useLoadableSet(
    createWorkflowScheduleTrigger$,
  );
  const creating = createLoadable.state === "loading";

  return (
    <form
      aria-label="Create schedule trigger"
      className="flex flex-col gap-1.5 border-b border-border/60 p-3 sm:flex-row sm:items-center"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const scheduleType = String(
          form.get("scheduleType") ?? "cron",
        ) as ZeroWorkflowScheduleType;
        const schedule = buildTriggerSchedule(scheduleType, {
          cronExpression: String(form.get("cronExpression") ?? ""),
          intervalSeconds: String(form.get("intervalSeconds") ?? ""),
          atTime: String(form.get("atTime") ?? ""),
        });
        if (!schedule) {
          return;
        }
        detach(
          createTrigger({ workflowId, schedule }, pageSignal),
          Reason.DomCallback,
        );
      }}
    >
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
          "zero-btn-morandi inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs",
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

function TriggerRow({
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

  return (
    <div className="flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground">
        <IconClock size={13} stroke={1.5} />
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
          {triggerKindLabel(trigger.kind)}
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

function VisibilitySection({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  const pageSignal = useGet(pageSignal$);
  const [changeLoadable, changeVisibility] = useLoadableSet(
    changeWorkflowVisibility$,
  );
  const busy = changeLoadable.state === "loading";

  const action = (
    label: string,
    value: Parameters<typeof changeVisibility>[0]["action"],
    destructive = false,
  ) => {
    return (
      <button
        key={value}
        type="button"
        disabled={busy}
        className={cn(
          "zero-btn-morandi inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs",
          busy ? "cursor-not-allowed opacity-60" : "",
          destructive ? "text-destructive/90" : "",
        )}
        onClick={() => {
          detach(
            changeVisibility(
              { workflowId: detail.id, action: value },
              pageSignal,
            ),
            Reason.DomCallback,
          );
        }}
      >
        {label}
      </button>
    );
  };

  const buttons = [];
  if (detail.visibility === "private") {
    if (detail.requestToPublish) {
      buttons.push(action("Cancel publish request", "cancel-publish-request"));
      if (detail.canManage) {
        buttons.push(action("Approve publish", "approve-publish"));
        buttons.push(action("Reject publish", "reject-publish", true));
      }
    } else {
      buttons.push(action("Request publish", "request-publish"));
    }
  } else if (detail.canManage) {
    buttons.push(action("Demote to private", "demote", true));
  }

  if (buttons.length === 0) {
    return null;
  }

  return (
    <div className="zero-card flex flex-col gap-2 p-4">
      <span className="text-sm font-medium text-foreground">Visibility</span>
      <div className="flex flex-wrap items-center gap-2">{buttons}</div>
    </div>
  );
}

function DangerZone({
  detail,
}: {
  readonly detail: ZeroWorkflowDetailResponse;
}) {
  const pageSignal = useGet(pageSignal$);
  const navigate = useSet(detachedNavigateTo$);
  const agentsLoadable = useLoadable(agents$);
  const agents = agentsLoadable.state === "hasData" ? agentsLoadable.data : [];
  const [copyLoadable, copyWorkflow] = useLoadableSet(copyWorkflow$);
  const [deleteLoadable, deleteWorkflow] = useLoadableSet(deleteWorkflow$);
  const copying = copyLoadable.state === "loading";
  const deleting = deleteLoadable.state === "loading";

  return (
    <div className="zero-card flex flex-col gap-3 p-4">
      <span className="text-sm font-medium text-foreground">
        Copy &amp; delete
      </span>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select
          value=""
          disabled={copying || agents.length === 0}
          onValueChange={(toAgentId) => {
            detach(
              copyWorkflow({ workflowId: detail.id, toAgentId }, pageSignal),
              Reason.DomCallback,
            );
          }}
        >
          <SelectTrigger
            aria-label="Copy workflow to agent"
            className="zero-btn-morandi h-9 w-full gap-1.5 rounded-md px-3 text-sm sm:w-64"
          >
            {copying ? (
              <IconLoader2 size={14} className="shrink-0 animate-spin" />
            ) : null}
            <SelectValue placeholder="Copy to another agent" />
          </SelectTrigger>
          <SelectContent>
            {agents.map((agent) => {
              return (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.displayName ?? agent.id}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        {detail.canManage ? (
          <button
            type="button"
            disabled={deleting}
            className={cn(
              "zero-btn-morandi inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm text-destructive/90",
              deleting ? "cursor-not-allowed opacity-60" : "",
            )}
            onClick={() => {
              detach(
                (async () => {
                  await deleteWorkflow(detail.id, pageSignal);
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
            <span>Delete workflow</span>
          </button>
        ) : null}
      </div>
    </div>
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
