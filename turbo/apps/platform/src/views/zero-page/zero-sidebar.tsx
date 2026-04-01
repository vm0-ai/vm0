import { useState, type ReactNode } from "react";
import {
  useLoadable,
  useLastLoadable,
  useLastResolved,
  useGet,
  useSet,
} from "ccstate-react";
import { pageSignal$ } from "../../signals/page-signal.ts";
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
  IconSearch,
  IconX,
  IconEdit,
  IconLayoutSidebarLeftCollapse,
  IconDatabaseExport,
  IconPlug,
  IconTrash,
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
  Button,
} from "@vm0/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@vm0/ui/components/ui/dialog";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import slackIcon from "./components/settings/icons/slack.svg";
import { clerk$, user$ } from "../../signals/auth.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  zeroActiveId$,
  chatThreadId$,
  zeroSidebarCollapsed$,
  setZeroSidebarCollapsed$,
  handleZeroNavSelect$,
  handleZeroAccountAction$,
  navigateToChat$,
  sidebarChatAgentId$,
} from "../../signals/zero-page/zero-nav.ts";
import {
  agentDisplayName$,
  defaultAgentId$,
} from "../../signals/zero-page/zero-agent-name.ts";
import { zeroSubagents$ } from "../../signals/zero-page/zero-agents.ts";
import { reloadAgents$ } from "../../signals/zero-page/agents-list.ts";
import {
  chatThreads$,
  createNewChatThread$,
  creatingNewSession$,
  deleteChatThread$,
} from "../../signals/zero-page/zero-chat.ts";
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
import { ZeroOrgSwitcher } from "./zero-org-switcher.tsx";
import {
  AgentAvatarImg,
  useAgentAvatar,
  type SubagentInfo,
} from "./zero-sidebar-shared.tsx";
import { Link } from "../router/link.tsx";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { apiBaseForNavigation$ } from "../../signals/fetch.ts";
import { billingStatusAsync$ } from "../../signals/zero-page/billing.ts";
import planProImg from "./components/org-manage/assets/plan-pro.webp";
import planTeamImg from "./components/org-manage/assets/plan-team.webp";
import {
  setActiveTab$,
  setBillingSubPage$,
} from "../../signals/zero-page/settings/org-manage-tabs-state.ts";
import { setOrgManageDialogOpen$ } from "../../signals/zero-page/settings/org-manage-dialog.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { slackOrgScopeMismatch$ } from "../../signals/zero-page/zero-slack.ts";
import { BillingDialog } from "./billing-dialog.tsx";
import {
  ChatListDialog,
  ManagePinnedAgentsDialog,
} from "./zero-sidebar-dialogs.tsx";

// Re-export shared types/components for backward compatibility
export { useAgentAvatar } from "./zero-sidebar-shared.tsx";

export type ZeroNavId =
  | "chat"
  | "schedule"
  | "team"
  | "activity"
  | "works"
  | "usage"
  | "preferences"
  | "queue"
  | "connectors"
  | "not-found";

type NavIcon = (props: { size?: number; className?: string }) => ReactNode;
const MANAGE_NAV = [
  { id: "team", label: "Agents", icon: IconUsers as NavIcon },
  { id: "connectors", label: "Connectors", icon: IconPlug as NavIcon },
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
    .filter((s) => {
      return s.status === "active";
    })
    .map((s) => {
      return {
        sessionId: s.id,
        name: s.user?.fullName ?? "User",
        email: s.user?.primaryEmailAddress?.emailAddress ?? "",
        initial: s.user?.fullName
          ? s.user.fullName.charAt(0).toUpperCase()
          : "U",
        imageUrl: s.user?.imageUrl,
        isActive: s.id === currentSessionId,
      };
    });

  return { user, clerk, accounts };
}

