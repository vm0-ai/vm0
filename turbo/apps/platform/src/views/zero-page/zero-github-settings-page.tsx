import type { FormEvent } from "react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconArrowLeft,
  IconDotsVertical,
  IconPencil,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import {
  Button,
  Card,
  CardContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  cn,
} from "@vm0/ui";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@vm0/ui/components/ui/dialog";
import { Input } from "@vm0/ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui/components/ui/select";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import { sortedAgents$ } from "../../signals/agent.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import {
  connectGithubInstallation$,
  createGithubLabelListener$,
  deleteGithubLabelListener$,
  disconnectGithubInstallation$,
  githubAddListenerDialogOpen$,
  githubEditingListenerId$,
  githubIntegrationData$,
  githubLabelListenerForm$,
  resetGithubLabelListenerForm$,
  setGithubAddListenerDialogOpen$,
  setGithubEditingListenerId$,
  setGithubLabelListenerForm$,
  uninstallGithubInstallation$,
  updateGithubLabelListener$,
  type GithubIntegrationData,
  type GithubLabelListenerForm,
  type GithubLabelTriggerMode,
} from "../../signals/zero-page/zero-github.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { LoadingSwitch } from "../components/loading-switch.tsx";
import { Link } from "../router/link.tsx";
import githubIconImg from "./components/settings/icons/github.svg";
import { githubInstallationTargetName } from "./github-installation-target.ts";

type GithubListener = GithubIntegrationData["labelListeners"][number];

const ZERO_BORDER = {
  border: "0.7px solid hsl(var(--gray-400))",
} as const;

interface GithubAgentOption {
  readonly id: string;
  readonly displayName?: string | null;
}

const TRIGGER_MODE_OPTIONS: readonly {
  readonly value: GithubLabelTriggerMode;
  readonly label: string;
  readonly description: string;
  readonly badgeClassName: string;
}[] = [
  {
    value: "created_by_me",
    label: "Created by me",
    description:
      "Runs only when the issue or PR author is your connected GitHub account.",
    badgeClassName:
      "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20",
  },
  {
    value: "anyone",
    label: "Any author",
    description:
      "Runs when any issue or PR receives the matching GitHub label.",
    badgeClassName:
      "bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/20",
  },
];

function getTriggerModeOption(mode: GithubLabelTriggerMode) {
  const option = TRIGGER_MODE_OPTIONS.find((item) => {
    return item.value === mode;
  });
  if (!option) {
    throw new Error(`Unknown GitHub trigger mode: ${mode}`);
  }
  return option;
}

function GithubSettingsSkeleton() {
  return (
    <div className="flex flex-col gap-4" data-testid="github-settings-loading">
      <Skeleton className="h-4 w-64 max-w-full" />
      <div className="zero-card p-4">
        <Skeleton className="h-5 w-36" />
        <div className="mt-4 space-y-3">
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
        </div>
      </div>
      <div className="zero-card p-4">
        <Skeleton className="h-5 w-28" />
        <div className="mt-4 grid gap-3">
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-24 w-full rounded-md" />
        </div>
      </div>
    </div>
  );
}

