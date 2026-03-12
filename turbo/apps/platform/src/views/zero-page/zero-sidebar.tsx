import type { ReactNode } from "react";
import { useLoadable, useGet, useSet } from "ccstate-react";
import { useCCState } from "ccstate-react/experimental";
import {
  IconMessageCircle,
  IconRobot,
  IconFile,
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
  IconLoader2,
  IconRefresh,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import type { SessionListItem } from "@vm0/core";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@vm0/ui";
import slackIcon from "../settings-page/icons/slack.svg";
import { clerk$, user$ } from "../../signals/auth.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { VM0ClerkProvider } from "../clerk/clerk-provider.tsx";
import { ClerkOrgSwitcher } from "./clerk-org-switcher.tsx";

export type ZeroNavId =
  | "chat"
  | "meet"
  | "schedule"
  | "job"
  | "production"
  | "activity"
  | "works"
  | "settings"
  | "account";

type NavIcon = (props: { size?: number; className?: string }) => ReactNode;
const MAIN_NAV = [
  { id: "chat", label: "Chat with Zero", icon: IconMessageCircle as NavIcon },
  { id: "meet", label: "Meet Zero", icon: IconRobot as NavIcon },
  { id: "job", label: "Zero's team", icon: IconUsers as NavIcon },
  { id: "schedule", label: "Schedule", icon: IconCalendar as NavIcon },
  { id: "production", label: "Documents", icon: IconFile as NavIcon },
  { id: "activity", label: "Activities", icon: IconChartLine as NavIcon },
] as const;

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
  onSelect: (id: ZeroNavId) => void;
  onRecentSelect?: (id: string) => void;
  selectedRecentId?: string | null;
  onAccountAction?: (action: ZeroAccountAction) => void;
  recentSessions?: SessionListItem[];
  recentSessionsLoading?: boolean;
  recentSessionsError?: string | null;
  onNewChat?: () => void;
  onResetAgent?: () => void;
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
  onResetAgent,
}: {
  activeId: ZeroNavId;
  onAccountAction?: (action: ZeroAccountAction) => void;
  onResetAgent?: () => void;
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
        {onResetAgent && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onResetAgent}
              className="gap-3 px-3 py-2.5 text-amber-500"
            >
              <IconRefresh size={18} stroke={1.5} />
              <span>Reset Default Agent</span>
            </DropdownMenuItem>
          </>
        )}
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

function RecentChatSection({
  recentSessions,
  recentSessionsLoading,
  recentSessionsError,
  selectedRecentId,
  onRecentSelect,
  onNewChat,
}: {
  recentSessions: SessionListItem[];
  recentSessionsLoading: boolean;
  recentSessionsError: string | null;
  selectedRecentId: string | null;
  onRecentSelect?: (id: string) => void;
  onNewChat?: () => void;
}) {
  const searchOpen$ = useCCState(false);
  const searchOpen = useGet(searchOpen$);
  const setSearchOpen = useSet(searchOpen$);
  const searchTerm$ = useCCState("");
  const searchTerm = useGet(searchTerm$);
  const setSearchTerm = useSet(searchTerm$);

  const trimmedTerm = searchTerm.trim().toLowerCase();
  const filteredSessions = trimmedTerm
    ? recentSessions.filter((s) =>
        (s.preview ?? "").toLowerCase().includes(trimmedTerm),
      )
    : recentSessions;

  return (
    <div className="mt-4 flex flex-col min-h-0 flex-1">
      {searchOpen ? (
        <div className="shrink-0 flex items-center gap-2 h-8 rounded-lg p-2 bg-sidebar-accent/50">
          <IconSearch
            size={13}
            stroke={1.5}
            className="shrink-0 text-sidebar-foreground/70"
          />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search chats..."
            autoFocus
            className="flex-1 min-w-0 bg-transparent text-sm leading-5 text-sidebar-foreground placeholder:text-sidebar-foreground/40 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => {
              setSearchOpen(false);
              setSearchTerm("");
            }}
            className="shrink-0 text-sidebar-foreground/50 hover:text-sidebar-foreground transition-colors"
            aria-label="Close search"
          >
            <IconX size={13} stroke={1.5} />
          </button>
        </div>
      ) : (
        <div className="shrink-0 zero-nav-recent-label h-8 flex items-center justify-between px-2">
          <span className="text-xs leading-4 text-sidebar-foreground uppercase tracking-wider">
            recent chat
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="text-sidebar-foreground/60 hover:text-sidebar-foreground transition-colors"
              aria-label="Search chats"
            >
              <IconSearch size={14} />
            </button>
            {onNewChat && (
              <button
                type="button"
                onClick={onNewChat}
                className="text-sidebar-foreground/60 hover:text-sidebar-foreground transition-colors"
                aria-label="New chat"
              >
                <IconPlus size={14} />
              </button>
            )}
          </div>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <div className="flex flex-col gap-1">
          {recentSessionsLoading ? (
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
            <p className="px-2 py-2 text-xs text-muted-foreground">
              {searchTerm.trim() ? "No matching chats" : "No recent chats"}
            </p>
          ) : (
            filteredSessions.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => onRecentSelect?.(session.id)}
                className={`flex h-8 items-center gap-2 rounded-lg p-2 text-left text-sm leading-5 transition-colors ${
                  selectedRecentId === session.id
                    ? "bg-sidebar-active text-sidebar-primary"
                    : "text-sidebar-foreground hover:bg-sidebar-accent"
                }`}
              >
                <span className="truncate min-w-0 flex-1">
                  {session.preview ?? "New chat"}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export function ZeroSidebar({
  activeId,
  agentName,
  onSelect,
  onRecentSelect,
  selectedRecentId = null,
  onAccountAction,
  recentSessions = [],
  recentSessionsLoading = false,
  recentSessionsError = null,
  onNewChat,
  onResetAgent,
}: ZeroSidebarProps) {
  const displayName = agentName || "Zero";
  const mainNav = MAIN_NAV.map((item) => ({
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
        <div className="shrink-0 p-2 pb-1">
          <div className="rounded-lg p-2">
            <ClerkOrgSwitcher />
          </div>
        </div>

        {/* Main nav */}
        <nav className="flex-1 flex flex-col min-h-0 overflow-hidden p-2">
          <div className="shrink-0 flex flex-col gap-1">
            {mainNav.map(({ id, label, icon: Icon }) => {
              const isActive =
                activeId === id && !(id === "chat" && selectedRecentId);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onSelect(id)}
                  className={`flex w-full h-8 items-center gap-2 rounded-lg p-2 text-left text-sm leading-5 transition-colors duration-200 ${
                    isActive
                      ? "bg-sidebar-active text-sidebar-primary font-medium"
                      : "text-sidebar-foreground hover:bg-sidebar-accent"
                  }`}
                >
                  <Icon size={16} className="shrink-0" />
                  <span className="truncate">{label}</span>
                </button>
              );
            })}
          </div>

          {/* Recent chat sessions */}
          <RecentChatSection
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
              onResetAgent={onResetAgent}
            />
          </div>
        </div>
      </aside>
    </VM0ClerkProvider>
  );
}
