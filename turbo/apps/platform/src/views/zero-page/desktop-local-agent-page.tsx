import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconDeviceDesktop,
  IconFolderOpen,
  IconFolderPlus,
  IconLoader2,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import { Button } from "@vm0/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vm0/ui/components/ui/table";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  addDesktopLocalAgent$,
  desktopLocalAgentData$,
  desktopLocalAgentDialogOpen$,
  desktopLocalAgentPermissionMode$,
  desktopLocalAgentSelectedBackend$,
  refreshDesktopLocalAgentData$,
  runDesktopLocalAgentAction$,
  setDesktopLocalAgentDialogOpen$,
  setDesktopLocalAgentPermissionMode$,
  setDesktopLocalAgentSelectedBackend$,
  type DesktopLocalAgentBackend,
  type DesktopLocalAgentEntry,
  type DesktopLocalAgentPermissionMode,
} from "../../signals/desktop-local-agent-page/desktop-local-agent-signals.ts";

type PermissionOption = {
  readonly value: DesktopLocalAgentPermissionMode;
  readonly label: string;
};

const BACKEND_LABELS = {
  codex: "Codex",
  "claude-code": "Claude Code",
} as const satisfies Record<DesktopLocalAgentBackend, string>;

const CODEX_PERMISSION_OPTIONS = [
  { value: "workspace-write", label: "Workspace write" },
  { value: "read-only", label: "Read only" },
  { value: "danger-full-access", label: "Danger full access" },
  { value: "bypassPermissions", label: "Bypass permissions" },
  { value: "default", label: "Default" },
] as const satisfies readonly PermissionOption[];

const CLAUDE_PERMISSION_OPTIONS = [
  { value: "default", label: "Default" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "auto", label: "Auto" },
  { value: "bypassPermissions", label: "Bypass permissions" },
  { value: "dontAsk", label: "Don't ask" },
  { value: "plan", label: "Plan" },
] as const satisfies readonly PermissionOption[];

function permissionOptions(
  backend: DesktopLocalAgentBackend,
): readonly PermissionOption[] {
  return backend === "codex"
    ? CODEX_PERMISSION_OPTIONS
    : CLAUDE_PERMISSION_OPTIONS;
}

function defaultBackendForProbes(
  probes: readonly {
    readonly backend: DesktopLocalAgentBackend;
    readonly available: boolean;
  }[],
): DesktopLocalAgentBackend {
  const codex = probes.find((probe) => {
    return probe.backend === "codex" && probe.available;
  });
  if (codex) {
    return "codex";
  }
  return (
    probes.find((probe) => {
      return probe.available;
    })?.backend ?? "codex"
  );
}

function formatDateTime(iso: string | undefined): string {
  if (!iso) {
    return "-";
  }
  return new Date(iso).toLocaleString();
}

