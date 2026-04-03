import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  IconCrown,
  IconLoader2,
  IconPlus,
  IconTrash,
  IconUpload,
  IconUsers,
} from "@tabler/icons-react";
import {
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Button,
  Input,
} from "@vm0/ui";
import {
  zeroSubagents$,
  createSubagent$,
} from "../../signals/zero-page/zero-agents.ts";
import {
  agentDisplayName$,
  defaultAgentId$,
} from "../../signals/zero-page/zero-agent-name.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { useAgentAvatar } from "./zero-sidebar.tsx";
import { ZERO_AVATARS } from "./zero-avatars.ts";
import { AVATAR_PRESET_PREFIX, resolveAvatarUrl } from "./avatar-utils.ts";
import { fetch$ } from "../../signals/fetch.ts";
import {
  jobsDialogOpen$,
  setJobsDialogOpen$,
  jobsNewName$,
  setJobsNewName$,
  jobsAvatarUrl$,
  resetJobsAvatarUrl$,
  uploadJobsAvatar$,
  jobsFileInputEl$,
  setJobsFileInputEl$,
  resetJobsDialog$,
} from "../../signals/zero-page/zero-jobs-page.ts";

export function ZeroJobsPage() {
  const displayNameLoadable = useLoadable(agentDisplayName$);
  const displayName =
    displayNameLoadable.state === "hasData" ? displayNameLoadable.data : "Zero";
  const rawNameLoadable = useLoadable(defaultAgentId$);
  const rawAgentName =
    rawNameLoadable.state === "hasData" ? rawNameLoadable.data : null;
  const agentsLoadable = useLoadable(zeroSubagents$);
  const agents = useLastResolved(zeroSubagents$);
  const loading = agentsLoadable.state === "loading";
  const error =
    agentsLoadable.state === "hasError"
      ? agentsLoadable.error instanceof Error
        ? agentsLoadable.error.message
        : "Unknown error"
      : null;
  const zeroAvatarSrc = useAgentAvatar(rawAgentName ?? "");
  const dialogOpen = useGet(jobsDialogOpen$);
  const setDialogOpen = useSet(setJobsDialogOpen$);
  const newName = useGet(jobsNewName$);
  const setNewName = useSet(setJobsNewName$);
  const [createLoadable, createSubagentFn] = useLoadableSet(createSubagent$);
  const creating = createLoadable.state === "loading";
  const resetDialog = useSet(resetJobsDialog$);
  const pageSignal = useGet(pageSignal$);

  const handleCreateTeammate = (avatarUrl: string) => {
    const trimmed = newName.trim();
    if (!trimmed || creating) {
      return;
    }
    detach(
      createSubagentFn(trimmed, avatarUrl, pageSignal).then(
        () => {
          setDialogOpen(false);
          resetDialog();
          toast.success(`${trimmed} created successfully`);
        },
        (error: unknown) => {
          toast.error(
            error instanceof Error
              ? error.message
              : "Failed to create sub-agent",
          );
        },
      ),
      Reason.DomCallback,
    );
  };

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="hidden md:block shrink-0 bg-transparent px-4 sm:px-6 pt-10 pb-3">
        <div className="mx-auto max-w-[900px]">
          <h1 className="hidden md:block text-lg font-semibold tracking-tight text-foreground">
            Agents
          </h1>
          <p className="hidden md:block mt-0.5 text-sm text-muted-foreground">
            {displayName} and sub-agents working together to run tailored
            workflows for you and your team.
          </p>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-3 pb-8">
        <div className="mx-auto max-w-[900px] flex flex-col gap-4">
          {/* Zero — full width */}
          {rawAgentName ? (
            <Link
              pathname="/agents/:id"
              options={{ pathParams: { id: rawAgentName } }}
              className="block no-underline text-inherit"
            >
              <Card className="zero-card cursor-pointer hover:bg-muted/30 transition-colors">
                <CardContent className="p-5 flex items-center gap-4">
                  {zeroAvatarSrc ? (
                    <img
                      src={zeroAvatarSrc}
                      alt={displayName}
                      className="h-12 w-12 shrink-0 rounded-full object-cover object-top"
                    />
                  ) : (
                    <div
                      className="h-12 w-12 shrink-0 rounded-full bg-muted"
                      aria-hidden
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h2 className="text-base font-semibold tracking-tight text-foreground truncate">
                        {displayName}
                      </h2>
                      <span className="zero-pill inline-flex items-center gap-1.5 rounded-lg border px-1.5 py-1 text-xs font-medium">
                        <IconCrown
                          size={12}
                          stroke={1.8}
                          className="shrink-0 text-amber-500 dark:text-amber-400"
                        />
                        Lead
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      Your primary AI assistant that manages your team and
                      orchestrates workflows.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ) : (
            <Card className="zero-card">
              <CardContent className="p-5 flex items-center gap-4">
                {zeroAvatarSrc ? (
                  <img
                    src={zeroAvatarSrc}
                    alt={displayName}
                    className="h-12 w-12 shrink-0 rounded-full object-cover object-top"
                  />
                ) : (
                  <div
                    className="h-12 w-12 shrink-0 rounded-full bg-muted"
                    aria-hidden
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-semibold tracking-tight text-foreground truncate">
                      {displayName}
                    </h2>
                    <span className="zero-pill inline-flex items-center gap-1.5 rounded-lg border px-1.5 py-1 text-xs font-medium">
                      <IconCrown
                        size={12}
                        stroke={1.8}
                        className="shrink-0 text-amber-500 dark:text-amber-400"
                      />
                      Lead
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Your primary AI assistant that manages your team and
                    orchestrates workflows.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Sub-agents grid */}
          {loading && (!agents || agents.length === 0) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {[1, 2, 3].map((i) => {
                return (
                  <Card key={i} className="zero-card">
                    <CardContent className="p-5">
                      <div className="flex items-center gap-3 animate-pulse">
                        <div className="h-10 w-10 rounded-full bg-muted" />
                        <div className="min-w-0 flex-1 space-y-2">
                          <div className="h-4 w-24 rounded bg-muted" />
                          <div className="h-3 w-16 rounded bg-muted" />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}

          {error && (
            <Card className="zero-card">
              <CardContent className="px-6 py-6 text-center space-y-3">
                <p className="text-sm text-destructive">{error}</p>
                <Link
                  pathname="/"
                  className="zero-btn-morandi inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium no-underline text-inherit hover:bg-accent"
                >
                  Retry
                </Link>
              </CardContent>
            </Card>
          )}

          {!loading && !error && agents && agents.length === 0 && (
            <CreateTeammateButton
              onClick={() => {
                return setDialogOpen(true);
              }}
            />
          )}

          {agents && agents.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <CreateTeammateButton
                onClick={() => {
                  return setDialogOpen(true);
                }}
              />

              {agents.map((agent) => {
                return (
                  <Link
                    key={agent.id}
                    pathname="/agents/:id"
                    options={{ pathParams: { id: agent.id } }}
                    className="block no-underline text-inherit"
                  >
                    <AgentCard agent={agent} />
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </main>

      <CreateTeammateDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        newName={newName}
        onNameChange={setNewName}
        onConfirm={handleCreateTeammate}
        creating={creating}
      />
    </div>
  );
}

function CreateTeammateButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full h-full flex items-center gap-3 rounded-xl border border-dashed border-[hsl(var(--gray-400))] px-4 py-4 transition-colors hover:bg-muted/30 group cursor-pointer text-left"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
        <IconPlus
          size={18}
          stroke={2}
          className="text-foreground/50 group-hover:text-foreground transition-colors"
        />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground/80 group-hover:text-foreground transition-colors">
          Create teammate
        </p>
        <p className="text-sm text-muted-foreground mt-0.5">
          Add a specialized agent to your team
        </p>
      </div>
    </button>
  );
}

function CreateTeammateDialog({
  open,
  onOpenChange,
  newName,
  onNameChange,
  onConfirm,
  creating,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  newName: string;
  onNameChange: (name: string) => void;
  onConfirm: (avatarUrl: string) => void;
  creating: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={creating ? undefined : onOpenChange}>
      {/* Render content only when open so inner state resets each time */}
      {open && (
        <CreateTeammateDialogContent
          newName={newName}
          onNameChange={onNameChange}
          onConfirm={onConfirm}
          onCancel={() => {
            return onOpenChange(false);
          }}
          creating={creating}
        />
      )}
    </Dialog>
  );
}

function CreateTeammateDialogContent({
  newName,
  onNameChange,
  onConfirm,
  onCancel,
  creating,
}: {
  newName: string;
  onNameChange: (name: string) => void;
  onConfirm: (avatarUrl: string) => void;
  onCancel: () => void;
  creating: boolean;
}) {
  const avatarUrl = useGet(jobsAvatarUrl$);
  const resetAvatarUrl = useSet(resetJobsAvatarUrl$);
  const [uploadLoadable, uploadAvatarFn] = useLoadableSet(uploadJobsAvatar$);
  const uploading = uploadLoadable.state === "loading";
  const fileInputEl = useGet(jobsFileInputEl$);
  const setFileInputEl = useSet(setJobsFileInputEl$);
  const fetchFn = useGet(fetch$);
  const pageSignal = useGet(pageSignal$);

  const handleUpload = (file: File) => {
    detach(
      uploadAvatarFn(file, fetchFn, pageSignal).then(
        undefined,
        (error: unknown) => {
          toast.error(
            error instanceof Error ? error.message : "Failed to upload avatar",
          );
        },
      ),
      Reason.DomCallback,
    );
  };

  const isCustom = !avatarUrl.startsWith(AVATAR_PRESET_PREFIX);
  const displaySrc = resolveAvatarUrl(avatarUrl) ?? ZERO_AVATARS[0];

  return (
    <DialogContent className="sm:max-w-[480px] p-0 gap-0">
      <div className="flex flex-col items-center h-[min(360px,80dvh)]">
        <DialogHeader className="px-6 pt-8 pb-4 flex flex-col items-center text-center">
          <div className="relative group mb-3">
            <img
              src={displaySrc}
              alt="New teammate"
              className="h-16 w-16 rounded-full object-cover object-top"
            />
            <button
              type="button"
              onClick={() => {
                return isCustom ? resetAvatarUrl() : fileInputEl?.click();
              }}
              disabled={uploading}
              className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
              aria-label={isCustom ? "Remove custom avatar" : "Upload avatar"}
            >
              {uploading ? (
                <IconLoader2 size={18} className="text-white animate-spin" />
              ) : isCustom ? (
                <IconTrash size={18} className="text-white" />
              ) : (
                <IconUpload size={18} className="text-white" />
              )}
            </button>
            <input
              ref={setFileInputEl}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  handleUpload(file);
                }
                e.target.value = "";
              }}
            />
          </div>
          <DialogTitle className="text-base font-semibold">
            Create a new teammate
          </DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Name your sub-agent to get started.
          </p>
        </DialogHeader>

        <div className="flex-1 flex items-center justify-center px-6">
          <Input
            value={newName}
            onChange={(e) => {
              return onNameChange(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim() && !creating) {
                onConfirm(avatarUrl);
              }
            }}
            placeholder="e.g. Research Assistant"
            className="max-w-[280px] text-center"
            autoFocus
            disabled={creating}
          />
        </div>

        <div className="px-6 pb-6 pt-4 flex justify-end gap-2 w-full">
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={creating}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => {
              return onConfirm(avatarUrl);
            }}
            disabled={!newName.trim() || creating}
          >
            {creating ? (
              <span className="inline-flex items-center gap-1.5">
                <IconLoader2 size={14} className="animate-spin" />
                Creating...
              </span>
            ) : (
              "Create"
            )}
          </Button>
        </div>
      </div>
    </DialogContent>
  );
}

function AgentCard({
  agent,
}: {
  agent: {
    id: string;
    displayName?: string | null;
    description?: string | null;
  };
}) {
  const avatarSrc = useAgentAvatar(agent.id);
  const displayName = agent.displayName ?? agent.id;
  return (
    <Card className="zero-card cursor-pointer flex flex-col hover:bg-muted/30 transition-colors h-full">
      <CardContent className="p-5 flex flex-col flex-1 gap-3">
        <span className="self-start inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-muted-foreground">
          <IconUsers
            size={12}
            stroke={1.5}
            className="h-3 w-3 shrink-0 text-sky-600 dark:text-sky-400"
          />
          Workspace
        </span>
        <div className="flex items-center gap-2.5">
          {avatarSrc ? (
            <img
              src={avatarSrc}
              alt={displayName}
              className="h-10 w-10 shrink-0 rounded-full object-cover object-top"
            />
          ) : (
            <div
              className="h-10 w-10 shrink-0 rounded-full bg-muted"
              aria-hidden
            />
          )}
          <h2 className="text-base font-semibold tracking-tight text-foreground truncate">
            {displayName}
          </h2>
        </div>
        {agent.description && (
          <p className="text-sm text-muted-foreground line-clamp-2">
            {agent.description}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