export function AccountDropdown({
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

  const current = accounts.find((a) => {
    return a.isActive;
  });
  const others = accounts.filter((a) => {
    return !a.isActive;
  });
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
        beforeEmit: () => {
          return window.location.reload();
        },
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

        {/* Preferences (standalone) */}
        <DropdownMenuItem
          onClick={() => {
            return handleAccountAction("preferences");
          }}
          className="gap-3 px-3 py-2.5 rounded-lg"
        >
          <IconAdjustmentsHorizontal
            size={18}
            stroke={1.5}
            className="text-muted-foreground"
          />
          <span>Preferences</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />

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
            <DropdownMenuSubContent className="w-[220px]">
              {others.map((account) => {
                return (
                  <DropdownMenuItem
                    key={account.sessionId}
                    onClick={() => {
                      return handleSwitchSession(account.sessionId);
                    }}
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
                );
              })}
              <DropdownMenuSeparator />
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
          onClick={() => {
            return handleAccountAction("manage");
          }}
          className="gap-3 px-3 py-2.5 rounded-lg"
        >
          <IconUser size={18} stroke={1.5} className="text-muted-foreground" />
          <span>Manage account</span>
        </DropdownMenuItem>
        {showExportData && (
          <DropdownMenuItem
            onClick={() => {
              return window.open(`${apiBase}/export`, "_blank");
            }}
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
          onClick={() => {
            return handleAccountAction("signout");
          }}
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

function ChatThreadItem({
  session,
  isSelected,
  onSelect,
}: {
  session: ChatThreadListItem;
  isSelected: boolean;
  onSelect?: (id: string) => void;
}) {
  const setDelete = useSet(deleteChatThread$);
  const pageSignal = useGet(pageSignal$);
  const [confirmOpen, setConfirmOpen] = useState(false);

  function handleDeleteClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setConfirmOpen(true);
  }

  function confirmDelete() {
    setConfirmOpen(false);
    detach(setDelete(session.id, pageSignal), Reason.DomCallback);
  }

  return (
    <>
      <div className="group relative">
        <Link
          pathname="/chat/:chatThreadId"
          options={{ pathParams: { chatThreadId: session.id } }}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey) {
              return;
            }
            e.preventDefault();
            onSelect?.(session.id);
          }}
          className={`flex h-8 items-center gap-2 rounded-lg p-2 text-left text-sm leading-5 transition-colors ${
            isSelected
              ? "bg-gray-200 text-gray-900 font-medium"
              : "text-sidebar-foreground hover:bg-sidebar-accent"
          }`}
        >
          <span className="truncate min-w-0 flex-1">
            {session.title ?? "New chat"}
          </span>
        </Link>
        <div className="absolute right-0 top-0 flex h-8 w-8 items-center justify-center">
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleDeleteClick}
                  className={`flex h-6 w-6 cursor-pointer items-center justify-center rounded-md invisible group-hover:visible transition-opacity duration-150 ${
                    isSelected
                      ? "text-slate-500 hover:text-slate-900 hover:bg-slate-300"
                      : "text-sidebar-foreground/80 hover:text-foreground hover:bg-sidebar-foreground/10"
                  }`}
                  aria-label="Delete chat"
                >
                  <IconTrash size={12} stroke={2} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p className="text-xs">Delete chat</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmOpen(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete chat?</DialogTitle>
            <DialogDescription>
              This will permanently delete this chat. This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setConfirmOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
  newChatDisabled,
}: {
  currentChatAgentId: string | null;
  displayName: string;
  subagents: SubagentInfo[];
  recentSessions: ChatThreadListItem[];
  recentSessionsLoading: boolean;
  recentSessionsError: string | null;
  selectedRecentId: string | null;
  onRecentSelect?: (id: string) => void;
  onNewChat?: (agentId: string | null) => void;
  newChatDisabled?: boolean;
}) {
  const searchOpen = useGet(sidebarSearchOpen$);
  const setSearchOpen = useSet(setSidebarSearchOpen$);
  const searchTerm = useGet(sidebarSearchTerm$);
  const setSearchTerm = useSet(setSidebarSearchTerm$);
  const [collapsed, setCollapsed] = useState(false);

  // Filter sessions by current agent
  const subagentIds = new Set(
    subagents.map((a) => {
      return a.id;
    }),
  );
  const agentSessions = currentChatAgentId
    ? recentSessions.filter((s) => {
        return s.agentId === currentChatAgentId;
      })
    : recentSessions.filter((s) => {
        return !subagentIds.has(s.agentId);
      });

  const agentLabel = currentChatAgentId
    ? (subagents.find((a) => {
        return a.id === currentChatAgentId;
      })?.displayName ??
      subagents.find((a) => {
        return a.id === currentChatAgentId;
      })?.id ??
      displayName)
    : displayName;

  const trimmedTerm = searchTerm.trim().toLowerCase();
  const filteredSessions = trimmedTerm
    ? agentSessions.filter((s) => {
        return (s.title ?? "").toLowerCase().includes(trimmedTerm);
      })
    : agentSessions;

  const handleNewChat = onNewChat
    ? () => {
        onNewChat(currentChatAgentId ?? null);
      }
    : undefined;

  return (
    <div className="mt-4 flex flex-col">
      {searchOpen ? (
        <div
          className="shrink-0 flex h-8 items-center gap-2 rounded-lg bg-sidebar-accent/60 pl-2 pr-2 zero-border"
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
            onChange={(e) => {
              return setSearchTerm(e.target.value);
            }}
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
        <div
          className="zero-nav-recent-label group flex h-8 shrink-0 cursor-pointer items-center justify-between rounded-lg pl-2 pr-0 hover:bg-sidebar-accent/50 transition-colors"
          onClick={() => {
            return setCollapsed(!collapsed);
          }}
        >
          <span className="flex flex-1 items-center gap-1 truncate text-[13px] font-medium leading-4 text-sidebar-foreground/50 group-hover:text-sidebar-foreground transition-colors">
            Chats with {agentLabel}
            <span className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
              <IconChevronRight
                size={12}
                stroke={2}
                className={collapsed ? "" : "rotate-90"}
              />
            </span>
          </span>
          <div className="flex items-center gap-0.5">
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSearchOpen(true);
                    }}
                    className="relative z-10 flex h-8 w-8 items-center justify-center rounded-lg text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
                    aria-label="Search chats"
                  >
                    <IconSearch size={15} stroke={2.5} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="text-xs">Search chats</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {handleNewChat && (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleNewChat();
                      }}
                      disabled={newChatDisabled}
                      className="relative z-10 flex h-8 w-8 items-center justify-center rounded-lg text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors disabled:opacity-50 disabled:pointer-events-none"
                      aria-label={`New chat with ${agentLabel}`}
                    >
                      <IconPlus size={15} stroke={2.5} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <p className="text-xs">New chat</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>
      )}
      {!collapsed && (
        <div className="mt-1">
          <div className="flex flex-col gap-1">
            {recentSessionsLoading && recentSessions.length === 0 ? (
              <>
                {["w-3/4", "w-1/2", "w-2/3"].map((w) => {
                  return (
                    <div
                      key={w}
                      className="flex h-8 items-center rounded-lg p-2"
                    >
                      <Skeleton className={`h-4 ${w}`} />
                    </div>
                  );
                })}
              </>
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
              filteredSessions.map((session) => {
                return (
                  <ChatThreadItem
                    key={session.id}
                    session={session}
                    isSelected={selectedRecentId === session.id}
                    onSelect={onRecentSelect}
                  />
                );
              })
            )}
          </div>
        </div>
      )}
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
  zeroAvatarSrc: string | null;
  pinnedAgents: SubagentInfo[];
  pinnedIds: string[];
  subagents: SubagentInfo[];
  onPinnedIdsChange: (ids: string[]) => void;
  onNewChat?: (agentId: string | null) => void;
}) {
  const [chatListOpen, setChatListOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const reloadAgents = useSet(reloadAgents$);

  return (
    <div className="shrink-0">
      <div
        className="group flex h-8 cursor-pointer items-center justify-between rounded-lg pl-2 pr-0 hover:bg-sidebar-accent/50 transition-colors"
        onClick={() => {
          return setCollapsed(!collapsed);
        }}
      >
        <span className="flex flex-1 items-center gap-1 truncate text-[13px] font-medium leading-4 text-sidebar-foreground/50 group-hover:text-sidebar-foreground transition-colors">
          Pinned
          <span className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
            <IconChevronRight
              size={12}
              stroke={2}
              className={collapsed ? "" : "rotate-90"}
            />
          </span>
        </span>
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setChatListOpen(true);
                  reloadAgents();
                }}
                className="relative z-10 flex h-8 w-8 items-center justify-center rounded-lg text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
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
      {!collapsed && (
        <div className="flex flex-col gap-0.5 mt-1">
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
                pathname={defaultAgentRawName ? "/talk/:agentId" : "/"}
                options={
                  defaultAgentRawName
                    ? { pathParams: { agentId: defaultAgentRawName } }
                    : undefined
                }
                className={`flex w-full h-8 shrink-0 items-center gap-2 rounded-lg px-2 text-left text-sm leading-5 no-underline transition-colors duration-200 ${
                  isPrimarySelected
                    ? "bg-gray-200 text-gray-900 font-medium"
                    : isFromChat
                      ? "border-l-2 border-[hsl(var(--gray-400))] bg-sidebar-accent/50"
                      : "text-sidebar-foreground hover:bg-sidebar-accent"
                }`}
              >
                {zeroAvatarSrc ? (
                  <img
                    src={zeroAvatarSrc}
                    alt={displayName}
                    className="h-5 w-5 shrink-0 rounded-md object-cover object-top"
                  />
                ) : (
                  <div
                    className="h-5 w-5 shrink-0 rounded-md bg-muted"
                    aria-hidden
                  />
                )}
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
                  pathname="/talk/:agentId"
                  options={{ pathParams: { agentId: agent.id } }}
                  className={`flex w-full h-8 shrink-0 items-center gap-2 rounded-lg px-2 text-left text-sm leading-5 no-underline transition-colors duration-200 ${
                    isPrimarySelected
                      ? "bg-gray-200 text-gray-900 font-medium"
                      : isFromChat
                        ? "border-l-2 border-[hsl(var(--gray-400))] bg-sidebar-accent/50"
                        : "text-sidebar-foreground hover:bg-sidebar-accent"
                  }`}
                >
                  <AgentAvatarImg
                    name={agent.id}
                    alt={agent.displayName ?? agent.id}
                    className="h-5 w-5 shrink-0 rounded-md object-cover object-top"
                  />
                  <span className="truncate">
                    {agent.displayName ?? agent.id}
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
                              pinnedIds.filter((id) => {
                                return id !== agent.id;
                              }),
                            );
                          }}
                          className={`flex h-6 w-6 cursor-pointer items-center justify-center rounded-md invisible group-hover:visible transition-opacity duration-150 ${
                            isPrimarySelected
                              ? "text-slate-500 hover:text-slate-900 hover:bg-slate-300"
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
      )}

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

/** Overlay scroll area: hides native scrollbar, renders a custom thin indicator. */
function OverlayScrollArea({
  className,
  children,
  onScroll,
  style,
}: {
  className?: string;
  children: ReactNode;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
  style?: React.CSSProperties;
}) {
  const [thumbStyle, setThumbStyle] = useState<{
    top: number;
    height: number;
    visible: boolean;
  }>({ top: 0, height: 0, visible: false });
  const [hovering, setHovering] = useState(false);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    onScroll?.(e);
    const el = e.currentTarget;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight <= clientHeight) {
      setThumbStyle((prev) => {
        return { ...prev, visible: false };
      });
      return;
    }
    const ratio = clientHeight / scrollHeight;
    const thumbH = Math.max(ratio * clientHeight, 24);
    const maxTop = clientHeight - thumbH;
    const top = (scrollTop / (scrollHeight - clientHeight)) * maxTop;
    setThumbStyle({ top, height: thumbH, visible: true });
  };

  const showThumb = thumbStyle.visible && hovering;

  return (
    <div
      className={`relative ${className ?? ""}`}
      onMouseEnter={() => {
        return setHovering(true);
      }}
      onMouseLeave={() => {
        return setHovering(false);
      }}
    >
      <div
        className="h-full overflow-y-auto overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={style}
        onScroll={handleScroll}
      >
        {children}
      </div>
      <div
        className="absolute -right-2 top-0 bottom-0 w-[6px] pointer-events-none"
        aria-hidden="true"
        style={{ opacity: showThumb ? 1 : 0, transition: "opacity 150ms" }}
      >
        <div
          className="absolute right-0 w-[5px] rounded-full bg-foreground/15"
          style={{ top: thumbStyle.top, height: thumbStyle.height }}
        />
      </div>
    </div>
  );
}

function nextTierInfo(tier: string): { label: string; img: string } | null {
  if (tier === "free") {
    return { label: "Pro", img: planProImg };
  }
  if (tier === "pro") {
    return { label: "Team", img: planTeamImg };
  }
  return null;
}

function SidebarUpgradeCard() {
  const pageSignal = useGet(pageSignal$);
  const billingLoadable = useLastLoadable(billingStatusAsync$);
  const billing =
    billingLoadable.state === "hasData" ? billingLoadable.data : null;
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;
  const setTab = useSet(setActiveTab$);
  const setSubPage = useSet(setBillingSubPage$);
  const openManage = useSet(setOrgManageDialogOpen$);

  if (!isAdmin) {
    return null;
  }

  if (!billing) {
    return null;
  }
  const next = nextTierInfo(billing.tier);
  if (!next) {
    return null;
  }

  const handleClick = () => {
    setTab("billing");
    setSubPage(true);
    detach(openManage(true, pageSignal), Reason.DomCallback);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="flex w-full items-center gap-3 rounded-lg p-2.5 text-left transition-colors hover:bg-muted/30 zero-card shadow-[0_1px_2px_hsl(220_12%_20%/0.04),0_4px_12px_hsl(220_12%_20%/0.03)]"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">Get {next.label}</p>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          More credits & active agents
        </p>
      </div>
      <img
        src={next.img}
        alt={next.label}
        className="h-14 w-14 shrink-0 object-contain -my-3"
      />
    </button>
  );
}

export function ZeroSidebar() {
  const [isScrolled, setIsScrolled] = useState(false);

  // Read all data from signals directly
  const activeId = useGet(zeroActiveId$);
  const displayNameLoadable = useLastLoadable(agentDisplayName$);
  const displayNameRaw =
    displayNameLoadable.state === "hasData" ? displayNameLoadable.data : null;
  const defaultAgentIdLoadable = useLastLoadable(defaultAgentId$);
  const defaultAgentRawName =
    defaultAgentIdLoadable.state === "hasData"
      ? defaultAgentIdLoadable.data
      : null;
  const zeroAvatarSrc = useAgentAvatar(defaultAgentRawName ?? "");
  const subagentsLoadable = useLastLoadable(zeroSubagents$);
  const subagents: SubagentInfo[] =
    subagentsLoadable.state === "hasData"
      ? subagentsLoadable.data.map((a) => {
          return {
            id: a.id,
            displayName: a.displayName,
          };
        })
      : [];
  const currentChatAgentId = useGet(sidebarChatAgentId$);
  const collapsed = useGet(zeroSidebarCollapsed$);
  const setSidebarCollapsed = useSet(setZeroSidebarCollapsed$);
  const onCollapse = () => {
    return setSidebarCollapsed(!collapsed);
  };
  const onSelect = useSet(handleZeroNavSelect$);
  const navigateToChat = useSet(navigateToChat$);
  const onRecentSelect = (chatThreadId: string) => {
    return navigateToChat(chatThreadId);
  };
  const selectedRecentId = useGet(chatThreadId$);
  const onAccountAction = useSet(handleZeroAccountAction$);
  const recentSessionsLoadable = useLastLoadable(chatThreads$);
  const recentSessions =
    recentSessionsLoadable.state === "hasData"
      ? recentSessionsLoadable.data
      : [];
  const recentSessionsLoading = recentSessionsLoadable.state === "loading";
  const recentSessionsError =
    recentSessionsLoadable.state === "hasError"
      ? recentSessionsLoadable.error instanceof Error
        ? recentSessionsLoadable.error.message
        : "Failed to load chats"
      : null;
  const createNewChat = useSet(createNewChatThread$);
  const creatingNewSessionLoadable = useLoadable(creatingNewSession$);
  const creatingNewSession = creatingNewSessionLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);
  const onNewChat = (agentId: string | null) => {
    detach(createNewChat(agentId, pageSignal), Reason.DomCallback);
  };
  const displayName = displayNameRaw || "Zero";
  const pinnedIdsLoadable = useLastLoadable(pinnedAgentIds$);
  const pinnedIds: string[] =
    pinnedIdsLoadable.state === "hasData" ? pinnedIdsLoadable.data : [];
  const savingPinned = useGet(savingPinnedAgents$);
  const savePinnedIds = useSet(updatePinnedAgentIds$);
  const setPinnedIds = (ids: string[]) => {
    detach(savePinnedIds(ids, pageSignal), Reason.DomCallback);
  };
  const managePinnedOpen = useGet(managePinnedDialogOpen$);
  const setManagePinnedOpen = useSet(setManagePinnedDialogOpen$);
  // Feature gates
  const features = useLastResolved(featureSwitch$);
  const slackScopeMismatch = useGet(slackOrgScopeMismatch$);

  // Compute selectedAgentIdFromChat for grey highlight
  const subagentIds = new Set(
    subagents.map((a) => {
      return a.id;
    }),
  );
  const selectedAgentIdFromChat: string | null | undefined = selectedRecentId
    ? (() => {
        const thread = recentSessions.find((s) => {
          return s.id === selectedRecentId;
        });
        if (!thread) {
          return undefined;
        }
        return subagentIds.has(thread.agentId) ? thread.agentId : null;
      })()
    : undefined;

  // Pinned agents resolved from IDs
  const pinnedAgents = pinnedIds
    .map((id) => {
      return subagents.find((a) => {
        return a.id === id;
      });
    })
    .filter((a: SubagentInfo | undefined): a is SubagentInfo => {
      return a !== undefined;
    });

  const manageNav = MANAGE_NAV.filter((item) => {
    return (
      item.id !== "activity" || features?.[FeatureSwitchKey.ActivityLogList]
    );
  }).map((item) => {
    return {
      ...item,
      label: item.label.replace("Zero", displayName),
    };
  });
  const footerNav = FOOTER_NAV.filter((item) => {
    return !item.featureGate || features?.[item.featureGate];
  }).map((item) => {
    return {
      ...item,
      label: item.label.replace("Zero", displayName),
    };
  });

  const allNavItems = [
    ...manageNav,
    { id: "chat" as const, label: "New chat", icon: IconEdit as NavIcon },
    ...footerNav.map(({ id, label, icon }) => {
      return { id, label, icon };
    }),
  ];

  if (collapsed) {
    return (
      <VM0ClerkProvider>
        <aside className="zero-nav box-border hidden md:flex h-full w-16 shrink-0 flex-col border-r-[0.7px] border-sidebar-border bg-sidebar px-2 transition-all duration-300">
          {/* Expand — same row pattern as every nav icon (centered in content column) */}
          <div className="flex w-full shrink-0 justify-center pt-3 pb-1">
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
                    onClick={onCollapse}
                    aria-label="Expand sidebar"
                  >
                    <IconLayoutSidebarLeftCollapse
                      size={18}
                      className="rotate-180"
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  <p className="text-xs">Expand sidebar</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>

          {/* Icon-only nav: one centered column; inline-flex links never stretch */}
          <nav className="flex min-h-0 w-full min-w-0 flex-1 flex-col items-center gap-1 pb-2 pt-0">
            <TooltipProvider delayDuration={100}>
              {allNavItems.map(({ id, label, icon: Icon }) => {
                return (
                  <div key={id} className="flex w-full shrink-0 justify-center">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Link
                          pathname={
                            id === "chat"
                              ? "/"
                              : id === "team"
                                ? "/team"
                                : id === "connectors"
                                  ? "/connectors"
                                  : "/:tab"
                          }
                          options={
                            id === "chat" ||
                            id === "team" ||
                            id === "connectors"
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
                              ? "bg-gray-200 text-gray-900"
                              : "text-sidebar-foreground hover:bg-sidebar-accent"
                          }`}
                        >
                          <span className="relative inline-flex">
                            <Icon size={16} className="shrink-0" />
                            {id === "works" && slackScopeMismatch && (
                              <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-red-500" />
                            )}
                          </span>
                        </Link>
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        <p className="text-xs">{label}</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                );
              })}
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
              <ZeroOrgSwitcher />
            </div>
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
                    onClick={onCollapse}
                    aria-label="Collapse sidebar"
                  >
                    <IconLayoutSidebarLeftCollapse size={18} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="text-xs">Collapse sidebar</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
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
              {manageNav.map(({ id, label, icon: Icon }) => {
                return (
                  <Link
                    key={id}
                    pathname={
                      id === "team"
                        ? "/team"
                        : id === "connectors"
                          ? "/connectors"
                          : "/:tab"
                    }
                    options={
                      id === "team" || id === "connectors"
                        ? undefined
                        : { pathParams: { tab: id } }
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
                        ? "bg-gray-200 text-gray-900 font-medium"
                        : "text-sidebar-foreground hover:bg-sidebar-accent"
                    }`}
                  >
                    <Icon size={16} className="shrink-0" />
                    <span className="truncate">{label}</span>
                  </Link>
                );
              })}
            </div>
          </div>

          {/* Scrollable: Pinned + Recent chats */}
          <OverlayScrollArea
            className="flex-1 min-h-0 -mx-2 px-2 mt-2 pt-2"
            onScroll={(e) => {
              return setIsScrolled(e.currentTarget.scrollTop > 0);
            }}
            style={{
              boxShadow: isScrolled
                ? "0 -1px 0 0 hsl(var(--border) / 0.4)"
                : "none",
            }}
          >
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
              newChatDisabled={creatingNewSession}
            />
          </OverlayScrollArea>
        </nav>

        {/* Upgrade card */}
        <div className="px-2">
          <SidebarUpgradeCard />
        </div>

        {/* Footer nav */}
        <div className="p-2">
          <div className="flex flex-col gap-1">
            {footerNav.map(({ id, label, icon: Icon, iconImg }) => {
              return (
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
                      ? "bg-gray-200 text-gray-900 font-medium"
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
                  <span className="truncate flex-1">{label}</span>
                  {id === "works" && slackScopeMismatch && (
                    <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" />
                  )}
                </Link>
              );
            })}
            <div className="h-px bg-border/30 mx-1 my-1" />
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
      <BillingDialog />
    </VM0ClerkProvider>
  );
}
