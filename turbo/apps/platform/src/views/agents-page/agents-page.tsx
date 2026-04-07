import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  IconLayoutGrid,
  IconList,
  IconLoader2,
  IconPlus,
  IconTrash,
  IconUpload,
} from "@tabler/icons-react";
import {
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Button,
  Input,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@vm0/ui";
import { createSubagent$ } from "../../signals/zero-page/zero-agents.ts";
import {
  defaultAgentId$,
  defaultAgentName$,
  sortedAgents$,
} from "../../signals/agent.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { useAgentAvatar } from "../zero-page/zero-sidebar.tsx";
import { ZERO_AVATARS } from "../zero-page/zero-avatars.ts";
import {
  AVATAR_PRESET_PREFIX,
  resolveAvatarUrl,
} from "../zero-page/avatar-utils.ts";
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
  jobsViewMode$,
  setJobsViewMode$,
} from "../../signals/zero-page/zero-jobs-page.ts";

export function AgentsPage() {
  const dialogOpen = useGet(jobsDialogOpen$);
  const setDialogOpen = useSet(setJobsDialogOpen$);
  const newName = useGet(jobsNewName$);
  const setNewName = useSet(setJobsNewName$);
  const [createLoadable, createSubagentFn] = useLoadableSet(createSubagent$);
  const creating = createLoadable.state === "loading";
  const resetDialog = useSet(resetJobsDialog$);
  const pageSignal = useGet(pageSignal$);
  const viewMode = useGet(jobsViewMode$);
  const setViewMode = useSet(setJobsViewMode$);
  const defaultAgentName = useLastResolved(defaultAgentName$);

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
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-3 md:pt-10 pb-0 md:pb-3">
        <div className="mx-auto max-w-[900px] flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0 hidden md:block">
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              Agents
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {defaultAgentName} and sub-agents working together to run tailored
              workflows for you and your team.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="outline"
              size="sm"
              className="zero-btn-morandi h-9 gap-2 shrink-0 rounded-lg border"
              onClick={() => {
                return setDialogOpen(true);
              }}
            >
              <IconPlus size={14} stroke={2} />
              New agent
            </Button>

            <Tabs
              value={viewMode}
              onValueChange={(v) => {
                return setViewMode(v as "grid" | "list");
              }}
              className="shrink-0"
            >
              <TabsList className="zero-tabs h-9 gap-1 px-1 py-1">
                <TabsTrigger
                  value="grid"
                  className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
                >
                  <IconLayoutGrid size={14} stroke={1.5} />
                  Grid
                </TabsTrigger>
                <TabsTrigger
                  value="list"
                  className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
                >
                  <IconList size={14} stroke={1.5} />
                  List
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-3 pb-8">
        <div className="mx-auto max-w-[900px] flex flex-col gap-4">
          {viewMode === "grid" ? <AgentGridView /> : <AgentListView />}
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

function AgentGridView() {
  const agentsLoadable = useLoadable(sortedAgents$);
  const loading = agentsLoadable.state === "loading";
  const agents =
    agentsLoadable.state === "hasData" ? agentsLoadable.data : null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {loading &&
        (!agents || agents.length === 0) &&
        [1, 2, 3].map((i) => {
          return (
            <Card key={i} className="zero-card">
              <CardContent className="p-4">
                <div className="flex items-center gap-3 animate-pulse">
                  <div className="h-10 w-10 rounded-full bg-muted" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="h-4 w-24 rounded bg-muted" />
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}

      {agents?.map((agent) => {
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
  );
}

function AgentListView() {
  const agentsLoadable = useLoadable(sortedAgents$);
  const loading = agentsLoadable.state === "loading";
  const agents =
    agentsLoadable.state === "hasData" ? agentsLoadable.data : null;

  return (
    <div className="zero-card overflow-hidden">
      {loading &&
        (!agents || agents.length === 0) &&
        [1, 2, 3].map((i, _, arr) => {
          return (
            <div key={i}>
              <div className="flex items-center gap-3 px-5 py-4 animate-pulse">
                <div className="h-10 w-10 rounded-full bg-muted" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="h-4 w-24 rounded bg-muted" />
                  <div className="h-3 w-40 rounded bg-muted" />
                </div>
              </div>
              {i < arr.length && (
                <div className="mx-5 border-b border-border/50" />
              )}
            </div>
          );
        })}

      {agents?.map((agent, idx) => {
        return (
          <Link
            key={agent.id}
            pathname="/agents/:id"
            options={{ pathParams: { id: agent.id } }}
            className="block no-underline text-inherit"
          >
            <AgentListRow agent={agent} isLast={idx === agents.length - 1} />
          </Link>
        );
      })}
    </div>
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
    <DialogContent className="sm:max-w-[420px]">
      <DialogHeader className="flex flex-col items-center text-center pt-4">
        <div className="relative group mb-2">
          <img
            src={displaySrc}
            alt="New agent"
            className="h-14 w-14 rounded-full object-cover object-top"
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
          Create a new agent
        </DialogTitle>
        <DialogDescription className="text-sm text-muted-foreground">
          Name your agent to get started.
        </DialogDescription>
      </DialogHeader>

      <div className="py-2">
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
          autoFocus
          disabled={creating}
        />
      </div>

      <div className="flex justify-end gap-2 pt-2">
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
    </DialogContent>
  );
}

type AgentProps = {
  agent: {
    id: string;
    displayName?: string | null;
    description?: string | null;
  };
};

function AgentCard({ agent }: AgentProps) {
  const defaultAgentId = useLastResolved(defaultAgentId$);
  const lead = agent.id === defaultAgentId;
  const avatarSrc = useAgentAvatar(agent.id);
  const displayName = agent.displayName ?? agent.id;
  const description = defaultAgentId
    ? agent.description || (lead ? "Your core agent" : "Sub-agent")
    : "";
  return (
    <Card className="zero-card cursor-pointer flex flex-col hover:bg-muted/30 transition-colors h-full">
      <CardContent className="px-5 py-4 flex items-center gap-3">
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
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium text-foreground truncate block">
            {displayName}
          </span>
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
            {description}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function AgentListRow({ agent, isLast }: AgentProps & { isLast?: boolean }) {
  const defaultAgentId = useLastResolved(defaultAgentId$);
  const lead = agent.id === defaultAgentId;

  const avatarSrc = useAgentAvatar(agent.id);
  const displayName = agent.displayName ?? agent.id;
  const description = defaultAgentId
    ? agent.description || (lead ? "Your core agent" : "Sub-agent")
    : "";

  return (
    <>
      <div className="flex items-center gap-3 px-5 py-4 w-full text-left transition-colors hover:bg-muted/30 cursor-pointer">
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
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium text-foreground truncate block">
            {displayName}
          </span>
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
            {description}
          </p>
        </div>
      </div>
      {!isLast && <div className="mx-5 border-b border-border/50" />}
    </>
  );
}
