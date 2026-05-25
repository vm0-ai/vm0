import type { ReactNode } from "react";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { createSubagent$ } from "../../signals/zero-page/zero-agents.ts";
import {
  defaultAgentId$,
  defaultAgentName$,
  sortedAgents$,
} from "../../signals/agent.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
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

const MAX_PUBLIC_AGENTS = 7;

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
  const features = useLastResolved(featureSwitch$);
  const splitSections =
    features?.[FeatureSwitchKey.AgentsPageSplitSections] ?? false;

  const agentsLoadable = useLoadable(sortedAgents$);
  const publicAgentCount =
    agentsLoadable.state === "hasData"
      ? agentsLoadable.data.filter((agent) => {
          return agent.visibility !== "private";
        }).length
      : 0;
  const atPublicLimit = publicAgentCount >= MAX_PUBLIC_AGENTS;
  const publicRemaining = Math.max(0, MAX_PUBLIC_AGENTS - publicAgentCount);

  const openCreateDialog = (target: "public" | "private") => {
    setVisibility(target);
    setDialogOpen(true);
  };

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
            {!splitSections && (
              <Button
                variant="outline"
                size="sm"
                className="zero-btn-morandi h-9 gap-2 shrink-0 rounded-lg border"
                onClick={() => {
                  return openCreateDialog("private");
                }}
              >
                <IconPlus size={14} stroke={2} />
                New agent
              </Button>
            )}

            {!splitSections && (
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
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-3 pb-8">
        <div className="mx-auto max-w-[900px] flex flex-col gap-4">
          {splitSections ? (
            <AgentSplitView
              atPublicLimit={atPublicLimit}
              publicRemaining={publicRemaining}
              onCreate={openCreateDialog}
            />
          ) : viewMode === "grid" ? (
            <AgentGridView />
          ) : (
            <AgentListView />
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
        visibility={visibility}
        onVisibilityChange={setVisibility}
        publicDisabled={atPublicLimit}
        splitSections={splitSections}
      />
    </div>
  );
}

function AgentGridView() {
  const agentsLoadable = useLoadable(sortedAgents$);
  const loading = agentsLoadable.state === "loading";
  const agents =
    agentsLoadable.state === "hasData" ? agentsLoadable.data : null;

  if (loading && (!agents || agents.length === 0)) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {[1, 2, 3].map((i) => {
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
      </div>
    );
  }

  const teamAgents =
    agents?.filter((a) => {
      return a.visibility !== "private";
    }) ?? [];
  const privateAgents =
    agents?.filter((a) => {
      return a.visibility === "private";
    }) ?? [];

  return (
    <div className="flex flex-col gap-6">
      {teamAgents.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-muted-foreground">Team</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {teamAgents.map((agent) => {
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
        </section>
      )}
      {privateAgents.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-muted-foreground">Private</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {privateAgents.map((agent) => {
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
        </section>
      )}
    </div>
  );
}

function AgentListView() {
  const agentsLoadable = useLoadable(sortedAgents$);
  const loading = agentsLoadable.state === "loading";
  const agents =
    agentsLoadable.state === "hasData" ? agentsLoadable.data : null;

  if (loading && (!agents || agents.length === 0)) {
    return (
      <div className="zero-card overflow-hidden">
        {[1, 2, 3].map((i, _, arr) => {
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
      </div>
    );
  }

  const teamAgents =
    agents?.filter((a) => {
      return a.visibility !== "private";
    }) ?? [];
  const privateAgents =
    agents?.filter((a) => {
      return a.visibility === "private";
    }) ?? [];

  return (
    <div className="flex flex-col gap-6">
      {teamAgents.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-muted-foreground">Team</h2>
          <div className="zero-card overflow-hidden">
            {teamAgents.map((agent, idx) => {
              return (
                <Link
                  key={agent.id}
                  pathname="/agents/:agentId"
                  options={{ pathParams: { agentId: agent.id } }}
                  className="block no-underline text-inherit"
                >
                  <AgentListRow
                    agent={agent}
                    isLast={idx === teamAgents.length - 1}
                  />
                </Link>
              );
            })}
          </div>
        </section>
      )}
      {privateAgents.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-muted-foreground">Private</h2>
          <div className="zero-card overflow-hidden">
            {privateAgents.map((agent, idx) => {
              return (
                <Link
                  key={agent.id}
                  pathname="/agents/:agentId"
                  options={{ pathParams: { agentId: agent.id } }}
                  className="block no-underline text-inherit"
                >
                  <AgentListRow
                    agent={agent}
                    isLast={idx === privateAgents.length - 1}
                  />
                </Link>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function AgentSplitView({
  atPublicLimit,
  publicRemaining,
  onCreate,
}: {
  atPublicLimit: boolean;
  publicRemaining: number;
  onCreate: (visibility: "public" | "private") => void;
}) {
  const agentsLoadable = useLoadable(sortedAgents$);
  const loading = agentsLoadable.state === "loading";
  const agents =
    agentsLoadable.state === "hasData" ? agentsLoadable.data : null;
  const skeleton = loading && !agents;

  const publicAgents =
    agents?.filter((a) => {
      return a.visibility !== "private";
    }) ?? [];
  const privateAgents =
    agents?.filter((a) => {
      return a.visibility === "private";
    }) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <AgentSplitSection
        title="Public"
        agents={publicAgents}
        skeleton={skeleton}
        headerAction={
          <div className="flex items-center gap-3">
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-xs text-muted-foreground cursor-default">
                    {publicRemaining} remains
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p className="text-xs">
                    max {MAX_PUBLIC_AGENTS} public agent for workspace
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <Button
              variant="outline"
              size="sm"
              className="zero-btn-morandi h-8 gap-2 rounded-lg border"
              disabled={atPublicLimit}
              onClick={() => {
                return onCreate("public");
              }}
            >
              <IconPlus size={14} stroke={2} />
              Create
            </Button>
          </div>
        }
      />
      <AgentSplitSection
        title="Private"
        agents={privateAgents}
        skeleton={skeleton}
        headerAction={
          <Button
            variant="outline"
            size="sm"
            className="zero-btn-morandi h-8 gap-2 rounded-lg border"
            onClick={() => {
              return onCreate("private");
            }}
          >
            <IconPlus size={14} stroke={2} />
            Create
          </Button>
        }
      />
    </div>
  );
}

function AgentSplitSection({
  title,
  agents,
  skeleton,
  headerAction,
}: {
  title: string;
  agents: AgentProps["agent"][];
  skeleton: boolean;
  headerAction: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {headerAction}
      </header>
      {skeleton ? (
        <AgentSplitSkeleton />
      ) : agents.length > 0 ? (
        <AgentSplitBody agents={agents} />
      ) : null}
    </section>
  );
}

function AgentSplitBody({ agents }: { agents: AgentProps["agent"][] }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {agents.map((agent) => {
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

function AgentSplitSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {[1, 2, 3].map((i) => {
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
  publicDisabled,
  splitSections,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  newName: string;
  onNameChange: (name: string) => void;
  onConfirm: (avatarUrl: string) => void;
  creating: boolean;
  visibility: "public" | "private";
  onVisibilityChange: (visibility: "public" | "private") => void;
  publicDisabled: boolean;
  splitSections: boolean;
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
          publicDisabled={publicDisabled}
          splitSections={splitSections}
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
  publicDisabled,
  splitSections,
}: {
  newName: string;
  onNameChange: (name: string) => void;
  onConfirm: (avatarUrl: string) => void;
  onCancel: () => void;
  creating: boolean;
  visibility: "public" | "private";
  onVisibilityChange: (visibility: "public" | "private") => void;
  publicDisabled: boolean;
  splitSections: boolean;
}) {
  const avatarUrl = useGet(jobsAvatarUrl$);
  const setAvatarUrl = useSet(setJobsAvatarUrl$);

  return (
    <DialogContent className="sm:max-w-[480px] p-0 gap-0 overflow-hidden">
      <DialogHeader className="sr-only">
        <DialogTitle>Create a new agent</DialogTitle>
        <DialogDescription>
          Name the new agent, choose its visibility, and customize its avatar.
        </DialogDescription>
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
          <p className="text-base font-semibold">
            {splitSections
              ? `Create a new ${visibility} agent`
              : "Create a new agent"}
          </p>
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
        {!splitSections && (
          <CreateAgentVisibilitySelect
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

function CreateAgentVisibilitySelect({
  visibility,
  onVisibilityChange,
  publicDisabled,
}: {
  visibility: "public" | "private";
  onVisibilityChange: (visibility: "public" | "private") => void;
  publicDisabled: boolean;
}) {
  return (
    <div className="flex w-full flex-col gap-1.5">
      <label className="text-sm font-medium text-foreground">Create as</label>
      <Select
        value={visibility}
        onValueChange={(value) => {
          onVisibilityChange(value as "public" | "private");
        }}
      >
        <TooltipProvider delayDuration={200}>
          <Tooltip open={publicDisabled ? undefined : false}>
            <TooltipTrigger asChild>
              <SelectTrigger aria-label="Create as" className="w-full">
                <SelectValue />
              </SelectTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p className="text-xs">Public agent limit reached.</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <SelectContent>
          <SelectItem value="private">Private</SelectItem>
          <SelectItem value="public" disabled={publicDisabled}>
            {publicDisabled ? "Public (limit reached)" : "Public"}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

type AgentProps = {
  agent: {
    id: string;
    displayName?: string | null;
    description?: string | null;
    visibility?: "public" | "private" | null;
  };
};

function AgentCard({ agent }: AgentProps) {
  const defaultAgentId = useLastResolved(defaultAgentId$);
  const lead = agent.id === defaultAgentId;
  const displayName = agent.displayName ?? agent.id;
  const isPrivate = agent.visibility === "private";
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
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-sm font-medium text-foreground truncate">
              {displayName}
            </span>
            {isPrivate && (
              <IconLock
                size={12}
                stroke={1.5}
                className="shrink-0 text-muted-foreground"
                aria-label="Private agent"
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
  const isPrivate = agent.visibility === "private";
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
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-sm font-medium text-foreground truncate">
              {displayName}
            </span>
            {isPrivate && (
              <IconLock
                size={12}
                stroke={1.5}
                className="shrink-0 text-muted-foreground"
                aria-label="Private agent"
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
