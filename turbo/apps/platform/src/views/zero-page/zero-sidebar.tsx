import type { ReactNode } from "react";
import { useLoadable, useGet, useSet } from "ccstate-react";
import { useCCState } from "ccstate-react/experimental";
import {
  IconChartLine,
  IconLayoutGrid,
  IconCalendar,
  IconAdjustmentsHorizontal,
  IconUser,
  IconUsers,
  IconLogout,
  IconPlus,
  IconChevronRight,
  IconSwitchHorizontal,
  IconSettings,
  IconEdit,
  IconChevronDown,
  IconLayoutSidebarLeftCollapse,
} from "@tabler/icons-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  cn,
} from "@vm0/ui";
import slackIcon from "../settings-page/icons/slack.svg";
import { ZERO_TEAM_JOBS } from "./zero-jobs-page.tsx";
import type { JobItem } from "./zero-job-detail-page.tsx";
import { clerk$, user$ } from "../../signals/auth.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { VM0ClerkProvider } from "../clerk/clerk-provider.tsx";
import { ClerkOrgSwitcher } from "./clerk-org-switcher.tsx";

export type ZeroNavId =
  | "chat"
  | "meet"
  | "schedule"
  | "search"
  | "job"
  | "production"
  | "logs"
  | "works"
  | "settings"
  | "account";

type NavIcon = (props: { size?: number; className?: string }) => ReactNode;
const MAIN_NAV = [
  { id: "job", label: "Zero's team", icon: IconUsers as NavIcon },
  { id: "schedule", label: "Schedule", icon: IconCalendar as NavIcon },
  { id: "logs", label: "Activity logs", icon: IconChartLine as NavIcon },
] as const;

const RECENT_ITEMS: Readonly<
  Record<string | "default", readonly { id: string; label: string }[]>
> = {
  default: [
    { id: "hello", label: "Hello from Zero" },
    { id: "1", label: "Daily digest workflow" },
    { id: "2", label: "Set up Slack integration" },
    { id: "3", label: "Weekly report automation" },
    { id: "4", label: "Code review reminders" },
  ],
  "1": [
    { id: "a1", label: "Morning standup summary" },
    { id: "a2", label: "Team updates digest" },
    { id: "a3", label: "Sprint recap for Monday" },
  ],
  "2": [
    { id: "r1", label: "Triage new issues" },
    { id: "r2", label: "Label stale PRs" },
    { id: "r3", label: "Review security alerts" },
  ],
  "3": [
    { id: "n1", label: "Weekly achievements report" },
    { id: "n2", label: "Team highlights recap" },
  ],
  "4": [
    { id: "s1", label: "Analyze Q3 feedback" },
    { id: "s2", label: "Summarize NPS results" },
    { id: "s3", label: "Customer pain points" },
  ],
};

const FOOTER_NAV = [
  {
    id: "works" as const satisfies ZeroNavId,
    label: "Where Zero works",
    icon: IconLayoutGrid as NavIcon,
    iconImg: slackIcon,
  },
  {
    id: "settings" as const satisfies ZeroNavId,
    label: "Settings",
    icon: IconSettings as NavIcon,
    iconImg: undefined,
  },
] as const;

export type ZeroAccountAction = "preferences" | "manage" | "signout";

export type ZeroAccountSubId = "preferences" | null;

interface SessionAccount {
  sessionId: string;
  name: string;
  email: string;
  initial: string;
  imageUrl: string | undefined;
  isActive: boolean;
}

interface ZeroSidebarProps {
  activeId: ZeroNavId;
  agentName?: string | null;
  zeroAvatarSrc?: string;
  currentChatAgentId?: string | null;
  onSelect: (id: ZeroNavId) => void;
  onRecentSelect?: (id: string) => void;
  selectedRecentId?: string | null;
  onAccountAction?: (action: ZeroAccountAction) => void;
  onNewChat?: (agentId: string | null) => void;
}

function AccountAvatar({
  imageUrl,
  name,
  initial,
  size = "sm",
}: {
  imageUrl: string | undefined;
  name: string;
  initial: string;
  size?: "sm" | "md";
}) {
  const dim = size === "md" ? "h-9 w-9" : "h-8 w-8";
  const textSize = size === "md" ? "text-sm" : "text-xs";
  if (imageUrl) {
    return (
      <div className={`${dim} shrink-0 rounded-xl overflow-hidden`}>
        <img src={imageUrl} alt={name} className="h-full w-full object-cover" />
      </div>
    );
  }
  return (
    <div
      className={`${dim} rounded-xl bg-orange-200/95 dark:bg-orange-300/80 flex items-center justify-center text-orange-900 dark:text-orange-950 ${textSize} font-medium shrink-0`}
    >
      {initial}
    </div>
  );
}

