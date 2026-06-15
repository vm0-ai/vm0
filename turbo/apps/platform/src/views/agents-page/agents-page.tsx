import type { ReactNode } from "react";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { IconLoader2, IconLock, IconPlus, IconWand } from "@tabler/icons-react";
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
import {
  orgMembers$,
  type OrgMember,
} from "../../signals/external/org-members.ts";
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
  const defaultAgentName = useLastResolved(defaultAgentName$);

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
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-3 pb-8">
        <div className="mx-auto max-w-[900px] flex flex-col gap-4">
          <AgentSplitView
            atPublicLimit={atPublicLimit}
            publicRemaining={publicRemaining}
            onCreate={openCreateDialog}
          />
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
      />
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
  const membersLoadable = useLoadable(orgMembers$);
  const loading = agentsLoadable.state === "loading";
  const agents =
    agentsLoadable.state === "hasData" ? agentsLoadable.data : null;
  const members =
    membersLoadable.state === "hasData" ? membersLoadable.data : [];
  const membersById = new Map(
    members.map((member) => {
      return [member.userId, member];
    }),
  );
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
        membersById={membersById}
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
        membersById={membersById}
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
  membersById,
  skeleton,
  headerAction,
}: {
  title: string;
  agents: AgentProps["agent"][];
  membersById: ReadonlyMap<string, OrgMember>;
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
        <AgentSplitBody agents={agents} membersById={membersById} />
      ) : null}
    </section>
  );
}

function AgentSplitBody({
  agents,
  membersById,
}: {
  agents: AgentProps["agent"][];
  membersById: ReadonlyMap<string, OrgMember>;
}) {
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
            <AgentCard
              agent={agent}
              creator={agentCreator(agent, membersById)}
            />
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  newName: string;
  onNameChange: (name: string) => void;
  onConfirm: (avatarUrl: string) => void;
  creating: boolean;
  visibility: "public" | "private";
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
}: {
  newName: string;
  onNameChange: (name: string) => void;
  onConfirm: (avatarUrl: string) => void;
  onCancel: () => void;
  creating: boolean;
  visibility: "public" | "private";
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
            Create a new {visibility} agent
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

type AgentProps = {
  agent: {
    id: string;
    ownerId?: string;
    displayName?: string | null;
    description?: string | null;
    visibility?: "public" | "private" | null;
  };
  creator: AgentCreator;
};

interface AgentCreator {
  readonly name: string;
  readonly imageUrl: string | null;
}

function orgMemberDisplayName(member: OrgMember): string {
  const fullName = [member.firstName, member.lastName]
    .filter((part): part is string => {
      return Boolean(part);
    })
    .join(" ");
  return fullName || member.email || member.userId;
}

function agentCreator(
  agent: AgentProps["agent"],
  membersById: ReadonlyMap<string, OrgMember>,
): AgentCreator {
  if (!agent.ownerId) {
    return { name: "Unknown", imageUrl: null };
  }

  const member = membersById.get(agent.ownerId);
  return member
    ? { name: orgMemberDisplayName(member), imageUrl: member.imageUrl }
    : { name: agent.ownerId, imageUrl: null };
}

function CreatorAvatar({ creator }: { creator: AgentCreator }) {
  if (creator.imageUrl) {
    return (
      <img
        src={creator.imageUrl}
        alt=""
        aria-hidden="true"
        className="h-full w-full rounded-full object-cover"
      />
    );
  }

  return (
    <span className="flex h-full w-full items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
      {creator.name.charAt(0).toUpperCase()}
    </span>
  );
}

function CreatorBadge({ creator }: { creator: AgentCreator }) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="img"
            aria-label={`Created by ${creator.name}`}
            className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full border border-background bg-background shadow-sm"
          >
            <CreatorAvatar creator={creator} />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" align="end">
          <p className="text-xs">Created by {creator.name}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function AgentCard({ agent, creator }: AgentProps) {
  const defaultAgentId = useLastResolved(defaultAgentId$);
  const lead = agent.id === defaultAgentId;
  const displayName = agent.displayName ?? agent.id;
  const isPrivate = agent.visibility === "private";
  const description = defaultAgentId
    ? agent.description || (lead ? "Your core agent" : "Sub-agent")
    : "";
  return (
    <Card className="zero-card relative cursor-pointer flex flex-col hover:bg-muted/30 transition-colors h-full">
      {!isPrivate && <CreatorBadge creator={creator} />}
      <CardContent
        className={
          isPrivate
            ? "px-5 py-4 flex items-center gap-3"
            : "pl-5 pr-12 py-4 flex items-center gap-3"
        }
      >
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
