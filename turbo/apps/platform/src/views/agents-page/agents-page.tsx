import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { isMobileViewport$ } from "../../signals/zero-page/mobile-viewport.ts";
import {
  IconLayoutGrid,
  IconList,
  IconLoader2,
  IconPlus,
  IconWand,
} from "@tabler/icons-react";
import {
  Card,
  CardContent,
  cn,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Button,
  Input,
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
  resetJobsDialog$,
  jobsViewMode$,
  setJobsViewMode$,
} from "../../signals/zero-page/zero-jobs-page.ts";
import { serializeAvatarSvgConfig } from "../zero-page/avatar-svg-utils.ts";
import { AvatarMaker } from "../zero-page/avatar-maker.tsx";

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

  const features = useLastResolved(featureSwitch$);
  const mobileNativeOn = features?.[FeatureSwitchKey.MobileNativeV1] ?? false;
  const isMobile = useGet(isMobileViewport$);
  // The mobile-native chrome is mobile-only — on desktop the user keeps
  // their grid/list preference even when the feature switch is on.
  const mobileRedesign = mobileNativeOn && isMobile;
  const effectiveViewMode = mobileRedesign ? "list" : viewMode;

  const agentsLoadable = useLoadable(sortedAgents$);
  const agentCount =
    agentsLoadable.state === "hasData" ? agentsLoadable.data.length : 0;
  const atLimit = agentCount >= 7;

  const handleCreateTeammate = onDomEventFn(async (avatarUrl: string) => {
    const trimmed = newName.trim();
    if (!trimmed || creating) {
      return;
    }
    await createSubagentFn(trimmed, avatarUrl, pageSignal);
    setDialogOpen(false);
    resetDialog();
    toast.success(`${trimmed} created successfully`);
  });

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header
        className={`shrink-0 bg-transparent px-4 sm:px-6 md:pt-10 md:pb-3 ${
          mobileRedesign ? "hidden md:block" : "pt-3 pb-0"
        }`}
      >
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
              <Tooltip open={atLimit ? undefined : false}>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button
                      variant="outline"
                      size="sm"
                      className="zero-btn-morandi h-9 gap-2 shrink-0 rounded-lg border"
                      disabled={atLimit}
                      onClick={() => {
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
                  className="gap-1.5 text-[16px] sm:text-sm data-[state=active]:bg-background px-3"
                >
                  <IconLayoutGrid size={14} stroke={1.5} />
                  Grid
                </TabsTrigger>
                <TabsTrigger
                  value="list"
                  className="gap-1.5 text-[16px] sm:text-sm data-[state=active]:bg-background px-3"
                >
                  <IconList size={14} stroke={1.5} />
                  List
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>
      </header>

      <main
        className={`flex-1 overflow-auto px-4 sm:px-6 pb-8 pt-3`}
      >
        <div className="mx-auto max-w-[900px] flex flex-col gap-4">
          {effectiveViewMode === "grid" ? (
            <AgentGridView />
          ) : (
            <AgentListView flat={mobileRedesign} />
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

function AgentListView({ flat = false }: { flat?: boolean }) {
  const agentsLoadable = useLoadable(sortedAgents$);
  const loading = agentsLoadable.state === "loading";
  const agents =
    agentsLoadable.state === "hasData" ? agentsLoadable.data : null;

  return (
    <div className={cn(flat ? "flex flex-col" : "zero-card overflow-hidden")}>
      {loading &&
        (!agents || agents.length === 0) &&
        [1, 2, 3].map((i, _, arr) => {
          return (
            <div key={i}>
              <div
                className={cn(
                  "flex items-center gap-3 py-3 animate-pulse",
                  flat ? "" : "px-5",
                )}
              >
                <div className="h-11 w-11 max-md:h-14 max-md:w-14 rounded-xl bg-muted" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="h-4 w-24 rounded bg-muted" />
                  <div className="h-3 w-40 rounded bg-muted" />
                </div>
              </div>
              {i < arr.length && !flat && (
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
            <AgentListRow
              agent={agent}
              isLast={idx === agents.length - 1}
              flat={flat}
            />
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

function CreateTeammateAvatarBand({
  avatarUrl,
  setAvatarUrl,
}: {
  avatarUrl: string;
  setAvatarUrl: (url: string) => void;
}) {
  return (
    <div className="flex flex-col items-center pt-10 pb-6 bg-muted/30 max-md:pt-8 max-md:pb-8 max-md:bg-muted/20">
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
                className="h-16 w-16 max-md:h-24 max-md:w-24 rounded-full object-cover object-top"
              />
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="absolute -right-0.5 -bottom-0.5 flex h-5 w-5 max-md:h-7 max-md:w-7 items-center justify-center rounded-full bg-background text-muted-foreground shadow-sm border border-border">
                      <IconWand
                        size={10}
                        stroke={1.5}
                        className="max-md:hidden"
                      />
                      <IconWand
                        size={14}
                        stroke={1.5}
                        className="hidden max-md:block"
                      />
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
}: {
  newName: string;
  onNameChange: (name: string) => void;
  onConfirm: (avatarUrl: string) => void;
  onCancel: () => void;
  creating: boolean;
}) {
  const avatarUrl = useGet(jobsAvatarUrl$);
  const setAvatarUrl = useSet(setJobsAvatarUrl$);

  return (
    <DialogContent
      className={cn(
        // Desktop: centered modal with hero band.
        "sm:max-w-[480px] p-0 gap-0 overflow-hidden",
        // Mobile: full-page view — flex column so the footer can pin to the
        // bottom while the body grows to fill remaining height. `!` overrides
        // the primitive's centered-modal positioning at the < md breakpoint.
        "max-md:!inset-0 max-md:!left-0 max-md:!top-0 max-md:!w-screen max-md:!max-w-none max-md:!h-[100dvh] max-md:!max-h-[100dvh] max-md:!translate-x-0 max-md:!translate-y-0 max-md:!rounded-none max-md:!border-0 max-md:!shadow-none max-md:flex max-md:flex-col",
      )}
    >
      <DialogHeader className="sr-only">
        <DialogTitle>Create a new agent</DialogTitle>
      </DialogHeader>

      {/* Mobile-only page header — title + subtitle, with right padding so
          the title never crashes into the primitive close X. */}
      <div className="hidden max-md:flex max-md:flex-col max-md:shrink-0 max-md:px-6 max-md:pt-[max(env(safe-area-inset-top),1.25rem)] max-md:pb-2 max-md:pr-14">
        <h1 className="text-[20px] font-semibold leading-7 text-foreground">
          Create a new agent
        </h1>
        <p className="text-[14px] text-muted-foreground mt-1 leading-snug">
          Tap the avatar to customize, then give your agent a name.
        </p>
      </div>

      <CreateTeammateAvatarBand
        avatarUrl={avatarUrl}
        setAvatarUrl={setAvatarUrl}
      />

      {/* Body — desktop centers content; mobile lets it grow so the footer
          docks to the bottom edge. */}
      <div className="flex flex-col items-center gap-4 px-6 py-6 max-md:flex-1 max-md:items-stretch max-md:px-5 max-md:pt-6 max-md:pb-4 max-md:gap-3 max-md:overflow-y-auto">
        <div className="text-center max-md:hidden">
          <p className="text-base font-semibold">Create a new agent</p>
          <p className="text-sm text-muted-foreground mt-0.5">
            Name your agent to get started.
          </p>
        </div>
        <label
          htmlFor="create-agent-name"
          className="hidden max-md:block text-[13px] font-medium text-muted-foreground uppercase tracking-wide"
        >
          Name
        </label>
        <Input
          id="create-agent-name"
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
          // 16px font-size on mobile prevents iOS Safari's auto-zoom on
          // focus; 48px height matches the rest of the mobile-native chrome.
          className="max-md:h-12 max-md:text-[16px]"
        />
      </div>

      {/* Footer — desktop: centered button pair; mobile: full-width primary
          docked to the bottom with safe-area inset. Cancel collapses into
          the close X (top-right) on mobile to keep the action surface clean. */}
      <div className="flex justify-center gap-3 px-6 pt-4 pb-8 max-md:shrink-0 max-md:flex-col-reverse max-md:gap-2 max-md:px-5 max-md:pt-3 max-md:pb-[max(env(safe-area-inset-bottom),1.25rem)] max-md:border-t max-md:border-border/60">
        <Button
          variant="outline"
          onClick={onCancel}
          disabled={creating}
          className="max-md:hidden"
        >
          Cancel
        </Button>
        <Button
          onClick={() => {
            return onConfirm(avatarUrl);
          }}
          disabled={!newName.trim() || creating}
          className="max-md:w-full max-md:h-12 max-md:text-[16px]"
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
          <span className="text-sm max-md:text-[16px] font-medium text-foreground truncate block">
            {displayName}
          </span>
          <p className="text-[16px] sm:text-[14px] text-muted-foreground mt-0.5 line-clamp-1">
            {description}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function AgentListRow({
  agent,
  isLast,
  flat = false,
}: AgentProps & { isLast?: boolean; flat?: boolean }) {
  const defaultAgentId = useLastResolved(defaultAgentId$);
  const lead = agent.id === defaultAgentId;

  const displayName = agent.displayName ?? agent.id;
  const description = defaultAgentId
    ? agent.description || (lead ? "Your core agent" : "Sub-agent")
    : "";

  return (
    <>
      <div
        className={cn(
          "flex items-center gap-3 py-3 w-full text-left transition-colors hover:bg-muted/30 cursor-pointer",
          flat ? "" : "px-5",
        )}
      >
        <AgentAvatarImg
          name={agent.id}
          alt={displayName}
          className="h-11 w-11 max-md:h-14 max-md:w-14 shrink-0 rounded-xl object-cover object-top"
        />
        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
          <span className="truncate text-[16px] leading-snug font-medium text-foreground">
            {displayName}
          </span>
          {description && (
            <span className="truncate text-xs max-md:text-[16px] text-muted-foreground">
              {description}
            </span>
          )}
        </div>
      </div>
      {!isLast && !flat && <div className="mx-5 border-b border-border/50" />}
    </>
  );
}
