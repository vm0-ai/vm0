import type { FormEvent } from "react";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconCircleCheck,
  IconDotsVertical,
  IconLoader2,
  IconPlus,
  IconSettings,
  IconTrash,
} from "@tabler/icons-react";
import { Button } from "@vm0/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { Input } from "@vm0/ui/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui/components/ui/select";
import { sortedAgents$ } from "../../signals/agent.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  connectGithubInstallation$,
  createGithubLabelListener$,
  deleteGithubLabelListener$,
  disconnectGithubInstallation$,
  githubIntegrationData$,
  githubLabelListenerForm$,
  githubManageDialogOpen$,
  resetGithubLabelListenerForm$,
  setGithubLabelListenerForm$,
  setGithubManageDialogOpen$,
  uninstallGithubInstallation$,
  updateGithubLabelListener$,
  type GithubIntegrationData,
  type GithubLabelListenerForm,
  type GithubLabelTriggerMode,
} from "../../signals/zero-page/zero-github.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { LoadingSwitch } from "../components/loading-switch.tsx";
import githubIconImg from "./components/settings/icons/github.svg";

type GithubListener = GithubIntegrationData["labelListeners"][number];

interface GithubAgentOption {
  readonly id: string;
  readonly displayName?: string | null;
}

function getTriggerModeLabel(mode: GithubLabelTriggerMode): string {
  if (mode === "created_by_me") {
    return "Only issues/PRs I create";
  }
  return "Any issue/PR with this label";
}

function openFreshOAuth(url: string) {
  const fresh = new URL(url, window.location.origin);
  fresh.searchParams.set("_t", String(Date.now()));
  window.open(fresh.toString(), "_blank");
}