function GithubListenerList({
  listeners,
}: {
  readonly listeners: readonly GithubListener[];
}) {
  const pageSignal = useGet(pageSignal$);
  const setOpen = useSet(setGithubAddListenerDialogOpen$);
  const setEditingListenerId = useSet(setGithubEditingListenerId$);
  const setForm = useSet(setGithubLabelListenerForm$);
  const [deleteLoadable, deleteListener] = useLoadableSet(
    deleteGithubLabelListener$,
  );
  const deleting = deleteLoadable.state === "loading";

  if (listeners.length === 0) {
    return (
      <div className="max-w-xl px-4 py-6 text-sm text-muted-foreground">
        Add a label listener to run an agent when a GitHub issue or pull request
        gets a matching label.
      </div>
    );
  }

  return (
    <div className="divide-y divide-border/50">
      {listeners.map((listener) => {
        const triggerModeBadge = getTriggerModeOption(listener.triggerMode);
        return (
          <div
            key={listener.id}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="min-w-0 truncate text-sm font-medium text-foreground">
                {listener.labelName}
              </span>
              <span
                className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none ${triggerModeBadge.badgeClassName}`}
              >
                {triggerModeBadge.label}
              </span>
              {!listener.enabled ? (
                <span className="shrink-0 rounded border border-muted-foreground/20 bg-muted px-1.5 py-0.5 text-[11px] font-medium leading-none text-muted-foreground">
                  Disabled
                </span>
              ) : null}
            </div>
            {listener.canManage ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 rounded-lg text-muted-foreground hover:text-foreground"
                    disabled={deleting}
                    aria-label={`Actions for ${listener.labelName}`}
                  >
                    <IconDotsVertical size={14} stroke={1.5} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem
                    className="gap-2"
                    disabled={deleting}
                    onSelect={() => {
                      setForm({
                        labelName: listener.labelName,
                        agentId: listener.agent?.id ?? "",
                        triggerMode: listener.triggerMode,
                        prompt: listener.prompt,
                        enabled: listener.enabled,
                      });
                      setEditingListenerId(listener.id);
                      setOpen(true);
                    }}
                  >
                    <IconPencil size={14} stroke={1.5} />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="gap-2 text-destructive focus:text-destructive"
                    disabled={deleting}
                    onSelect={() => {
                      detach(
                        deleteListener(listener.id, pageSignal),
                        Reason.DomCallback,
                      );
                    }}
                  >
                    <IconTrash size={14} stroke={1.5} />
                    {deleting ? "Deleting..." : "Delete"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function GithubListenerPrimaryFields({
  agents,
  creating,
  form,
  selectedAgentId,
  setForm,
}: {
  readonly agents: readonly GithubAgentOption[];
  readonly creating: boolean;
  readonly form: GithubLabelListenerForm;
  readonly selectedAgentId: string;
  readonly setForm: (patch: Partial<GithubLabelListenerForm>) => void;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="flex flex-col gap-2 text-sm font-medium text-foreground">
        Label
        <Input
          value={form.labelName}
          placeholder="ready-for-zero"
          disabled={creating}
          className="h-10 rounded-lg"
          onChange={(event) => {
            setForm({ labelName: event.target.value });
          }}
        />
      </label>
      <label className="flex flex-col gap-2 text-sm font-medium text-foreground">
        Agent
        <Select
          value={selectedAgentId}
          disabled={creating || agents.length === 0}
          onValueChange={(agentId) => {
            setForm({ agentId });
          }}
        >
          <SelectTrigger className="h-10 rounded-lg" style={ZERO_BORDER}>
            <SelectValue placeholder="Select agent" />
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
      </label>
    </div>
  );
}

function GithubTriggerModeField({
  creating,
  triggerMode,
  setForm,
}: {
  readonly creating: boolean;
  readonly triggerMode: GithubLabelTriggerMode;
  readonly setForm: (patch: Partial<GithubLabelListenerForm>) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm font-medium text-foreground">Trigger mode</div>
      <div
        role="radiogroup"
        aria-label="Trigger mode"
        className="grid gap-2 sm:grid-cols-2"
      >
        {TRIGGER_MODE_OPTIONS.map((option) => {
          const active = option.value === triggerMode;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={creating}
              style={{
                border: active
                  ? "0.7px solid hsl(var(--primary))"
                  : ZERO_BORDER.border,
              }}
              className={cn(
                "flex min-h-[86px] flex-col gap-1 rounded-lg bg-card px-4 py-3 text-left transition-colors",
                active && "bg-primary/5",
                !active && !creating && "hover:bg-muted/40",
                creating && "cursor-not-allowed opacity-50",
              )}
              onClick={() => {
                setForm({ triggerMode: option.value });
              }}
            >
              <span className="text-sm font-medium text-foreground">
                {option.label}
              </span>
              <span className="text-[13px] leading-snug text-muted-foreground">
                {option.description}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function GithubPromptField({
  creating,
  prompt,
  setForm,
}: {
  readonly creating: boolean;
  readonly prompt: string;
  readonly setForm: (patch: Partial<GithubLabelListenerForm>) => void;
}) {
  return (
    <label className="flex flex-col gap-2 text-sm font-medium text-foreground">
      Prompt
      <textarea
        value={prompt}
        disabled={creating}
        rows={4}
        className="min-h-24 resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        placeholder="Review the labeled issue or PR and take the next appropriate action."
        onChange={(event) => {
          setForm({ prompt: event.target.value });
        }}
      />
    </label>
  );
}

function GithubListenerEnabledField({
  creating,
  enabled,
  setForm,
}: {
  readonly creating: boolean;
  readonly enabled: boolean;
  readonly setForm: (patch: Partial<GithubLabelListenerForm>) => void;
}) {
  return (
    <div
      className="flex items-center justify-between gap-4 rounded-lg bg-card px-4 py-3"
      style={ZERO_BORDER}
    >
      <span className="text-sm font-medium text-foreground">Enabled</span>
      <LoadingSwitch
        checked={enabled}
        loading={creating}
        ariaLabel={enabled ? "Disable listener" : "Enable listener"}
        onCheckedChange={(nextEnabled) => {
          setForm({ enabled: nextEnabled });
        }}
      />
    </div>
  );
}

function GithubListenerForm({
  agents,
  onCancel,
  onSaved,
  listenerId,
}: {
  readonly agents: readonly GithubAgentOption[];
  readonly onCancel: () => void;
  readonly onSaved: () => void;
  readonly listenerId: string | null;
}) {
  const form = useGet(githubLabelListenerForm$);
  const setForm = useSet(setGithubLabelListenerForm$);
  const resetForm = useSet(resetGithubLabelListenerForm$);
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createListener] = useLoadableSet(
    createGithubLabelListener$,
  );
  const [updateLoadable, updateListener] = useLoadableSet(
    updateGithubLabelListener$,
  );
  const saving =
    createLoadable.state === "loading" || updateLoadable.state === "loading";
  const selectedAgentId = form.agentId || agents[0]?.id || "";
  const canCreate = Boolean(
    form.labelName.trim() && form.prompt.trim() && selectedAgentId,
  );

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const labelName = form.labelName.trim();
    const prompt = form.prompt.trim();
    if (!labelName || !prompt || !selectedAgentId || saving) {
      return;
    }

    detach(
      (async () => {
        if (listenerId) {
          await updateListener(
            {
              listenerId,
              body: {
                labelName,
                agentId: selectedAgentId,
                triggerMode: form.triggerMode,
                prompt,
                enabled: form.enabled,
              },
            },
            pageSignal,
          );
        } else {
          await createListener(
            {
              labelName,
              agentId: selectedAgentId,
              triggerMode: form.triggerMode,
              prompt,
              enabled: form.enabled,
            },
            pageSignal,
          );
        }
        resetForm();
        onSaved();
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <form className="flex flex-col gap-5" onSubmit={submit}>
      <GithubListenerPrimaryFields
        agents={agents}
        creating={saving}
        form={form}
        selectedAgentId={selectedAgentId}
        setForm={setForm}
      />
      <GithubTriggerModeField
        creating={saving}
        triggerMode={form.triggerMode}
        setForm={setForm}
      />
      <GithubListenerEnabledField
        creating={saving}
        enabled={form.enabled}
        setForm={setForm}
      />
      <GithubPromptField
        creating={saving}
        prompt={form.prompt}
        setForm={setForm}
      />
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={saving}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={!canCreate || saving}>
          {saving
            ? listenerId
              ? "Saving..."
              : "Adding..."
            : listenerId
              ? "Save changes"
              : "Add listener"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function AddGithubListenerDialog({
  agents,
  disabled,
}: {
  readonly agents: readonly GithubAgentOption[];
  readonly disabled: boolean;
}) {
  const open = useGet(githubAddListenerDialogOpen$);
  const editingListenerId = useGet(githubEditingListenerId$);
  const setOpen = useSet(setGithubAddListenerDialogOpen$);
  const setEditingListenerId = useSet(setGithubEditingListenerId$);
  const resetForm = useSet(resetGithubLabelListenerForm$);

  const close = () => {
    setOpen(false);
    setEditingListenerId(null);
    resetForm();
  };

  const title = editingListenerId
    ? "Edit GitHub label listener"
    : "Add GitHub label listener";
  const description = editingListenerId
    ? "Update this label trigger for GitHub issues and pull requests."
    : "Create a label trigger for GitHub issues and pull requests.";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setEditingListenerId(null);
          resetForm();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className="h-8 gap-2 rounded-lg px-3 text-sm"
          onClick={() => {
            setEditingListenerId(null);
            resetForm();
          }}
        >
          <IconPlus size={14} stroke={1.8} />
          Add listener
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <GithubListenerForm
          agents={agents}
          onCancel={close}
          onSaved={close}
          listenerId={editingListenerId}
        />
      </DialogContent>
    </Dialog>
  );
}

function GithubLabelListenersCard({
  agents,
  agentsLoading,
  listeners,
}: {
  readonly agents: readonly GithubAgentOption[];
  readonly agentsLoading: boolean;
  readonly listeners: readonly GithubListener[];
}) {
  return (
    <section className="zero-card overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border/50 px-4 py-3">
        <h2 className="text-sm font-medium text-foreground">Label listeners</h2>
        <AddGithubListenerDialog agents={agents} disabled={agentsLoading} />
      </div>
      <GithubListenerList listeners={listeners} />
    </section>
  );
}

function GithubNotInstalled() {
  return (
    <div className="zero-card px-6 py-10 text-center text-sm text-muted-foreground">
      GitHub is not installed.
    </div>
  );
}

function githubConnectedUserLabel(data: GithubIntegrationData): string | null {
  if (!data.isConnected) {
    return null;
  }

  const username = data.connectedGithubUsername?.trim().replace(/^@+/, "");
  if (username) {
    return `@${username}`;
  }

  return data.connectedGithubUserId;
}

function GithubConnectionCard({
  data,
}: {
  readonly data: GithubIntegrationData & { readonly isInstalled: true };
}) {
  const pageSignal = useGet(pageSignal$);
  const [connectLoadable, connect] = useLoadableSet(connectGithubInstallation$);
  const [disconnectLoadable, disconnect] = useLoadableSet(
    disconnectGithubInstallation$,
  );
  const connecting = connectLoadable.state === "loading";
  const disconnecting = disconnectLoadable.state === "loading";
  const busy = connecting || disconnecting;
  const connectedUser = githubConnectedUserLabel(data);
  const description = connectedUser
    ? `Connected as ${connectedUser}`
    : data.isConnected
      ? "GitHub account connected"
      : "Connect a GitHub account to use user-specific triggers";

  return (
    <section className="zero-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">Connection</div>
          <div className="mt-1 text-sm text-muted-foreground">
            {description}
          </div>
        </div>
        {data.isConnected ? (
          <Button
            type="button"
            variant="outline"
            className="h-9 shrink-0"
            disabled={busy}
            onClick={() => {
              detach(disconnect(pageSignal), Reason.DomCallback);
            }}
          >
            {disconnecting ? "Disconnecting..." : "Disconnect"}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            className="h-9 shrink-0"
            disabled={busy}
            onClick={() => {
              detach(connect(data.connectUrl, pageSignal), Reason.DomCallback);
            }}
          >
            {connecting ? "Connecting..." : "Connect"}
          </Button>
        )}
      </div>
    </section>
  );
}

function GithubDangerZoneCard({
  data,
}: {
  readonly data: GithubIntegrationData & { readonly isInstalled: true };
}) {
  const pageSignal = useGet(pageSignal$);
  const [uninstallLoadable, uninstall] = useLoadableSet(
    uninstallGithubInstallation$,
  );
  const uninstalling = uninstallLoadable.state === "loading";
  const canUninstall = data.installation.isAdmin;

  return (
    <Card className="zero-card overflow-hidden border-destructive/20">
      <CardContent className="p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
          <div className="min-w-0 sm:max-w-[46%]">
            <h3 className="text-sm font-medium text-foreground">Danger zone</h3>
            <p className="mt-1 text-xs leading-snug text-muted-foreground">
              Uninstall GitHub for this workspace. This removes label triggers
              and cannot be undone.
            </p>
          </div>
          <div className="flex w-full shrink-0 justify-end sm:w-auto">
            <Dialog>
              <DialogTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 gap-2 rounded-lg border-destructive/40 px-4 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  disabled={!canUninstall || uninstalling}
                >
                  <IconTrash size={14} stroke={1.5} />
                  Uninstall
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Uninstall GitHub?</DialogTitle>
                  <DialogDescription>
                    This will remove the GitHub integration for this workspace.
                    Label listeners will stop triggering agent runs. This action
                    cannot be undone.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="outline" size="sm">
                      Cancel
                    </Button>
                  </DialogClose>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={uninstalling}
                    onClick={() => {
                      detach(uninstall(pageSignal), Reason.DomCallback);
                    }}
                  >
                    {uninstalling ? "Uninstalling..." : "Uninstall"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function ZeroGithubSettingsPage() {
  const dataLoadable = useLastLoadable(githubIntegrationData$);
  const agentsLoadable = useLastLoadable(sortedAgents$);
  const agents = agentsLoadable.state === "hasData" ? agentsLoadable.data : [];
  const data = dataLoadable.state === "hasData" ? dataLoadable.data : null;
  const loading = dataLoadable.state === "loading" && !data;
  const hasError =
    dataLoadable.state === "hasError" || agentsLoadable.state === "hasError";
  const installedData = data?.isInstalled ? data : null;
  const isInstalled = installedData !== null;
  const listeners = installedData?.labelListeners ?? [];
  const agentsLoading = agentsLoadable.state === "loading";
  const installationTarget = installedData
    ? githubInstallationTargetName(installedData.installation)
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 bg-transparent px-4 pb-3 pt-10 sm:px-6">
        <div className="mx-auto max-w-[900px]">
          <div className="mb-4">
            <Button
              asChild
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 gap-2 px-2 text-muted-foreground hover:text-foreground"
            >
              <Link pathname={ROUTES.works} title="Back to integrations">
                <IconArrowLeft size={17} stroke={1.8} />
                Back to integrations
              </Link>
            </Button>
          </div>
          <div className="flex items-start gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted">
                <img src={githubIconImg} alt="" className="h-7 w-7" />
              </span>
              <div className="min-w-0">
                <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">
                  GitHub
                </h1>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  <span>
                    Run agents from GitHub issue and PR labels or @Zero
                  </span>
                  {installationTarget ? (
                    <>
                      {" "}
                      <span
                        data-testid="github-installation-target"
                        className="text-foreground"
                      >
                        (Installed on{" "}
                        <span className="text-green-600">
                          {installationTarget}
                        </span>
                        )
                      </span>
                    </>
                  ) : null}
                </p>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 pb-8 pt-3 sm:px-6">
        <div className="mx-auto flex max-w-[900px] flex-col gap-4">
          {hasError ? (
            <div className="zero-card px-6 py-10 text-center text-sm text-destructive">
              Couldn&apos;t load GitHub settings.
            </div>
          ) : loading ? (
            <GithubSettingsSkeleton />
          ) : !isInstalled ? (
            <GithubNotInstalled />
          ) : (
            <>
              <GithubLabelListenersCard
                agents={agents}
                agentsLoading={agentsLoading}
                listeners={listeners}
              />
              <GithubConnectionCard data={installedData} />
              <GithubDangerZoneCard data={installedData} />
            </>
          )}
        </div>
      </main>
    </div>
  );
}
