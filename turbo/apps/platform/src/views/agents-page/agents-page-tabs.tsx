import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { IconLoader2, IconWand } from "@tabler/icons-react";
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
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { unreadAgentIds$ } from "../../signals/chat-page/sidebar-unread-threads.ts";
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
  jobsActiveTab$,
  setJobsActiveTab$,
  resetJobsDialog$,
} from "../../signals/zero-page/zero-jobs-page.ts";
import { serializeAvatarSvgConfig } from "../zero-page/avatar-svg-utils.ts";
import { AvatarMaker } from "../zero-page/avatar-maker.tsx";
import emptyPrivateAgents from "./assets/empty-private-agents.png";

const MAX_PUBLIC_AGENTS = 7;

type Visibility = "public" | "private";

export function AgentsPageTabs() {
  const dialogOpen = useGet(jobsDialogOpen$);
  const setDialogOpen = useSet(setJobsDialogOpen$);
  const newName = useGet(jobsNewName$);
  const setNewName = useSet(setJobsNewName$);
  const visibility = useGet(jobsVisibility$);
  const setVisibility = useSet(setJobsVisibility$);
  const activeTab = useGet(jobsActiveTab$);
  const setActiveTab = useSet(setJobsActiveTab$);
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

  const openCreateDialog = (target: Visibility) => {
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
          <AgentTabsView
            activeTab={activeTab}
            onTabChange={setActiveTab}
            publicAgentCount={publicAgentCount}
            atPublicLimit={atPublicLimit}
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
        onVisibilityChange={setVisibility}
      />
    </div>
  );
}

function AgentTabsView({
  activeTab,
  onTabChange,
  publicAgentCount,
  atPublicLimit,
  onCreate,
}: {
  activeTab: Visibility;
  onTabChange: (tab: Visibility) => void;
  publicAgentCount: number;
  atPublicLimit: boolean;
  onCreate: (visibility: Visibility) => void;
}) {
  const agentsLoadable = useLoadable(sortedAgents$);
  const membersLoadable = useLoadable(orgMembers$);
  const features = useGet(featureSwitch$);
  const agentUnreadIndicatorsEnabled =
    features[FeatureSwitchKey.AgentUnreadIndicators] ?? false;
  const unreadAgentIds = useLastResolved(unreadAgentIds$);
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

  const visibleAgents =
    agents?.filter((a) => {
      return activeTab === "public"
        ? a.visibility !== "private"
        : a.visibility === "private";
    }) ?? [];

  const createDisabled = activeTab === "public" && atPublicLimit;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            if (value === "public" || value === "private") {
              onTabChange(value);
            }
          }}
        >
          <TabsList className="zero-tabs h-9 gap-1 px-1 py-1">
            <TabsTrigger
              value="public"
              className="gap-1.5 px-3 text-sm data-[state=active]:bg-background"
            >
              Public
            </TabsTrigger>
            <TabsTrigger
              value="private"
              className="gap-1.5 px-3 text-sm data-[state=active]:bg-background"
            >
              Private
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-4">
          {activeTab === "public" && (
            <PublicSlotIndicator
              used={publicAgentCount}
              total={MAX_PUBLIC_AGENTS}
            />
          )}
          <Button
            variant="outline"
            size="sm"
            className="zero-btn-morandi h-8 rounded-lg border"
            disabled={createDisabled}
            onClick={() => {
              return onCreate(activeTab);
            }}
          >
            Create
          </Button>
        </div>
      </div>

      {skeleton ? (
        <AgentGridSkeleton />
      ) : visibleAgents.length > 0 ? (
        <AgentGrid
          agents={visibleAgents}
          membersById={membersById}
          unreadAgentIds={unreadAgentIds}
          unreadIndicatorsEnabled={agentUnreadIndicatorsEnabled}
          showCreator={activeTab !== "private"}
        />
      ) : activeTab === "private" ? (
        <PrivateEmptyState
          onCreate={() => {
            return onCreate("private");
          }}
        />
      ) : null}
    </div>
  );
}

function PublicSlotIndicator({ used, total }: { used: number; total: number }) {
  const radius = 6.5;
  const circumference = 2 * Math.PI * radius;
  const fraction = total > 0 ? Math.min(1, used / total) : 0;
  return (
    <span
      className="flex items-center gap-2 text-xs text-muted-foreground"
      aria-label={`${used} of ${total} public agents used`}
    >
      <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
        <circle
          cx="9"
          cy="9"
          r={radius}
          fill="none"
          stroke="hsl(var(--gray-300))"
          strokeWidth="3"
        />
        <circle
          cx="9"
          cy="9"
          r={radius}
          fill="none"
          stroke="hsl(var(--foreground))"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={`${circumference * fraction} ${circumference}`}
          transform="rotate(-90 9 9)"
        />
      </svg>
      <span aria-hidden="true">
        <span className="font-semibold text-foreground">{used}</span> / {total}{" "}
        public
      </span>
    </span>
  );
}

function PrivateEmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center gap-1.5 py-14 text-center">
      <img
        src={emptyPrivateAgents}
        alt=""
        aria-hidden="true"
        className="mb-2 h-40 w-40 object-contain"
      />
      <p className="text-base font-semibold text-foreground">
        No private agents yet
      </p>
      <p className="max-w-[340px] text-sm text-muted-foreground">
        Create an agent only you can see and use. Private agents are unlimited.
      </p>
      <Button
        variant="outline"
        size="sm"
        className="zero-btn-morandi mt-4 h-8 rounded-lg border"
        onClick={onCreate}
      >
        Create agent
      </Button>
    </div>
  );
}

function AgentGrid({
  agents,
  membersById,
  unreadAgentIds,
  unreadIndicatorsEnabled,
  showCreator,
}: {
  agents: AgentProps["agent"][];
  membersById: ReadonlyMap<string, OrgMember>;
  unreadAgentIds: ReadonlySet<string> | undefined;
  unreadIndicatorsEnabled: boolean;
  showCreator: boolean;
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
              hasUnread={
                unreadIndicatorsEnabled &&
                (unreadAgentIds?.has(agent.id) ?? false)
              }
              showCreator={showCreator}
            />
          </Link>
        );
      })}
    </div>
  );
}

function AgentGridSkeleton() {
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  newName: string;
  onNameChange: (name: string) => void;
  onConfirm: (avatarUrl: string) => void;
  creating: boolean;
  visibility: Visibility;
  onVisibilityChange: (visibility: Visibility) => void;
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
        />
      )}
    </Dialog>
  );
}

function CreateAgentAvatarPreview() {
  const avatarUrl = useGet(jobsAvatarUrl$);
  const setAvatarUrl = useSet(setJobsAvatarUrl$);

  return (
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
}: {
  newName: string;
  onNameChange: (name: string) => void;
  onConfirm: (avatarUrl: string) => void;
  onCancel: () => void;
  creating: boolean;
  visibility: Visibility;
  onVisibilityChange: (visibility: Visibility) => void;
}) {
  const avatarUrl = useGet(jobsAvatarUrl$);

  return (
    <DialogContent className="sm:max-w-[480px] p-0 gap-0 overflow-hidden">
      <DialogHeader className="sr-only">
        <DialogTitle>Create a new agent</DialogTitle>
        <DialogDescription>
          Name the new agent, choose its visibility, and customize its avatar.
        </DialogDescription>
      </DialogHeader>

      <CreateAgentAvatarPreview />

      {/* Content */}
      <div className="flex flex-col gap-4 px-6 py-6">
        <div className="text-center">
          <p className="text-base font-semibold">Create a new agent</p>
          <p className="text-sm text-muted-foreground mt-0.5">
            Name your agent and set who can use it.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="new-agent-name"
            className="text-sm font-medium text-foreground"
          >
            Name
          </label>
          <Input
            id="new-agent-name"
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
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">Visibility</span>
          <Select
            value={visibility}
            onValueChange={(value) => {
              if (value === "public" || value === "private") {
                onVisibilityChange(value);
              }
            }}
            disabled={creating}
          >
            <SelectTrigger className="h-9 w-full" aria-label="Visibility">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="private">
                Private{" "}
                <span className="text-muted-foreground">
                  (only you can see and use it)
                </span>
              </SelectItem>
              <SelectItem value="public">
                Public{" "}
                <span className="text-muted-foreground">
                  (anyone in this workspace can use it)
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
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
  hasUnread: boolean;
  showCreator: boolean;
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

function AgentUnreadIndicator() {
  return (
    <span
      aria-label="Unread"
      className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-card bg-sky-600"
    />
  );
}

function AgentCard({ agent, creator, hasUnread, showCreator }: AgentProps) {
  const defaultAgentId = useLastResolved(defaultAgentId$);
  const lead = agent.id === defaultAgentId;
  const displayName = agent.displayName ?? agent.id;
  const description = defaultAgentId
    ? agent.description || (lead ? "Your core agent" : "Sub-agent")
    : "";
  return (
    <Card className="zero-card cursor-pointer flex flex-col hover:bg-muted/30 transition-colors h-full">
      <CardContent className="flex flex-1 flex-col gap-3 px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="relative h-10 w-10 shrink-0">
            <AgentAvatarImg
              name={agent.id}
              alt={displayName}
              className="h-10 w-10 rounded-full object-cover object-top"
            />
            {hasUnread && <AgentUnreadIndicator />}
          </span>
          <div className="flex-1 min-w-0">
            <span className="block truncate text-sm font-medium text-foreground">
              {displayName}
            </span>
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
              {description}
            </p>
          </div>
        </div>
        {showCreator && (
          <div className="mt-auto flex items-center gap-2 border-t border-border/60 pt-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full">
              <CreatorAvatar creator={creator} />
            </span>
            <span className="truncate text-xs text-muted-foreground">
              Created by {creator.name}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