function statusClassName(status: DesktopLocalAgentEntry["status"]): string {
  if (status === "online") {
    return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (status === "error") {
    return "bg-destructive/10 text-destructive";
  }
  if (status === "starting" || status === "stopping") {
    return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  return "bg-muted text-muted-foreground";
}

function StatusBadge({ entry }: { readonly entry: DesktopLocalAgentEntry }) {
  return (
    <span
      className={`inline-flex h-6 items-center rounded-md px-2 text-xs font-medium ${statusClassName(entry.status)}`}
      title={entry.errorMessage}
    >
      {entry.status}
    </span>
  );
}

function BackendSelect() {
  const backend = useGet(desktopLocalAgentSelectedBackend$);
  const probes = useLastResolved(desktopLocalAgentData$)?.probes ?? [];
  const selectedProbe = probes.find((candidate) => {
    return candidate.backend === backend;
  });
  const setBackend = useSet(setDesktopLocalAgentSelectedBackend$);
  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor="desktop-local-agent-backend"
        className="text-sm font-medium"
      >
        Backend
      </label>
      <Select
        value={backend}
        onValueChange={(value) => {
          setBackend(value as DesktopLocalAgentBackend);
        }}
      >
        <SelectTrigger id="desktop-local-agent-backend">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(["codex", "claude-code"] as const).map((value) => {
            const probe = probes.find((candidate) => {
              return candidate.backend === value;
            });
            return (
              <SelectItem
                key={value}
                value={value}
                disabled={probe?.available === false}
              >
                {BACKEND_LABELS[value]}
                {probe?.available === false ? " (not detected)" : ""}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      {selectedProbe?.available === false ? (
        <p className="text-xs text-destructive">
          {selectedProbe.errorMessage ?? `${BACKEND_LABELS[backend]} not found`}
        </p>
      ) : null}
    </div>
  );
}

function PermissionModeSelect() {
  const backend = useGet(desktopLocalAgentSelectedBackend$);
  const permissionMode = useGet(desktopLocalAgentPermissionMode$);
  const setPermissionMode = useSet(setDesktopLocalAgentPermissionMode$);
  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor="desktop-local-agent-permission"
        className="text-sm font-medium"
      >
        Permission mode
      </label>
      <Select
        value={permissionMode}
        onValueChange={(value) => {
          setPermissionMode(value as DesktopLocalAgentPermissionMode);
        }}
      >
        <SelectTrigger id="desktop-local-agent-permission">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {permissionOptions(backend).map((option) => {
            return (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

function AddLocalAgentDialog() {
  const open = useGet(desktopLocalAgentDialogOpen$);
  const [submitLoadable, submit] = useLoadableSet(addDesktopLocalAgent$);
  const submitting = submitLoadable.state === "loading";
  const setOpen = useSet(setDesktopLocalAgentDialogOpen$);
  const backend = useGet(desktopLocalAgentSelectedBackend$);
  const probes = useLastResolved(desktopLocalAgentData$)?.probes ?? [];
  const selectedProbe = probes.find((candidate) => {
    return candidate.backend === backend;
  });
  const backendUnavailable = selectedProbe?.available === false;
  const pageSignal = useGet(pageSignal$);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add local agent</DialogTitle>
          <DialogDescription>
            Select a workspace folder and keep it available from Zero Desktop.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <BackendSelect />
          <PermissionModeSelect />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setOpen(false);
            }}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            onClick={() => {
              detach(submit(pageSignal), Reason.DomCallback);
            }}
            disabled={submitting || backendUnavailable}
          >
            {submitting ? (
              <IconLoader2 size={16} className="animate-spin" />
            ) : (
              <IconFolderPlus size={16} />
            )}
            Select folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DesktopLocalAgentRow({
  entry,
  pending,
  onAction,
}: {
  readonly entry: DesktopLocalAgentEntry;
  readonly pending: boolean;
  readonly onAction: (
    id: string,
    action: "start" | "stop" | "openFolder" | "remove",
  ) => void;
}) {
  const running =
    entry.status === "online" ||
    entry.status === "starting" ||
    entry.status === "stopping";
  return (
    <TableRow>
      <TableCell className="font-medium">{entry.name}</TableCell>
      <TableCell className="max-w-[260px] truncate">
        <code className="text-xs">{entry.folderPath}</code>
      </TableCell>
      <TableCell>{BACKEND_LABELS[entry.backend]}</TableCell>
      <TableCell>{entry.permissionMode}</TableCell>
      <TableCell>
        <div className="flex flex-col items-start gap-1">
          <StatusBadge entry={entry} />
          {entry.errorMessage ? (
            <span className="max-w-[180px] text-xs text-destructive">
              {entry.errorMessage}
            </span>
          ) : null}
        </div>
      </TableCell>
      <TableCell>
        <code className="text-xs">{entry.hostId ?? "-"}</code>
      </TableCell>
      <TableCell>{formatDateTime(entry.lastHeartbeatAt)}</TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={pending || entry.status === "starting"}
            onClick={() => {
              onAction(entry.id, running ? "stop" : "start");
            }}
            aria-label={`${running ? "Stop" : "Start"} ${entry.name}`}
          >
            {pending ? (
              <IconLoader2 size={16} className="animate-spin" />
            ) : running ? (
              <IconPlayerStop size={16} />
            ) : (
              <IconPlayerPlay size={16} />
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => {
              onAction(entry.id, "openFolder");
            }}
            aria-label={`Open ${entry.name} folder`}
          >
            <IconFolderOpen size={16} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => {
              onAction(entry.id, "remove");
            }}
            aria-label={`Remove ${entry.name}`}
          >
            <IconTrash size={16} className="text-muted-foreground" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function DesktopLocalAgentTable() {
  const data = useLastResolved(desktopLocalAgentData$);
  const entries = data?.entries ?? [];
  const [actionLoadable, runAction] = useLoadableSet(
    runDesktopLocalAgentAction$,
  );
  const pending = actionLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);
  if (entries.length === 0) {
    return (
      <div className="rounded-xl zero-border bg-card px-6 py-10 text-center text-sm text-muted-foreground">
        No local agents yet.
      </div>
    );
  }
  const onAction = (
    id: string,
    action: "start" | "stop" | "openFolder" | "remove",
  ) => {
    detach(runAction({ id, action }, pageSignal), Reason.DomCallback);
  };
  return (
    <div className="rounded-xl zero-border bg-card overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Folder</TableHead>
            <TableHead>Backend</TableHead>
            <TableHead>Permission</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Host</TableHead>
            <TableHead>Last heartbeat</TableHead>
            <TableHead className="w-[170px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => {
            return (
              <DesktopLocalAgentRow
                key={entry.id}
                entry={entry}
                pending={pending}
                onAction={onAction}
              />
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function DesktopLocalAgentPageHeader() {
  const setOpen = useSet(setDesktopLocalAgentDialogOpen$);
  const setBackend = useSet(setDesktopLocalAgentSelectedBackend$);
  const refresh = useSet(refreshDesktopLocalAgentData$);
  const probes = useLastResolved(desktopLocalAgentData$)?.probes ?? [];
  return (
    <header className="hidden md:block shrink-0 bg-transparent px-4 sm:px-6 pt-10 pb-4">
      <div className="mx-auto max-w-[1100px] flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground flex items-center gap-2">
            <IconDeviceDesktop size={20} stroke={1.5} />
            Local Agents
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Desktop-managed workspaces for Codex and Claude Code
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            aria-label="Refresh local agent health"
            onClick={() => {
              refresh();
            }}
          >
            <IconRefresh size={16} />
          </Button>
          <Button
            onClick={() => {
              setBackend(defaultBackendForProbes(probes));
              setOpen(true);
            }}
          >
            <IconFolderPlus size={16} />
            Add local agent
          </Button>
        </div>
      </div>
    </header>
  );
}

function DesktopLocalAgentPageBody() {
  const dataLoadable = useLoadable(desktopLocalAgentData$);
  return (
    <main className="shrink-0 px-4 sm:px-6 pt-3 pb-16">
      <div className="mx-auto max-w-[1100px] flex flex-col gap-6">
        {dataLoadable.state === "loading" ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <IconLoader2 size={20} className="animate-spin" />
          </div>
        ) : dataLoadable.state === "hasError" ? (
          <div className="rounded-xl zero-border bg-card px-6 py-10 text-center text-sm text-destructive">
            Failed to load local agents.
          </div>
        ) : (
          <DesktopLocalAgentTable />
        )}
      </div>
    </main>
  );
}

export function ZeroDesktopLocalAgentPage() {
  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]">
      <DesktopLocalAgentPageHeader />
      <DesktopLocalAgentPageBody />
      <AddLocalAgentDialog />
    </div>
  );
}
