import { useState, type ReactNode } from "react";
import {
  useLoadable,
  useLastLoadable,
  useLastResolved,
  useGet,
  useSet,
} from "ccstate-react";
import {
  IconChartBar,
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
  IconLoader2,
  IconSearch,
  IconX,
  IconEdit,
  IconLayoutSidebarLeftCollapse,
  IconDatabaseExport,
  IconCrown,
} from "@tabler/icons-react";
import { FeatureSwitchKey, type ChatThreadListItem } from "@vm0/core";
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
} from "@vm0/ui";
import slackIcon from "./components/settings/icons/slack.svg";
import zeroAvatarImg from "./assets/zero-avatar.webp";
import { clerk$, user$ } from "../../signals/auth.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  zeroActiveId$,
  zeroSessionId$,
  zeroChatAgentId$,
  zeroSidebarCollapsed$,
  setZeroSidebarCollapsed$,
  handleZeroNavSelect$,
  handleZeroAccountAction$,
  zeroAvatarIndex$,
  navigateToZeroSession$,
} from "../../signals/zero-page/zero-nav.ts";
import {
  agentDisplayName$,
  defaultAgentName$,
} from "../../signals/zero-page/zero-agent-name.ts";
import { zeroSubagents$ } from "../../signals/zero-page/zero-agents.ts";
import {
  zeroSessionList$,
  zeroSessionListLoading$,
  zeroSessionListError$,
  startNewZeroSession$,
} from "../../signals/zero-page/zero-chat.ts";
import { navigateTo$ } from "../../signals/route.ts";
import {
  pinnedAgentIds$,
  savingPinnedAgents$,
  updatePinnedAgentIds$,
} from "../../signals/zero-page/zero-pinned-agents.ts";
import {
  sidebarSearchOpen$,
  sidebarSearchTerm$,
  setSidebarSearchOpen$,
  setSidebarSearchTerm$,
  managePinnedDialogOpen$,
  setManagePinnedDialogOpen$,
} from "../../signals/zero-page/zero-sidebar-state.ts";
import { VM0ClerkProvider } from "../clerk/clerk-provider.tsx";
import { ClerkOrgSwitcher } from "./clerk-org-switcher.tsx";
import {
  AGENT_AVATARS,
  AgentAvatarImg,
  type SubagentInfo,
} from "./zero-sidebar-shared.tsx";
import { Link } from "../router/link.tsx";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { apiBaseForNavigation$ } from "../../signals/fetch.ts";
import {
  billingStatusAsync$,
  openBillingDialog$,
} from "../../signals/zero-page/billing.ts";
import { BillingDialog } from "./billing-dialog.tsx";
import {
  ChatListDialog,
  ManagePinnedAgentsDialog,
} from "./zero-sidebar-dialogs.tsx";

// Re-export shared types/components for backward compatibility
export { AGENT_AVATARS, useAgentAvatar } from "./zero-sidebar-shared.tsx";

export type ZeroNavId =
  | "chat"
  | "schedule"
  | "team"
  | "activity"
  | "works"
  | "usage"
  | "preferences"
  | "queue"
  | "not-found";

type NavIcon = (props: { size?: number; className?: string }) => ReactNode;
const MANAGE_NAV = [
  { id: "team", label: "Zero's team", icon: IconUsers as NavIcon },
  { id: "schedule", label: "Scheduled", icon: IconCalendar as NavIcon },
  { id: "activity", label: "Activity logs", icon: IconChartLine as NavIcon },
] as const;

interface FooterNavItem {
  id: ZeroNavId;
  label: string;
  icon: NavIcon;
  iconImg: string | undefined;
  featureGate: FeatureSwitchKey | undefined;
}

const FOOTER_NAV = [
  {
    id: "works",
    label: "Where Zero works",
    icon: IconLayoutGrid as NavIcon,
    iconImg: slackIcon,
    featureGate: undefined,
  },
  {
    id: "usage",
    label: "Usage",
    icon: IconChartBar as NavIcon,
    iconImg: undefined,
    featureGate: FeatureSwitchKey.Usage,
  },
] as const satisfies readonly FooterNavItem[];

export type ZeroAccountAction = "preferences" | "manage" | "signout";

interface SessionAccount {
  sessionId: string;
  name: string;
  email: string;
  initial: string;
  imageUrl: string | undefined;
  isActive: boolean;
}