function useAccountSessions() {
  const clerkLoadable = useLoadable(clerk$);
  const userLoadable = useLoadable(user$);
  const user = userLoadable.state === "hasData" ? userLoadable.data : null;
  const clerk = clerkLoadable.state === "hasData" ? clerkLoadable.data : null;

  const currentSessionId = clerk?.session?.id;
  const accounts: SessionAccount[] = (clerk?.client?.sessions ?? [])
    .filter((s) => s.status === "active")
    .map((s) => ({
      sessionId: s.id,
      name: s.user?.fullName ?? "User",
      email: s.user?.primaryEmailAddress?.emailAddress ?? "",
      initial: s.user?.fullName ? s.user.fullName.charAt(0).toUpperCase() : "U",
      imageUrl: s.user?.imageUrl,
      isActive: s.id === currentSessionId,
    }));

  return { user, clerk, accounts };
}

function AccountDropdown({
  activeId,
  onAccountAction,
}: {
  activeId: ZeroNavId;
  onAccountAction?: (action: ZeroAccountAction) => void;
}) {
  const { user, clerk, accounts } = useAccountSessions();
  const accountName = user?.fullName ?? "User";
  const accountEmail = user?.primaryEmailAddress?.emailAddress ?? "";
  const accountInitial = accountName.charAt(0).toUpperCase();

  const current = accounts.find((a) => a.isActive);
  const others = accounts.filter((a) => !a.isActive);
  const hasOthers = others.length > 0;

  const handleAccountAction = (action: ZeroAccountAction) => {
    if (action === "signout") {
      const sessionId = clerk?.session?.id;
      detach(clerk?.signOut({ sessionId }), Reason.DomCallback);
      return;
    }
    if (action === "manage") {
      detach(clerk?.openUserProfile(), Reason.DomCallback);
      return;
    }
    onAccountAction?.(action);
  };

  const handleSwitchSession = (sessionId: string) => {
    detach(clerk?.setActive({ session: sessionId }), Reason.DomCallback);
  };

  const handleAddAccount = () => {
    detach(clerk?.openSignIn(), Reason.DomCallback);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`flex w-full items-center gap-2 rounded-lg p-2 text-left transition-colors duration-200 ${
            activeId === "account"
              ? "bg-sidebar-active"
              : "hover:bg-sidebar-accent/50"
          }`}
        >
          <AccountAvatar
            imageUrl={user?.imageUrl}
            name={accountName}
            initial={accountInitial}
          />
          <div className="flex-1 min-w-0">
            <p
              className={`text-sm font-medium leading-tight truncate ${
                activeId === "account"
                  ? "text-sidebar-primary"
                  : "text-sidebar-foreground"
              }`}
            >
              {accountName}
            </p>
            <p
              className={`text-xs leading-tight truncate mt-px ${
                activeId === "account"
                  ? "text-sidebar-primary/80"
                  : "text-sidebar-foreground opacity-70"
              }`}
            >
              {accountEmail}
            </p>
          </div>
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[240px]"
      >
        {/* Current account header */}
        {current && (
          <>
            <div className="px-3 py-3">
              <div className="flex items-center gap-3">
                <AccountAvatar
                  imageUrl={current.imageUrl}
                  name={current.name}
                  initial={current.initial}
                  size="md"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground truncate">
                    {current.name}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {current.email}
                  </div>
                </div>
              </div>
            </div>
            <DropdownMenuSeparator />
          </>
        )}

        {/* Switch account sub-menu or Add account (dev only) */}
        {import.meta.env.DEV && (
          <>
            {hasOthers ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="gap-3 px-3 py-2.5">
                  <IconSwitchHorizontal size={18} stroke={1.5} />
                  <span className="flex-1">Switch account</span>
                  <IconChevronRight
                    size={14}
                    stroke={1.5}
                    className="text-muted-foreground"
                  />
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-[220px]">
                  {others.map((account) => (
                    <DropdownMenuItem
                      key={account.sessionId}
                      onClick={() => handleSwitchSession(account.sessionId)}
                      className="gap-3 px-3 py-2.5"
                    >
                      <AccountAvatar
                        imageUrl={account.imageUrl}
                        name={account.name}
                        initial={account.initial}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-foreground truncate">
                          {account.name}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {account.email}
                        </div>
                      </div>
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={handleAddAccount}
                    className="gap-3 px-3 py-2.5"
                  >
                    <IconPlus size={18} stroke={1.5} />
                    <span>Add account</span>
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : (
              <DropdownMenuItem
                onClick={handleAddAccount}
                className="gap-3 px-3 py-2.5"
              >
                <IconPlus size={18} stroke={1.5} />
                <span>Add account</span>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
          </>
        )}

        {/* Actions */}
        <DropdownMenuItem
          onClick={() => handleAccountAction("preferences")}
          className="gap-3 px-3 py-2.5"
        >
          <IconAdjustmentsHorizontal size={18} stroke={1.5} />
          <span>Preferences</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => handleAccountAction("manage")}
          className="gap-3 px-3 py-2.5"
        >
          <IconUser size={18} stroke={1.5} />
          <span>Manage account</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => handleAccountAction("signout")}
          className="gap-3 px-3 py-2.5"
        >
          <IconLogout size={18} stroke={1.5} />
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ManagePinnedAgentsDialog({
  open,
  onOpenChange,
  zeroAvatarSrc,
  displayName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  zeroAvatarSrc: string;
  displayName: string;
}) {
  const pinnedIds$ = useCCState<string[]>(ZERO_TEAM_JOBS.map((j) => j.id));
  const pinnedIds = useGet(pinnedIds$);
  const setPinnedIds = useSet(pinnedIds$);

  const orderedPinned: Readonly<JobItem>[] = pinnedIds
    .map((id) => ZERO_TEAM_JOBS.find((j) => j.id === id))
    .filter((j): j is Readonly<JobItem> => j !== null && j !== undefined);

  const unpinned = ZERO_TEAM_JOBS.filter((j) => !pinnedIds.includes(j.id));

  const moveUp = (idx: number) => {
    if (idx <= 0) {
      return;
    }
    const next = [...pinnedIds];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    setPinnedIds(next);
  };

  const moveDown = (idx: number) => {
    if (idx >= pinnedIds.length - 1) {
      return;
    }
    const next = [...pinnedIds];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    setPinnedIds(next);
  };

  const togglePin = (agentId: string) => {
    if (pinnedIds.includes(agentId)) {
      setPinnedIds(pinnedIds.filter((id) => id !== agentId));
    } else {
      setPinnedIds([...pinnedIds, agentId]);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px] p-0 gap-0">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="text-base font-semibold">
            Manage pinned agents
          </DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Reorder or add agents to your sidebar.
          </p>
        </DialogHeader>

        <div className="px-5 pb-2">
          {/* Zero — always pinned */}
          <div className="flex items-center gap-3 px-1 py-2.5 rounded-lg">
            <div className="w-5 shrink-0" />
            <img
              src={zeroAvatarSrc}
              alt={displayName}
              className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
            />
            <span className="text-sm font-medium text-foreground flex-1 truncate">
              {displayName}
            </span>
            <span className="text-xs text-muted-foreground mr-1">Main</span>
          </div>
        </div>

        {orderedPinned.length > 0 && (
          <div className="px-5 pb-2">
            <div className="border-t border-border/60 mb-2" />
            <span className="text-xs font-medium text-muted-foreground px-1">
              Pinned
            </span>
            <div className="flex flex-col mt-1">
              {orderedPinned.map((agent, idx) => (
                <div
                  key={agent.id}
                  className="flex items-center gap-3 px-1 py-2 rounded-lg hover:bg-muted/50 transition-colors group"
                >
                  <div className="flex flex-col shrink-0 w-5 items-center gap-0.5">
                    <button
                      type="button"
                      className={cn(
                        "text-muted-foreground/40 hover:text-foreground transition-colors",
                        idx === 0 && "invisible",
                      )}
                      onClick={() => moveUp(idx)}
                      aria-label="Move up"
                    >
                      <IconChevronDown size={14} className="rotate-180" />
                    </button>
                    <button
                      type="button"
                      className={cn(
                        "text-muted-foreground/40 hover:text-foreground transition-colors",
                        idx === orderedPinned.length - 1 && "invisible",
                      )}
                      onClick={() => moveDown(idx)}
                      aria-label="Move down"
                    >
                      <IconChevronDown size={14} />
                    </button>
                  </div>
                  <img
                    src={agent.avatar}
                    alt={agent.title}
                    className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
                  />
                  <span className="text-sm text-foreground flex-1 truncate">
                    {agent.title}
                  </span>
                  <button
                    type="button"
                    className="text-muted-foreground/50 hover:text-destructive transition-colors p-1"
                    onClick={() => togglePin(agent.id)}
                    aria-label={`Unpin ${agent.title}`}
                  >
                    <IconPlus size={14} className="rotate-45" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {unpinned.length > 0 && (
          <div className="px-5 pb-5">
            <div className="border-t border-border/60 mb-2" />
            <span className="text-xs font-medium text-muted-foreground px-1">
              Available agents
            </span>
            <div className="flex flex-col mt-1">
              {unpinned.map((agent) => (
                <div
                  key={agent.id}
                  className="flex items-center gap-3 px-1 py-2 rounded-lg hover:bg-muted/50 transition-colors"
                >
                  <div className="w-5 shrink-0" />
                  <img
                    src={agent.avatar}
                    alt={agent.title}
                    className="h-8 w-8 shrink-0 rounded-lg object-cover object-top opacity-60"
                  />
                  <span className="text-sm text-muted-foreground flex-1 truncate">
                    {agent.title}
                  </span>
                  <button
                    type="button"
                    className="text-primary hover:text-primary/80 transition-colors p-1 text-xs font-medium"
                    onClick={() => togglePin(agent.id)}
                  >
                    Pin
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {unpinned.length === 0 && (
          <div className="px-5 pb-5">
            <div className="border-t border-border/60 mb-2" />
            <p className="text-xs text-muted-foreground px-1 py-2">
              All agents are pinned.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ZeroSidebar({
  activeId,
  agentName,
  zeroAvatarSrc = "/zero-avatar.png",
  currentChatAgentId = null,
  onSelect,
  onRecentSelect,
  selectedRecentId = null,
  onAccountAction,
  onNewChat,
}: ZeroSidebarProps) {
  const displayName = agentName || "Zero";
  const agentsExpanded$ = useCCState(true);
  const agentsExpanded = useGet(agentsExpanded$);
  const setAgentsExpanded = useSet(agentsExpanded$);
  const managePinnedOpen$ = useCCState(false);
  const managePinnedOpen = useGet(managePinnedOpen$);
  const setManagePinnedOpen = useSet(managePinnedOpen$);
  const talkToName = currentChatAgentId
    ? (ZERO_TEAM_JOBS.find((j) => j.id === currentChatAgentId)?.title ??
      displayName)
    : displayName;
  const mainNav = MAIN_NAV.map((item) => ({
    ...item,
    label: item.label.replace("Zero", displayName),
  }));
  const agentRecentItems =
    RECENT_ITEMS[currentChatAgentId ?? "default"] ?? RECENT_ITEMS["default"];
  const recentItems = agentRecentItems.map((item) => ({
    ...item,
    label: item.label.replace("Zero", displayName),
  }));
  const footerNav = FOOTER_NAV.map((item) => ({
    ...item,
    label: item.label.replace("Zero", displayName),
  }));

  return (
    <VM0ClerkProvider>
      <aside className="zero-nav flex h-full w-[255px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar overflow-hidden">
        {/* Organization switcher */}
        <div className="shrink-0 px-2 pt-1.5 pb-0">
          <div className="flex items-center justify-between rounded-lg pr-0 py-0.5">
            <ClerkOrgSwitcher />
            <button
              type="button"
              className="flex h-7 w-7 -mr-[3px] shrink-0 items-center justify-center rounded-lg text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
              aria-label="Collapse sidebar"
            >
              <IconLayoutSidebarLeftCollapse size={18} />
            </button>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto overflow-x-hidden p-2 pt-1">
          {/* Manage */}
          <div>
            <div className="h-7 flex items-center pl-2">
              <span className="text-[13px] leading-4 text-sidebar-foreground/50 font-medium">
                Manage
              </span>
            </div>
            <div className="flex flex-col gap-1">
              {mainNav.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => onSelect(id)}
                  className={`flex w-full h-8 items-center gap-2 rounded-lg p-2 text-left text-sm leading-5 transition-colors duration-200 ${
                    activeId === id
                      ? "bg-sidebar-active text-sidebar-primary font-medium"
                      : "text-sidebar-foreground hover:bg-sidebar-accent"
                  }`}
                >
                  <Icon size={16} className="shrink-0" />
                  <span className="truncate">{label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Talk to + New chat */}
          <div className="mt-4">
            <button
              type="button"
              className="flex h-7 w-full items-center gap-1 px-2 text-sidebar-foreground/50 hover:text-sidebar-foreground transition-colors"
              onClick={() => setAgentsExpanded(!agentsExpanded)}
            >
              <span className="text-[13px] font-medium">
                Talk to {talkToName}
              </span>
              <IconChevronDown
                size={14}
                className={`shrink-0 transition-transform ${agentsExpanded ? "" : "-rotate-90"}`}
              />
            </button>
            {agentsExpanded && (
              <div className="flex items-center gap-1.5 px-2 pb-1 pt-1">
                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg overflow-hidden transition-all ${
                          currentChatAgentId === null
                            ? "bg-foreground/10"
                            : "hover:bg-foreground/5"
                        }`}
                        onClick={() => onNewChat?.(null)}
                      >
                        <img
                          src={zeroAvatarSrc}
                          alt={displayName}
                          className="h-full w-full object-cover object-top"
                        />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs">
                      {displayName}
                    </TooltipContent>
                  </Tooltip>
                  {ZERO_TEAM_JOBS.map((agent) => (
                    <Tooltip key={agent.id}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg overflow-hidden transition-all ${
                            currentChatAgentId === agent.id
                              ? "bg-foreground/10"
                              : "hover:bg-foreground/5"
                          }`}
                          onClick={() => onNewChat?.(agent.id)}
                        >
                          <img
                            src={agent.avatar}
                            alt={agent.title}
                            className="h-full w-full object-cover object-top"
                          />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="text-xs">
                        {agent.title}
                      </TooltipContent>
                    </Tooltip>
                  ))}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-dashed border-sidebar-foreground/25 text-sidebar-foreground/30 hover:border-sidebar-foreground/40 hover:text-sidebar-foreground/60 transition-colors"
                        aria-label="Manage pinned agents"
                        onClick={() => setManagePinnedOpen(true)}
                      >
                        <IconPlus size={14} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs">
                      Manage pinned agents
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            )}
            <div className="flex flex-col gap-1 mt-1">
              <button
                type="button"
                onClick={() => onSelect("chat")}
                className={`flex w-full h-8 items-center gap-2 rounded-lg p-2 text-left text-sm leading-5 transition-colors duration-200 ${
                  activeId === "chat" && !selectedRecentId
                    ? "bg-sidebar-active text-sidebar-primary font-medium"
                    : "text-sidebar-foreground hover:bg-sidebar-accent"
                }`}
              >
                <IconEdit size={16} className="shrink-0" />
                <span className="truncate">New chat</span>
              </button>
            </div>
          </div>

          {/* Recent chats */}
          <div className="mt-4">
            <div className="h-7 flex items-center pl-2">
              <span className="zero-nav-recent-label text-[13px] leading-4 text-sidebar-foreground font-medium">
                Recent chats
              </span>
            </div>
            <div className="flex flex-col gap-1 mt-1">
              {recentItems.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => onRecentSelect?.(id)}
                  className={`flex h-8 items-center gap-2 rounded-lg p-2 text-left text-sm leading-5 transition-colors ${
                    selectedRecentId === id
                      ? "bg-sidebar-active text-sidebar-primary"
                      : "text-sidebar-foreground hover:bg-sidebar-accent"
                  }`}
                >
                  <span className="truncate min-w-0 flex-1">{label}</span>
                  {id === "hello" && (
                    <span
                      className="shrink-0 w-1.5 h-1.5 rounded-full bg-red-500"
                      aria-hidden
                    />
                  )}
                </button>
              ))}
            </div>
          </div>
        </nav>

        {/* Footer nav */}
        <div className="p-2">
          <div className="flex flex-col gap-1">
            {footerNav.map(({ id, label, icon: Icon, iconImg }) => (
              <button
                key={id}
                type="button"
                onClick={() => onSelect(id)}
                className={`flex w-full h-8 items-center gap-2 rounded-lg p-2 text-left text-sm leading-5 transition-colors duration-200 ${
                  activeId === id
                    ? "bg-sidebar-active text-sidebar-primary font-medium"
                    : "text-sidebar-foreground hover:bg-sidebar-accent"
                }`}
              >
                {iconImg ? (
                  <img
                    src={iconImg}
                    alt=""
                    className="h-4 w-4 shrink-0"
                    width={16}
                    height={16}
                  />
                ) : (
                  <Icon size={16} className="shrink-0" />
                )}
                <span className="truncate">{label}</span>
              </button>
            ))}
            {/* Account dropdown */}
            <AccountDropdown
              activeId={activeId}
              onAccountAction={onAccountAction}
            />
          </div>
        </div>
      </aside>

      <ManagePinnedAgentsDialog
        open={managePinnedOpen}
        onOpenChange={setManagePinnedOpen}
        zeroAvatarSrc={zeroAvatarSrc}
        displayName={displayName}
      />
    </VM0ClerkProvider>
  );
}
