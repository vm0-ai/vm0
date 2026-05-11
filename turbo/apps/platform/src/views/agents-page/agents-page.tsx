import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  IconLayoutGrid,
  IconList,
  IconLoader2,
  IconLock,
  IconPlus,
  IconWand,
} from "@tabler/icons-react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Button,
  Input,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import { createSubagent$ } from "../../signals/zero-page/zero-agents.ts";
import {
  defaultAgentId$,
  defaultAgentName$,
  sortedAgents$,
} from "../../signals/agent.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import { onDomEventFn } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import {
  AgentAvatarImg,
  AvatarFromUrl,
} from "../zero-page/zero-sidebar-shared.tsx";
import {
  jobsDialogOpen$,
  setJobsDialogOpen$,
  jobsNewName$,
  setJobsNewName$,
  jobsAvatarUrl$,
  setJobsAvatarUrl$,
  jobsVisibility$,
  setJobsVisibility$,
  resetJobsDialog$,
  jobsViewMode$,
  setJobsViewMode$,
} from "../../signals/zero-page/zero-jobs-page.ts";
import { serializeAvatarSvgConfig } from "../zero-page/avatar-svg-utils.ts";
import { AvatarMaker } from "../zero-page/avatar-maker.tsx";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";

export function AgentsPage() {
  const dialogOpen = useGet(jobsDialogOpen$);
  const setDialogOpen = useSet(setJobsDialogOpen$);
  const newName = useGet(jobsNewName$);
  const setNewName = useSet(setJobsNewName$);
  const visibility = useGet(jobsVisibility$);
  const setVisibility = useSet(setJobsVisibility$);
  const [createLoadable, createSubagentFn] = useLoadableSet(createSubagent$);
  const creating = createLoadable.state === "loading";
  const resetDialog = useSet(resetJobsDialog$);
  const pageSignal = useGet(pageSignal$);
  const viewMode = useGet(jobsViewMode$);
  const setViewMode = useSet(setJobsViewMode$);
  const defaultAgentName = useLastResolved(defaultAgentName$);

  const agentsLoadable = useLoadable(sortedAgents$);
  const features = useLastResolved(featureSwitch$);
  const privateAgentsEnabled =
    features?.[FeatureSwitchKey.PrivateAgents] ?? false;
  const publicAgentCount =
    agentsLoadable.state === "hasData"
      ? agentsLoadable.data.filter((agent) => {
          return agent.visibility !== "private";
        }).length
      : 0;
  const atPublicLimit = publicAgentCount >= 7;
  const createDisabled = atPublicLimit && !privateAgentsEnabled;

  const handleCreateTeammate = onDomEventFn(async (avatarUrl: string) => {
    const trimmed = newName.trim();
    if (!trimmed || creating) {
      return;
    }
    await createSubagentFn(trimmed, avatarUrl, visibility, pageSignal);
    setDialogOpen(false);
    resetDialog();
    toast.success(`${trimmed} created successfully`);
  });

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
            <TooltipProvider delayDuration={200}>
              <Tooltip open={createDisabled ? undefined : false}>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button
                      variant="outline"
                      size="sm"
                      className="zero-btn-morandi h-9 gap-2 shrink-0 rounded-lg border"
                      disabled={createDisabled}
                      onClick={() => {
                        setVisibility(
                          privateAgentsEnabled ? "private" : "public",
                        );
                        return setDialogOpen(true);
                      }}
                    >
                      <IconPlus size={14} stroke={2} />
                      New agent
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="text-xs">
                    Agent limit reached (7). Delete an agent to create a new
                    one.
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

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
        visibility={visibility}
        onVisibilityChange={setVisibility}
        showVisibility={privateAgentsEnabled}
        publicDisabled={atPublicLimit}
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
            pathname="/agents/:agentId"
            options={{ pathParams: { agentId: agent.id } }}
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
            pathname="/agents/:agentId"
            options={{ pathParams: { agentId: agent.id } }}
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
  visibility,
  onVisibilityChange,
  showVisibility,
  publicDisabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  newName: string;
  onNameChange: (name: string) => void;
  onConfirm: (avatarUrl: string) => void;
  creating: boolean;
  visibility: "public" | "private";
  onVisibilityChange: (visibility: "public" | "private") => void;
  showVisibility: boolean;
  publicDisabled: boolean;
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
          visibility={visibility}
          onVisibilityChange={onVisibilityChange}
          showVisibility={showVisibility}
          publicDisabled={publicDisabled}
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
  visibility,
  onVisibilityChange,
  showVisibility,
  publicDisabled,
}: {
  newName: string;
  onNameChange: (name: string) => void;
  onConfirm: (avatarUrl: string) => void;
  onCancel: () => void;
  creating: boolean;
  visibility: "public" | "private";
  onVisibilityChange: (visibility: "public" | "private") => void;
  showVisibility: boolean;
  publicDisabled: boolean;
}) {
  const avatarUrl = useGet(jobsAvatarUrl$);
  const setAvatarUrl = useSet(setJobsAvatarUrl$);

  return (
    <DialogContent className="sm:max-w-[480px] p-0 gap-0 overflow-hidden">
      <DialogHeader className="sr-only">
        <DialogTitle>Create a new agent</DialogTitle>
      </DialogHeader>

      {/* Avatar preview */}
      <div className="flex flex-col items-center pt-10 pb-6 bg-muted/30">
        <AvatarMaker
          onConfirm={(cfg) => {
            setAvatarUrl(serializeAvatarSvgConfig(cfg));
            return Promise.resolve();
          }}
          trigger={(openMaker) => {
            return (
              <button
                type="button"
                onClick={openMaker}
                className="relative rounded-full transition-transform duration-200 hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                aria-label="Customize avatar"
              >
                <AvatarFromUrl
                  avatarUrl={avatarUrl}
                  alt="New agent"
                  className="h-16 w-16 rounded-full object-cover object-top"
                />
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="absolute -right-0.5 -bottom-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-background text-muted-foreground shadow-sm border border-border">
                        <IconWand size={10} stroke={1.5} />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <p className="text-xs">Customize avatar</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </button>
            );
          }}
        />
      </div>

      {/* Content */}
      <div className="flex flex-col items-center gap-4 px-6 py-6">
        <div className="text-center">
          <p className="text-base font-semibold">Create a new agent</p>
          <p className="text-sm text-muted-foreground mt-0.5">
            Name your agent to get started.
          </p>
        </div>
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
        {showVisibility && (
          <CreateAgentPublicToggle
            visibility={visibility}
            onVisibilityChange={onVisibilityChange}
            publicDisabled={publicDisabled}
          />
        )}
      </div>

      {/* Footer */}
      <div className="flex justify-center gap-3 px-6 pt-4 pb-8">
        <Button variant="outline" onClick={onCancel} disabled={creating}>
          Cancel
        </Button>
        <Button
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

function CreateAgentPublicToggle({
  visibility,
  onVisibilityChange,
  publicDisabled,
}: {
  visibility: "public" | "private";
  onVisibilityChange: (visibility: "public" | "private") => void;
  publicDisabled: boolean;
}) {
  return (
    <div className="flex w-full items-center justify-between gap-4 rounded-lg bg-muted/40 px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">Make public</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {publicDisabled
            ? "Public agent limit reached."
            : "Visible to everyone in this workspace."}
        </p>
      </div>
      <Switch
        checked={visibility === "public"}
        disabled={publicDisabled}
        onCheckedChange={(checked) => {
          return onVisibilityChange(checked ? "public" : "private");
        }}
        aria-label="Make public"
      />
    </div>
  );
}

type AgentProps = {
  agent: {
    id: string;
    displayName?: string | null;
    description?: string | null;
    visibility?: "public" | "private";
  };
};

function AgentCard({ agent }: AgentProps) {
  const defaultAgentId = useLastResolved(defaultAgentId$);
  const lead = agent.id === defaultAgentId;
  const displayName = agent.displayName ?? agent.id;
  const description = defaultAgentId
    ? agent.description || (lead ? "Your core agent" : "Sub-agent")
    : "";
  return (
    <Card className="zero-card cursor-pointer flex flex-col hover:bg-muted/30 transition-colors h-full">
      <CardContent className="px-5 py-4 flex items-center gap-3">
        <AgentAvatarImg
          name={agent.id}
          alt={displayName}
          className="h-10 w-10 shrink-0 rounded-full object-cover object-top"
        />
        <div className="flex-1 min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="text-sm font-medium text-foreground truncate block">
              {displayName}
            </span>
            {agent.visibility === "private" && (
              <IconLock
                size={12}
                stroke={1.7}
                className="shrink-0 text-muted-foreground"
              />
            )}
          </div>
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

  const displayName = agent.displayName ?? agent.id;
  const description = defaultAgentId
    ? agent.description || (lead ? "Your core agent" : "Sub-agent")
    : "";

  return (
    <>
      <div className="flex items-center gap-3 px-5 py-4 w-full text-left transition-colors hover:bg-muted/30 cursor-pointer">
        <AgentAvatarImg
          name={agent.id}
          alt={displayName}
          className="h-10 w-10 shrink-0 rounded-full object-cover object-top"
        />
        <div className="flex-1 min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="text-sm font-medium text-foreground truncate block">
              {displayName}
            </span>
            {agent.visibility === "private" && (
              <IconLock
                size={12}
                stroke={1.7}
                className="shrink-0 text-muted-foreground"
              />
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
            {description}
          </p>
        </div>
      </div>
      {!isLast && <div className="mx-5 border-b border-border/50" />}
    </>
  );
}