function GithubListenerList({
  listeners,
}: {
  readonly listeners: readonly GithubListener[];
}) {
  const pageSignal = useGet(pageSignal$);
  const [deleteLoadable, deleteListener] = useLoadableSet(
    deleteGithubLabelListener$,
  );
  const [updateLoadable, updateListener] = useLoadableSet(
    updateGithubLabelListener$,
  );
  const deleting = deleteLoadable.state === "loading";
  const updating = updateLoadable.state === "loading";

  if (listeners.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
        No label listeners configured.
      </div>
    );
  }

  return (
    <div className="divide-y rounded-lg border border-border">
      {listeners.map((listener) => {
        return (
          <div
            key={listener.id}
            className="flex items-center gap-3 px-3 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">
                  {listener.labelName}
                </span>
                {!listener.enabled ? (
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    Disabled
                  </span>
                ) : null}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {listener.agent?.name ?? "Unknown agent"} ·{" "}
                {getTriggerModeLabel(listener.triggerMode)}
              </div>
            </div>
            <LoadingSwitch
              checked={listener.enabled}
              loading={updating}
              size="sm"
              ariaLabel={`Toggle ${listener.labelName} listener`}
              onCheckedChange={(enabled) => {
                detach(
                  updateListener(
                    { listenerId: listener.id, body: { enabled } },
                    pageSignal,
                  ),
                  Reason.DomCallback,
                );
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              disabled={deleting || updating}
              aria-label={`Delete ${listener.labelName}`}
              onClick={() => {
                detach(
                  deleteListener(listener.id, pageSignal),
                  Reason.DomCallback,
                );
              }}
            >
              {deleting ? (
                <IconLoader2 size={15} className="animate-spin" />
              ) : (
                <IconTrash size={15} />
              )}
            </Button>
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
    <div className="grid gap-2 sm:grid-cols-[1fr_1fr]">
      <label className="grid gap-1.5 text-sm font-medium text-foreground">
        Label
        <Input
          value={form.labelName}
          placeholder="ready-for-zero"
          disabled={creating}
          onChange={(event) => {
            setForm({ labelName: event.target.value });
          }}
        />
      </label>
      <label className="grid gap-1.5 text-sm font-medium text-foreground">
        Agent
        <Select
          value={selectedAgentId}
          disabled={creating || agents.length === 0}
          onValueChange={(agentId) => {
            setForm({ agentId });
          }}
        >
          <SelectTrigger className="h-9">
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
    <label className="grid gap-1.5 text-sm font-medium text-foreground">
      Trigger mode
      <Select
        value={triggerMode}
        disabled={creating}
        onValueChange={(value) => {
          setForm({ triggerMode: value as GithubLabelTriggerMode });
        }}
      >
        <SelectTrigger className="h-9">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="created_by_me">
            {getTriggerModeLabel("created_by_me")}
          </SelectItem>
          <SelectItem value="anyone">
            {getTriggerModeLabel("anyone")}
          </SelectItem>
        </SelectContent>
      </Select>
    </label>
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
    <label className="grid gap-1.5 text-sm font-medium text-foreground">
      Prompt
      <textarea
        value={prompt}
        disabled={creating}
        rows={4}
        className="min-h-24 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        placeholder="Review the labeled issue or PR and take the next appropriate action."
        onChange={(event) => {
          setForm({ prompt: event.target.value });
        }}
      />
    </label>
  );
}

function GithubListenerForm({
  agents,
  onClose,
}: {
  readonly agents: readonly GithubAgentOption[];
  readonly onClose: () => void;
}) {
  const form = useGet(githubLabelListenerForm$);
  const setForm = useSet(setGithubLabelListenerForm$);
  const resetForm = useSet(resetGithubLabelListenerForm$);
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createListener] = useLoadableSet(
    createGithubLabelListener$,
  );
  const creating = createLoadable.state === "loading";
  const selectedAgentId = form.agentId || agents[0]?.id || "";
  const canCreate = Boolean(
    form.labelName.trim() && form.prompt.trim() && selectedAgentId,
  );

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const labelName = form.labelName.trim();
    const prompt = form.prompt.trim();
    if (!labelName || !prompt || !selectedAgentId || creating) {
      return;
    }

    detach(
      (async () => {
        await createListener(
          {
            labelName,
            agentId: selectedAgentId,
            triggerMode: form.triggerMode,
            prompt,
          },
          pageSignal,
        );
        resetForm();
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <form className="grid gap-3" onSubmit={submit}>
      <GithubListenerPrimaryFields
        agents={agents}
        creating={creating}
        form={form}
        selectedAgentId={selectedAgentId}
        setForm={setForm}
      />
      <GithubTriggerModeField
        creating={creating}
        triggerMode={form.triggerMode}
        setForm={setForm}
      />
      <GithubPromptField
        creating={creating}
        prompt={form.prompt}
        setForm={setForm}
      />
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={creating}
          onClick={onClose}
        >
          Close
        </Button>
        <Button type="submit" disabled={!canCreate || creating}>
          {creating ? (
            <IconLoader2 size={14} className="animate-spin" />
          ) : (
            <IconPlus size={14} />
          )}
          Add listener
        </Button>
      </DialogFooter>
    </form>
  );
}

function GithubListenerDialog() {
  const open = useGet(githubManageDialogOpen$);
  const setOpen = useSet(setGithubManageDialogOpen$);
  const data = useLastResolved(githubIntegrationData$);
  const agents = useLastResolved(sortedAgents$) ?? [];
  const listeners = data?.labelListeners ?? [];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>GitHub label listeners</DialogTitle>
          <DialogDescription>
            Configure labels that start an agent run from GitHub issues and pull
            requests.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <GithubListenerList listeners={listeners} />
          <GithubListenerForm
            agents={agents}
            onClose={() => {
              setOpen(false);
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function GithubConnectedBadge({ connected }: { readonly connected: boolean }) {
  if (!connected) {
    return null;
  }

  return (
    <span
      data-testid="github-connected-indicator"
      className="inline-flex min-w-0 max-w-52 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground"
    >
      <IconCircleCheck className="h-3 w-3 text-green-600" />
      <span className="min-w-0 truncate">Connected</span>
    </span>
  );
}

function GithubOptionsPopover({
  canUninstall,
  disconnecting,
  isConnected,
  uninstalling,
  onDisconnect,
  onUninstall,
}: {
  readonly canUninstall: boolean;
  readonly disconnecting: boolean;
  readonly isConnected: boolean;
  readonly uninstalling: boolean;
  readonly onDisconnect: () => void;
  readonly onUninstall: () => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          aria-label="GitHub options"
        >
          <IconDotsVertical size={16} stroke={1.5} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-44 flex-col gap-0.5 p-2">
        {isConnected ? (
          <button
            type="button"
            disabled={disconnecting}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
            onClick={onDisconnect}
          >
            {disconnecting ? "Disconnecting..." : "Disconnect"}
          </button>
        ) : null}
        {canUninstall ? (
          <button
            type="button"
            disabled={uninstalling}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-destructive transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
            onClick={onUninstall}
          >
            {uninstalling ? "Uninstalling..." : "Uninstall"}
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function GithubCardActions({
  data,
}: {
  readonly data: GithubIntegrationData | null;
}) {
  const pageSignal = useGet(pageSignal$);
  const setManageOpen = useSet(setGithubManageDialogOpen$);
  const [connectLoadable, connect] = useLoadableSet(connectGithubInstallation$);
  const [disconnectLoadable, disconnect] = useLoadableSet(
    disconnectGithubInstallation$,
  );
  const [uninstallLoadable, uninstall] = useLoadableSet(
    uninstallGithubInstallation$,
  );
  const connecting = connectLoadable.state === "loading";
  const disconnecting = disconnectLoadable.state === "loading";
  const uninstalling = uninstallLoadable.state === "loading";
  const busy = connecting || disconnecting || uninstalling;
  const isInstalled = data?.isInstalled ?? false;
  const isConnected = data?.isConnected ?? false;
  const installUrl = isInstalled ? null : data?.installUrl;
  const canUninstall = Boolean(data?.isInstalled && data.installation.isAdmin);

  if (installUrl) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 shrink-0 gap-1.5 rounded-lg"
        disabled={busy}
        onClick={() => {
          openFreshOAuth(installUrl);
        }}
      >
        Install GitHub
      </Button>
    );
  }

  if (!isInstalled) {
    return null;
  }

  return (
    <>
      {!isConnected ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 rounded-lg"
          disabled={busy}
          onClick={() => {
            detach(connect(pageSignal), Reason.DomCallback);
          }}
        >
          {connecting ? "Connecting..." : "Connect"}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 shrink-0 gap-1.5 rounded-lg"
        onClick={() => {
          setManageOpen(true);
        }}
      >
        <IconSettings size={14} stroke={1.5} />
        Manage
      </Button>
      <GithubOptionsPopover
        canUninstall={canUninstall}
        disconnecting={disconnecting}
        isConnected={isConnected}
        uninstalling={uninstalling}
        onDisconnect={() => {
          detach(disconnect(pageSignal), Reason.DomCallback);
        }}
        onUninstall={() => {
          detach(uninstall(pageSignal), Reason.DomCallback);
        }}
      />
    </>
  );
}

export function GithubCard() {
  const dataLoadable = useLastLoadable(githubIntegrationData$);
  const data = dataLoadable.state === "hasData" ? dataLoadable.data : null;
  const isInstalled = data?.isInstalled ?? false;
  const listenerCount = data?.labelListeners.length ?? 0;
  const summary = isInstalled
    ? `${listenerCount} label ${listenerCount === 1 ? "listener" : "listeners"}`
    : "Run agents from GitHub issue and PR labels";

  return (
    <>
      <div className="zero-card flex flex-col">
        <div className="flex items-center gap-4 p-4">
          <div className="shrink-0 inline-flex h-7 w-7 items-center justify-center overflow-hidden">
            <img src={githubIconImg} alt="" className="h-7 w-7" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="text-sm font-medium text-foreground">GitHub</div>
            <div className="truncate text-sm text-muted-foreground">
              {summary}
            </div>
          </div>
          <GithubConnectedBadge connected={data?.isConnected ?? false} />
          <GithubCardActions data={data} />
        </div>
      </div>

      <GithubListenerDialog />
    </>
  );
}