const ZERO_AVATARS = [zeroAvatarImg, ...AGENT_AVATARS] as const;

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
  onAccountAction,
  collapsed = false,
}: {
  onAccountAction?: (action: ZeroAccountAction) => void;
  collapsed?: boolean;
}) {
  const { user, clerk, accounts } = useAccountSessions();
  const features = useLastResolved(featureSwitch$);
  const apiBase = useGet(apiBaseForNavigation$);
  const showExportData = features?.[FeatureSwitchKey.DataExport] ?? false;
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
    detach(
      clerk?.setActive({
        session: sessionId,
        beforeEmit: () => window.location.reload(),
      }),
      Reason.DomCallback,
    );
  };

  const handleAddAccount = () => {
    detach(clerk?.openSignIn(), Reason.DomCallback);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`rounded-lg transition-colors duration-200 ${
            collapsed
              ? "inline-flex h-8 w-8 shrink-0 items-center justify-center p-0 hover:bg-sidebar-accent/50"
              : "flex w-full items-center gap-2 p-2 text-left hover:bg-sidebar-accent/50"
          }`}
        >
          <AccountAvatar
            imageUrl={user?.imageUrl}
            name={accountName}
            initial={accountInitial}
          />
          {!collapsed && (
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium leading-tight truncate text-sidebar-foreground">
                {accountName}
              </p>
              <p className="text-xs leading-tight truncate mt-px text-sidebar-foreground opacity-70">
                {accountEmail}
              </p>
            </div>
          )}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[240px] rounded-lg"
        style={{ border: "0.7px solid hsl(var(--gray-400))" }}
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
            <DropdownMenuSeparator
              className="h-0 bg-transparent"
              style={{ borderTop: "0.7px solid hsl(var(--gray-400))" }}
            />
          </>
        )}

        {/* Preferences (standalone) */}
        <DropdownMenuItem
          onClick={() => handleAccountAction("preferences")}
          className="gap-3 px-3 py-2.5 rounded-lg"
        >
          <IconAdjustmentsHorizontal
            size={18}
            stroke={1.5}
            className="text-muted-foreground"
          />
          <span>Preferences</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator
          className="h-0 bg-transparent"
          style={{ borderTop: "0.7px solid hsl(var(--gray-400))" }}
        />

        {/* Account management group */}
        {hasOthers ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-3 px-3 py-2.5 rounded-lg">
              <IconSwitchHorizontal
                size={18}
                stroke={1.5}
                className="text-muted-foreground"
              />
              <span className="flex-1">Switch account</span>
              <IconChevronRight
                size={14}
                stroke={1.5}
                className="text-muted-foreground"
              />
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              className="w-[220px] rounded-lg"
              style={{ border: "0.7px solid hsl(var(--gray-400))" }}
            >
              {others.map((account) => (
                <DropdownMenuItem
                  key={account.sessionId}
                  onClick={() => handleSwitchSession(account.sessionId)}
                  className="gap-3 px-3 py-2.5 rounded-lg"
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
              <DropdownMenuSeparator
                className="h-0 bg-transparent"
                style={{ borderTop: "0.7px solid hsl(var(--gray-400))" }}
              />
              <DropdownMenuItem
                onClick={handleAddAccount}
                className="gap-3 px-3 py-2.5 rounded-lg"
              >
                <IconPlus
                  size={18}
                  stroke={1.5}
                  className="text-muted-foreground"
                />
                <span>Add account</span>
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : (
          <DropdownMenuItem
            onClick={handleAddAccount}
            className="gap-3 px-3 py-2.5 rounded-lg"
          >
            <IconPlus
              size={18}
              stroke={1.5}
              className="text-muted-foreground"
            />
            <span>Add account</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => handleAccountAction("manage")}
          className="gap-3 px-3 py-2.5 rounded-lg"
        >
          <IconUser size={18} stroke={1.5} className="text-muted-foreground" />
          <span>Manage account</span>
        </DropdownMenuItem>
        {showExportData && (
          <DropdownMenuItem
            onClick={() => window.open(`${apiBase}/export`, "_blank")}
            className="gap-3 px-3 py-2.5 rounded-lg"
          >
            <IconDatabaseExport
              size={18}
              stroke={1.5}
              className="text-muted-foreground"
            />
            <span>Export data</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => handleAccountAction("signout")}
          className="gap-3 px-3 py-2.5 rounded-lg"
        >
          <IconLogout
            size={18}
            stroke={1.5}
            className="text-muted-foreground"
          />
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RecentChatSection({
  currentChatAgentId,
  displayName,
  subagents,
  recentSessions,
  recentSessionsLoading,
  recentSessionsError,
  selectedRecentId,
  onRecentSelect,
  onNewChat,
}: {
  currentChatAgentId: string | null;
  displayName: string;
  subagents: SubagentInfo[];
  recentSessions: ChatThreadListItem[];
  recentSessionsLoading: boolean;
  recentSessionsError: string | null;
  selectedRecentId: string | null;
  onRecentSelect?: (id: string) => void;
  onNewChat?: (agent: { id: string; name: string } | null) => void;
}) {
  const searchOpen = useGet(sidebarSearchOpen$);
  const setSearchOpen = useSet(setSidebarSearchOpen$);
  const searchTerm = useGet(sidebarSearchTerm$);
  const setSearchTerm = useSet(setSidebarSearchTerm$);

  // Filter sessions by current agent
  const subagentIds = new Set(subagents.map((a) => a.id));
  const agentSessions = currentChatAgentId
    ? recentSessions.filter((s) => s.agentComposeId === currentChatAgentId)
    : recentSessions.filter((s) => !subagentIds.has(s.agentComposeId));

  const agentLabel = currentChatAgentId
    ? (subagents.find((a) => a.id === currentChatAgentId)?.displayName ??
      subagents.find((a) => a.id === currentChatAgentId)?.name ??
      displayName)
    : displayName;

  const trimmedTerm = searchTerm.trim().toLowerCase();
  const filteredSessions = trimmedTerm
    ? agentSessions.filter((s) =>
        (s.preview ?? "").toLowerCase().includes(trimmedTerm),
      )
    : agentSessions;

  const handleNewChat = onNewChat
    ? () => {
        const agent = currentChatAgentId
          ? subagents.find((a) => a.id === currentChatAgentId)
          : null;
        onNewChat(agent ?? null);
      }
    : undefined;

  return (
    <div className="mt-4 flex flex-col min-h-0 flex-1">
      {searchOpen ? (
        <div
          className="shrink-0 flex h-8 items-center gap-2 rounded-lg bg-sidebar-accent/60 pl-2 pr-2"
          style={{ border: "0.7px solid hsl(var(--gray-400))" }}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) {
              setSearchOpen(false);
            }
          }}
        >
          <IconSearch
            size={15}
            stroke={2.5}
            className="shrink-0 text-sidebar-foreground/50"
          />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={`Search chat with ${agentLabel}`}
            autoFocus
            className="flex-1 min-w-0 bg-transparent text-sm leading-5 text-sidebar-foreground placeholder:text-sidebar-foreground/50 focus:outline-none"
          />
          <div className="flex h-8 w-8 shrink-0 items-center justify-center">
            <button
              type="button"
              onClick={() => {
                setSearchOpen(false);
              }}
              className="shrink-0 flex items-center justify-center h-5 w-5 rounded text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
              aria-label="Close search"
            >
              <IconX size={12} stroke={2} />
            </button>
          </div>
        </div>
      ) : (
        <div className="zero-nav-recent-label flex h-8 shrink-0 items-center justify-between pl-2 pr-0">
          <span className="text-[13px] leading-4 text-sidebar-foreground/50 font-medium truncate">
            Chats with {agentLabel}
          </span>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
              aria-label="Search chats"
            >
              <IconSearch size={15} stroke={2.5} />
            </button>
            {handleNewChat && (
              <button
                type="button"
                onClick={handleNewChat}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
                aria-label={`New chat with ${agentLabel}`}
              >
                <IconPlus size={15} stroke={2.5} />
              </button>
            )}
          </div>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden mt-1">
        <div className="flex flex-col gap-1">
          {recentSessionsLoading && recentSessions.length === 0 ? (
            <div className="flex items-center justify-center py-3">
              <IconLoader2
                size={14}
                className="animate-spin text-muted-foreground"
              />
            </div>
          ) : recentSessionsError ? (
            <p className="px-2 py-2 text-xs text-destructive">
              {recentSessionsError}
            </p>
          ) : filteredSessions.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground/70 leading-relaxed">
              {searchTerm.trim()
                ? "No chats match your search"
                : "Start a conversation and it'll show up here"}
            </p>
          ) : (
            filteredSessions.map((session) => (
              <Link
                key={session.id}
                pathname="/chat/:sessionId"
                options={{ pathParams: { sessionId: session.id } }}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey) {
                    return;
                  }
                  e.preventDefault();
                  onRecentSelect?.(session.id);
                }}
                className={`flex h-8 items-center gap-2 rounded-lg p-2 text-left text-sm leading-5 transition-colors ${
                  selectedRecentId === session.id
                    ? "bg-sidebar-active text-sidebar-primary font-medium"
                    : "text-sidebar-foreground hover:bg-sidebar-accent"
                }`}
              >
                <span className="truncate min-w-0 flex-1">
                  {session.preview ?? "New chat"}
                </span>
              </Link>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function TalkToSection({
  activeId,
  currentChatAgentId,
  selectedRecentId,
  selectedAgentIdFromChat,
  displayName,
  defaultAgentRawName,
  zeroAvatarSrc,
  pinnedAgents,
  pinnedIds,
  subagents,
  onPinnedIdsChange,
  onNewChat,
}: {
  activeId: ZeroNavId | "chat";
  currentChatAgentId: string | null;
  selectedRecentId: string | null;
  selectedAgentIdFromChat: string | null | undefined;
  displayName: string;
  defaultAgentRawName?: string | null;
  zeroAvatarSrc: string;
  pinnedAgents: SubagentInfo[];
  pinnedIds: string[];
  subagents: SubagentInfo[];
  onPinnedIdsChange: (ids: string[]) => void;
  onNewChat?: (agent: { id: string; name: string } | null) => void;
}) {
  const [chatListOpen, setChatListOpen] = useState(false);

  return (
    <div className="shrink-0 mt-4">
      <div className="flex h-8 items-center justify-between pl-2 pr-0">
        <span className="flex-1 truncate text-[13px] font-medium leading-4 text-sidebar-foreground/50">
          Pinned
        </span>
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setChatListOpen(true)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
                aria-label="Open a conversation"
              >
                <IconPlus size={15} stroke={2.5} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p className="text-xs">Open a conversation</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="flex flex-col gap-0.5 max-h-[170px] overflow-y-auto mt-1">
        {/* Lead agent */}
        {(() => {
          const isPrimarySelected =
            activeId === "chat" &&
            !selectedRecentId &&
            currentChatAgentId === null;
          const isFromChat =
            selectedAgentIdFromChat !== undefined &&
            selectedAgentIdFromChat === null;
          return (
            <Link
              pathname={defaultAgentRawName ? "/talk/:name" : "/"}
              options={
                defaultAgentRawName
                  ? { pathParams: { name: defaultAgentRawName } }
                  : undefined
              }
              className={`flex w-full h-8 shrink-0 items-center gap-2 rounded-lg px-2 text-left text-sm leading-5 no-underline transition-colors duration-200 ${
                isPrimarySelected
                  ? "bg-sidebar-active text-sidebar-primary font-medium"
                  : isFromChat
                    ? "border-l-2 border-[hsl(var(--gray-400))] bg-sidebar-accent/50"
                    : "text-sidebar-foreground hover:bg-sidebar-accent"
              }`}
            >
              <img
                src={zeroAvatarSrc}
                alt={displayName}
                className="h-5 w-5 shrink-0 rounded-md object-cover object-top"
              />
              <span className="truncate">{displayName}</span>
            </Link>
          );
        })()}
        {/* Pinned agents */}
        {pinnedAgents.map((agent) => {
          const isPrimarySelected =
            activeId === "chat" &&
            !selectedRecentId &&
            currentChatAgentId === agent.id;
          const isFromChat = selectedAgentIdFromChat === agent.id;
          return (
            <div key={agent.id} className="group relative">
              <Link
                pathname="/talk/:name"
                options={{ pathParams: { name: agent.name } }}
                className={`flex w-full h-8 shrink-0 items-center gap-2 rounded-lg px-2 text-left text-sm leading-5 no-underline transition-colors duration-200 ${
                  isPrimarySelected
                    ? "bg-sidebar-active text-sidebar-primary font-medium"
                    : isFromChat
                      ? "border-l-2 border-[hsl(var(--gray-400))] bg-sidebar-accent/50"
                      : "text-sidebar-foreground hover:bg-sidebar-accent"
                }`}
              >
                <AgentAvatarImg
                  name={agent.name}
                  alt={agent.displayName ?? agent.name}
                  className="h-5 w-5 shrink-0 rounded-md object-cover object-top"
                />
                <span className="truncate">
                  {agent.displayName ?? agent.name}
                </span>
              </Link>
              <div className="absolute right-0 top-0 flex h-8 w-8 items-center justify-center">
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onPinnedIdsChange(
                            pinnedIds.filter((id) => id !== agent.id),
                          );
                        }}
                        className={`flex h-6 w-6 cursor-pointer items-center justify-center rounded-md invisible group-hover:visible transition-opacity duration-150 ${
                          isPrimarySelected
                            ? "text-sidebar-primary/80 hover:text-white hover:bg-white/20"
                            : "text-sidebar-foreground/80 hover:text-foreground hover:bg-sidebar-foreground/10"
                        }`}
                        aria-label="Remove from list"
                      >
                        <IconX size={12} stroke={2} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      <p className="text-xs">Remove from list</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </div>
          );
        })}
      </div>

      <ChatListDialog
        open={chatListOpen}
        onOpenChange={setChatListOpen}
        zeroAvatarSrc={zeroAvatarSrc}
        displayName={displayName}
        subagents={subagents}
        pinnedIds={pinnedIds}
        onPinnedIdsChange={onPinnedIdsChange}
        onNewChat={onNewChat}
      />
    </div>
  );
}

function SidebarBillingButton() {
  const billingLoadable = useLastLoadable(billingStatusAsync$);
  const billing =
    billingLoadable.state === "hasData" ? billingLoadable.data : null;
  const openBilling = useSet(openBillingDialog$);

  if (!billing) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={() => detach(openBilling(), Reason.DomCallback)}
      className="flex w-full h-8 items-center gap-2 rounded-lg p-2 text-left text-sm leading-5 transition-colors duration-200 text-sidebar-foreground hover:bg-sidebar-accent"
    >
      <IconCrown size={16} className="shrink-0 text-primary" />
      <span className="truncate capitalize">{billing.tier}</span>
      <span className="ml-auto text-xs text-muted-foreground">
        {billing.credits.toLocaleString()}
      </span>
    </button>
  );
}

export function ZeroSidebar() {
  // Read all data from signals directly
  const activeId = useGet(zeroActiveId$);
  const agentNameLoadable = useLastLoadable(agentDisplayName$);
  const agentName =
    agentNameLoadable.state === "hasData" ? agentNameLoadable.data : null;
  const defaultAgentNameLoadable = useLastLoadable(defaultAgentName$);
  const defaultAgentRawName =
    defaultAgentNameLoadable.state === "hasData"
      ? defaultAgentNameLoadable.data
      : null;
  const avatarIndex = useGet(zeroAvatarIndex$);
  const zeroAvatarSrc = ZERO_AVATARS[avatarIndex] ?? ZERO_AVATARS[0];
  const subagentsLoadable = useLastLoadable(zeroSubagents$);
  const subagents: SubagentInfo[] =
    subagentsLoadable.state === "hasData"
      ? subagentsLoadable.data.map((a) => ({
          id: a.id,
          name: a.name,
          displayName: a.displayName,
        }))
      : [];
  const currentChatAgentId = useGet(zeroChatAgentId$);
  const collapsed = useGet(zeroSidebarCollapsed$);
  const setSidebarCollapsed = useSet(setZeroSidebarCollapsed$);
  const onCollapse = () => setSidebarCollapsed(!collapsed);
  const onSelect = useSet(handleZeroNavSelect$);
  const navigateToSession = useSet(navigateToZeroSession$);
  const onRecentSelect = (id: string) => navigateToSession(id);
  const selectedRecentId = useGet(zeroSessionId$);
  const onAccountAction = useSet(handleZeroAccountAction$);
  const recentSessions = useGet(zeroSessionList$);
  const recentSessionsLoading = useGet(zeroSessionListLoading$);
  const recentSessionsError = useGet(zeroSessionListError$);
  const startNewSession = useSet(startNewZeroSession$);
  const navigateTo = useSet(navigateTo$);
  const onNewChat = (agent: { id: string; name: string } | null) => {
    startNewSession();
    if (agent) {
      navigateTo("/talk/:name", { pathParams: { name: agent.name } });
    } else {
      navigateTo("/");
    }
  };
  const displayName = agentName || "Zero";
  const pinnedIdsLoadable = useLastLoadable(pinnedAgentIds$);
  const pinnedIds =
    pinnedIdsLoadable.state === "hasData" ? pinnedIdsLoadable.data : [];
  const savingPinned = useGet(savingPinnedAgents$);
  const savePinnedIds = useSet(updatePinnedAgentIds$);
  const setPinnedIds = (ids: string[]) => {
    detach(savePinnedIds(ids), Reason.DomCallback);
  };
  const managePinnedOpen = useGet(managePinnedDialogOpen$);
  const setManagePinnedOpen = useSet(setManagePinnedDialogOpen$);
  // Billing
  const features = useLastResolved(featureSwitch$);
  const showPricing = features?.[FeatureSwitchKey.Pricing] ?? false;

  // Compute selectedAgentIdFromChat for grey highlight
  const subagentIds = new Set(subagents.map((a) => a.id));
  const selectedAgentIdFromChat: string | null | undefined = selectedRecentId
    ? (() => {
        const thread = recentSessions.find((s) => s.id === selectedRecentId);
        if (!thread) {
          return undefined;
        }
        return subagentIds.has(thread.agentComposeId)
          ? thread.agentComposeId
          : null;
      })()
    : undefined;

  // Pinned agents resolved from IDs
  const pinnedAgents = pinnedIds
    .map((id) => subagents.find((a) => a.id === id))
    .filter((a): a is SubagentInfo => a !== undefined);

  const manageNav = MANAGE_NAV.map((item) => ({
    ...item,
    label: item.label.replace("Zero", displayName),
  }));
  const footerNav = FOOTER_NAV.filter(
    (item) => !item.featureGate || features?.[item.featureGate],
  ).map((item) => ({
    ...item,
    label: item.label.replace("Zero", displayName),
  }));

  const allNavItems = [
    ...manageNav,
    { id: "chat" as const, label: "New chat", icon: IconEdit as NavIcon },
    ...footerNav.map(({ id, label, icon }) => ({ id, label, icon })),
  ];

  if (collapsed) {
    return (
      <VM0ClerkProvider>
        <aside className="zero-nav box-border flex h-full w-16 shrink-0 flex-col border-r-[0.7px] border-sidebar-border bg-sidebar px-2 transition-all duration-300">
          {/* Expand — same row pattern as every nav icon (centered in content column) */}
          <div className="flex w-full shrink-0 justify-center pt-3 pb-1">
            <button
              type="button"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
              onClick={onCollapse}
              aria-label="Expand sidebar"
            >
              <IconLayoutSidebarLeftCollapse size={18} className="rotate-180" />
            </button>
          </div>

          {/* Icon-only nav: one centered column; inline-flex links never stretch */}
          <nav className="flex min-h-0 w-full min-w-0 flex-1 flex-col items-center gap-1 pb-2 pt-0">
            <TooltipProvider delayDuration={100}>
              {allNavItems.map(({ id, label, icon: Icon }) => (
                <div key={id} className="flex w-full shrink-0 justify-center">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Link
                        pathname={
                          id === "chat"
                            ? "/"
                            : id === "team"
                              ? "/team"
                              : "/:tab"
                        }
                        options={
                          id === "chat" || id === "team"
                            ? undefined
                            : { pathParams: { tab: id } }
                        }
                        onClick={(e) => {
                          if (e.metaKey || e.ctrlKey || e.shiftKey) {
                            return;
                          }
                          e.preventDefault();
                          if (id === "chat") {
                            onSelect("chat");
                            onNewChat?.(null);
                          } else {
                            onSelect(id);
                          }
                        }}
                        className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-200 ${
                          activeId === id
                            ? "bg-sidebar-active text-sidebar-primary"
                            : "text-sidebar-foreground hover:bg-sidebar-accent"
                        }`}
                      >
                        <Icon size={16} className="shrink-0" />
                      </Link>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      <p className="text-xs">{label}</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
              ))}
            </TooltipProvider>
          </nav>

          <div className="flex w-full shrink-0 justify-center pb-2 pt-1">
            <AccountDropdown onAccountAction={onAccountAction} collapsed />
          </div>
        </aside>
      </VM0ClerkProvider>
    );
  }

  return (
    <VM0ClerkProvider>
      <aside className="zero-nav flex h-full w-[300px] shrink-0 flex-col border-r-[0.7px] border-sidebar-border bg-sidebar transition-all duration-300 max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:shadow-xl">
        {/* Organization switcher */}
        <div className="shrink-0 px-2 pt-1.5 pb-0">
          <div className="flex items-center justify-between gap-2 rounded-lg py-0.5">
            <div className="min-w-0 flex-1">
              <ClerkOrgSwitcher />
            </div>
            <button
              type="button"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
              onClick={onCollapse}
              aria-label="Collapse sidebar"
            >
              <IconLayoutSidebarLeftCollapse size={18} />
            </button>
          </div>
        </div>

        <nav className="flex-1 flex flex-col min-h-0 overflow-hidden p-2 pt-1">
          {/* Manage section */}
          <div className="shrink-0">
            <div className="flex h-8 items-center pl-2 pr-0">
              <span className="text-[13px] leading-4 text-sidebar-foreground/50 font-medium">
                Manage
              </span>
            </div>
            <div className="flex flex-col gap-1">
              {manageNav.map(({ id, label, icon: Icon }) => (
                <Link
                  key={id}
                  pathname={id === "team" ? "/team" : "/:tab"}
                  options={
                    id === "team" ? undefined : { pathParams: { tab: id } }
                  }
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey) {
                      return;
                    }
                    e.preventDefault();
                    onSelect(id);
                  }}
                  className={`flex w-full h-8 items-center gap-2 rounded-lg p-2 text-left text-sm leading-5 transition-colors duration-200 ${
                    activeId === id
                      ? "bg-sidebar-active text-sidebar-primary font-medium"
                      : "text-sidebar-foreground hover:bg-sidebar-accent"
                  }`}
                >
                  <Icon size={16} className="shrink-0" />
                  <span className="truncate">{label}</span>
                </Link>
              ))}
            </div>
          </div>

          {/* Chat section */}
          <TalkToSection
            activeId={activeId}
            currentChatAgentId={currentChatAgentId}
            selectedRecentId={selectedRecentId}
            selectedAgentIdFromChat={selectedAgentIdFromChat}
            displayName={displayName}
            defaultAgentRawName={defaultAgentRawName}
            zeroAvatarSrc={zeroAvatarSrc}
            pinnedAgents={pinnedAgents}
            pinnedIds={pinnedIds}
            subagents={subagents}
            onPinnedIdsChange={setPinnedIds}
            onNewChat={onNewChat}
          />

          {/* Recent chat sessions */}
          <RecentChatSection
            currentChatAgentId={currentChatAgentId}
            displayName={displayName}
            subagents={subagents}
            recentSessions={recentSessions}
            recentSessionsLoading={recentSessionsLoading}
            recentSessionsError={recentSessionsError}
            selectedRecentId={selectedRecentId}
            onRecentSelect={onRecentSelect}
            onNewChat={onNewChat}
          />
        </nav>

        {/* Footer nav */}
        <div className="p-2">
          <div className="flex flex-col gap-1">
            {showPricing && <SidebarBillingButton />}
            {footerNav.map(({ id, label, icon: Icon, iconImg }) => (
              <Link
                key={id}
                pathname="/:tab"
                options={{ pathParams: { tab: id } }}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey) {
                    return;
                  }
                  e.preventDefault();
                  onSelect(id);
                }}
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
                    className="h-3.5 w-3.5 shrink-0"
                    width={14}
                    height={14}
                  />
                ) : (
                  <Icon size={16} className="shrink-0" />
                )}
                <span className="truncate">{label}</span>
              </Link>
            ))}
            {/* Account dropdown */}
            <AccountDropdown onAccountAction={onAccountAction} />
          </div>
        </div>
      </aside>

      {/* Manage pinned agents dialog */}
      <ManagePinnedAgentsDialog
        open={managePinnedOpen}
        onOpenChange={setManagePinnedOpen}
        zeroAvatarSrc={zeroAvatarSrc}
        displayName={displayName}
        subagents={subagents}
        onPinnedIdsChange={setPinnedIds}
        saving={savingPinned}
      />

      {/* Billing dialog */}
      {showPricing && <BillingDialog />}
    </VM0ClerkProvider>
  );
}
