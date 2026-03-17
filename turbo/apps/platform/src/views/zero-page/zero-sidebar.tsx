import type { ReactNode } from "react";
import { useLoadable, useLastLoadable, useGet, useSet } from "ccstate-react";
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
  IconLoader2,
  IconRefresh,
  IconSearch,
  IconX,
  IconEdit,
  IconGripVertical,
  IconChevronDown,
  IconLayoutSidebarLeftCollapse,
} from "@tabler/icons-react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  cn,
  Button,
} from "@vm0/ui";
import slackIcon from "../settings-page/icons/slack.svg";
import { clerk$, user$ } from "../../signals/auth.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  pinnedAgentIds$,
  savingPinnedAgents$,
  updatePinnedAgentIds$,
} from "../../signals/zero-page/zero-pinned-agents.ts";
import { VM0ClerkProvider } from "../clerk/clerk-provider.tsx";
import { ClerkOrgSwitcher } from "./clerk-org-switcher.tsx";
import { agentAvatarOverrides$ } from "../../signals/zero-page/zero-agent-avatars.ts";
import { Link, SimpleLink } from "../router/link.tsx";

/** Max pinned sub-agents (default agent counts as 1, total slots = 5). */
const MAX_PINNED = 4;

export const AGENT_AVATARS = [
  "/avatars/avatar-1.png",
  "/avatars/avatar-2.png",
  "/avatars/avatar-3.png",
  "/avatars/avatar-4.png",
] as const;

function getAgentAvatar(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return AGENT_AVATARS[Math.abs(hash) % AGENT_AVATARS.length];
}

/**
 * Reactive hook that returns the agent avatar, respecting any user override.
 */
export function useAgentAvatar(name: string): string {
  const overrides = useGet(agentAvatarOverrides$);
  return overrides[name] ?? getAgentAvatar(name);
}

/** Reactive avatar image that respects user overrides. */
function AgentAvatarImg({
  name,
  alt,
  className,
}: {
  name: string;
  alt: string;
  className: string;
}) {
  const src = useAgentAvatar(name);
  return <img src={src} alt={alt} className={className} />;
}

export interface SubagentInfo {
  id: string;
  name: string;
  displayName?: string | null;
}

export type ZeroNavId =
  | "chat"
  | "meet"
  | "schedule"
  | "team"
  | "activity"
  | "works"
  | "settings"
  | "preferences";

type NavIcon = (props: { size?: number; className?: string }) => ReactNode;
const MANAGE_NAV = [
  { id: "team", label: "Zero's team", icon: IconUsers as NavIcon },
  { id: "schedule", label: "Scheduled", icon: IconCalendar as NavIcon },
  { id: "activity", label: "Activity logs", icon: IconChartLine as NavIcon },
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
  subagents?: SubagentInfo[];
  currentChatAgentId?: string | null;
  collapsed?: boolean;
  onCollapse?: () => void;
  onSelect: (id: ZeroNavId) => void;
  onRecentSelect?: (id: string) => void;
  selectedRecentId?: string | null;
  onAccountAction?: (action: ZeroAccountAction) => void;
  recentSessions?: SessionListItem[];
  recentSessionsLoading?: boolean;
  recentSessionsError?: string | null;
  onNewChat?: (agentId: string | null) => void;
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
  onAccountAction,
  onResetAgent,
  collapsed = false,
}: {
  onAccountAction?: (action: ZeroAccountAction) => void;
  onResetAgent?: () => void;
  collapsed?: boolean;
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
          className={`flex items-center rounded-lg transition-colors duration-200 ${
            collapsed
              ? "justify-center p-2 h-10 w-10"
              : "w-full gap-2 p-2 text-left hover:bg-sidebar-accent/50"
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

        {/* Switch account sub-menu or Add account */}
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
}: {
  recentSessions: SessionListItem[];
  recentSessionsLoading: boolean;
  recentSessionsError: string | null;
  selectedRecentId: string | null;
  onRecentSelect?: (id: string) => void;
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
        <div
          className="shrink-0 flex items-center gap-2 h-8 rounded-lg px-2.5 bg-sidebar-accent/60"
          style={{ border: "0.7px solid hsl(var(--gray-400))" }}
        >
          <IconSearch
            size={14}
            stroke={1.5}
            className="shrink-0 text-sidebar-foreground/50"
          />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search chats..."
            autoFocus
            className="flex-1 min-w-0 bg-transparent text-sm leading-5 text-sidebar-foreground placeholder:text-sidebar-foreground/50 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => {
              setSearchOpen(false);
              setSearchTerm("");
            }}
            className="shrink-0 flex items-center justify-center h-5 w-5 rounded text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
            aria-label="Close search"
          >
            <IconX size={13} stroke={1.5} />
          </button>
        </div>
      ) : (
        <div className="shrink-0 zero-nav-recent-label h-7 flex items-center justify-between pl-2 pr-1">
          <span className="text-[13px] leading-4 text-sidebar-foreground/50 font-medium">
            Recent chat
          </span>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
              aria-label="Search chats"
            >
              <IconSearch size={16} />
            </button>
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
            <p className="px-2 py-2 text-xs text-muted-foreground/70 leading-relaxed">
              {searchTerm.trim()
                ? "No chats match your search"
                : "Start a conversation and it'll show up here"}
            </p>
          ) : (
            filteredSessions.map((session) => (
              <SimpleLink
                key={session.id}
                href={`/zero/chat/${session.id}`}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey) {
                    return;
                  }
                  e.preventDefault();
                  onRecentSelect?.(session.id);
                }}
                className={`flex h-8 items-center gap-2 rounded-lg p-2 text-left text-sm leading-5 transition-colors ${
                  selectedRecentId === session.id
                    ? "bg-sidebar-active text-sidebar-primary"
                    : "text-sidebar-foreground hover:bg-sidebar-accent"
                }`}
              >
                <span className="truncate min-w-0 flex-1">
                  {session.preview ?? "New chat"}
                </span>
              </SimpleLink>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function SortablePinnedAgent({
  agent,
  onUnpin,
}: {
  agent: SubagentInfo;
  onUnpin: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id: agent.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 px-1 py-2 rounded-lg hover:bg-muted/50 transition-colors group"
    >
      <button
        type="button"
        className="shrink-0 flex items-center justify-center cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground transition-colors touch-none"
        {...attributes}
        {...listeners}
      >
        <IconGripVertical size={14} />
      </button>
      <AgentAvatarImg
        name={agent.name}
        alt={agent.displayName ?? agent.name}
        className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
      />
      <span className="text-sm text-foreground flex-1 truncate">
        {agent.displayName ?? agent.name}
      </span>
      <button
        type="button"
        className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md transition-colors p-1"
        onClick={onUnpin}
        aria-label={`Unpin ${agent.displayName ?? agent.name}`}
      >
        <IconX size={14} />
      </button>
    </div>
  );
}

function ManagePinnedAgentsDialog({
  open,
  onOpenChange,
  zeroAvatarSrc,
  displayName,
  subagents,
  pinnedIds,
  onPinnedIdsChange,
  saving = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  saving?: boolean;
  zeroAvatarSrc: string;
  displayName: string;
  subagents: SubagentInfo[];
  pinnedIds: string[];
  onPinnedIdsChange: (ids: string[]) => void;
}) {
  const orderedPinned = pinnedIds
    .map((id) => subagents.find((a) => a.id === id))
    .filter((a): a is SubagentInfo => a !== undefined);

  const unpinned = subagents.filter((a) => !pinnedIds.includes(a.id));

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }
    const oldIndex = pinnedIds.indexOf(String(active.id));
    const newIndex = pinnedIds.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) {
      return;
    }
    const next = [...pinnedIds];
    next.splice(oldIndex, 1);
    next.splice(newIndex, 0, pinnedIds[oldIndex]!);
    onPinnedIdsChange(next);
  };

  const togglePin = (agentId: string) => {
    if (pinnedIds.includes(agentId)) {
      onPinnedIdsChange(pinnedIds.filter((id) => id !== agentId));
    } else if (pinnedIds.length < MAX_PINNED) {
      onPinnedIdsChange([...pinnedIds, agentId]);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px] p-0 gap-0">
        <DialogHeader className="px-5 pt-5 pb-3">
          <div className="flex items-center gap-2">
            <DialogTitle className="text-base font-semibold">
              Manage pinned agents
            </DialogTitle>
            {saving && (
              <IconLoader2
                size={14}
                className="animate-spin text-muted-foreground"
              />
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Reorder or add agents to your sidebar (max {MAX_PINNED}).
          </p>
        </DialogHeader>

        <div className="px-5 pb-1">
          <div className="flex items-center gap-2 px-1 py-2.5 rounded-lg">
            <img
              src={zeroAvatarSrc}
              alt={displayName}
              className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
            />
            <span className="text-sm font-medium text-foreground flex-1 truncate">
              {displayName}
            </span>
            <span className="text-[11px] text-muted-foreground/60 mr-0.5">
              Lead
            </span>
          </div>
        </div>

        {orderedPinned.length > 0 && (
          <div className="px-5 pb-1">
            <span className="text-xs font-medium text-muted-foreground px-1">
              Pinned
            </span>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={orderedPinned.map((a) => a.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="flex flex-col mt-1">
                  {orderedPinned.map((agent) => (
                    <SortablePinnedAgent
                      key={agent.id}
                      agent={agent}
                      onUnpin={() => togglePin(agent.id)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </div>
        )}

        {unpinned.length > 0 && (
          <div className="px-5 pb-5">
            <span className="text-xs font-medium text-muted-foreground px-1">
              Available agents
            </span>
            <div className="flex flex-col mt-1">
              {unpinned.map((agent) => (
                <div
                  key={agent.id}
                  className="flex items-center gap-2 px-1 py-2 rounded-lg hover:bg-muted/50 transition-colors"
                >
                  <AgentAvatarImg
                    name={agent.name}
                    alt={agent.displayName ?? agent.name}
                    className="h-8 w-8 shrink-0 rounded-lg object-cover object-top opacity-60"
                  />
                  <span className="text-sm text-muted-foreground flex-1 truncate">
                    {agent.displayName ?? agent.name}
                  </span>
                  <button
                    type="button"
                    className={cn(
                      "transition-colors px-2 py-0.5 rounded-md text-xs font-medium",
                      pinnedIds.length >= MAX_PINNED
                        ? "text-muted-foreground/30 cursor-not-allowed"
                        : "text-primary hover:text-primary/80 hover:bg-primary/10",
                    )}
                    onClick={() => togglePin(agent.id)}
                    disabled={pinnedIds.length >= MAX_PINNED}
                  >
                    Pin
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {subagents.length === 0 && (
          <div className="px-5 pb-5">
            <p className="text-xs text-muted-foreground px-1 py-2">
              No sub-agents available yet.
            </p>
          </div>
        )}

        <div className="px-5 pb-5 pt-2">
          <Button
            className="w-full"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ZeroSidebar({
  activeId,
  agentName,
  zeroAvatarSrc = "/zero-avatar.png",
  subagents = [],
  currentChatAgentId = null,
  collapsed = false,
  onCollapse,
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
  const chatExpanded$ = useCCState(true);
  const chatExpanded = useGet(chatExpanded$);
  const setChatExpanded = useSet(chatExpanded$);
  const pinnedIdsLoadable = useLastLoadable(pinnedAgentIds$);
  const pinnedIds =
    pinnedIdsLoadable.state === "hasData" ? pinnedIdsLoadable.data : [];
  const savingPinned = useGet(savingPinnedAgents$);
  const savePinnedIds = useSet(updatePinnedAgentIds$);
  const setPinnedIds = (ids: string[]) => {
    detach(savePinnedIds(ids), Reason.DomCallback);
  };
  const managePinnedOpen$ = useCCState(false);
  const managePinnedOpen = useGet(managePinnedOpen$);
  const setManagePinnedOpen = useSet(managePinnedOpen$);

  // Resolve the selected agent label
  const selectedAgent = currentChatAgentId
    ? subagents.find((a) => a.id === currentChatAgentId)
    : null;
  const talkToLabel = selectedAgent
    ? (selectedAgent.displayName ?? selectedAgent.name)
    : displayName;

  // Pinned agents resolved from IDs
  const pinnedAgents = pinnedIds
    .map((id) => subagents.find((a) => a.id === id))
    .filter((a): a is SubagentInfo => a !== undefined);

  const manageNav = MANAGE_NAV.map((item) => ({
    ...item,
    label: item.label.replace("Zero", displayName),
  }));
  const footerNav = FOOTER_NAV.map((item) => ({
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
        <aside className="zero-nav flex h-full w-16 shrink-0 flex-col border-r-[0.7px] border-sidebar-border bg-sidebar overflow-hidden transition-all duration-300">
          {/* Expand button */}
          <div className="shrink-0 flex items-center justify-center pt-3 pb-1">
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
              onClick={onCollapse}
              aria-label="Expand sidebar"
            >
              <IconLayoutSidebarLeftCollapse size={18} className="rotate-180" />
            </button>
          </div>

          {/* Icon-only nav */}
          <nav className="flex-1 flex flex-col items-center gap-1 p-2">
            <TooltipProvider delayDuration={100}>
              {allNavItems.map(({ id, label, icon: Icon }) => (
                <Tooltip key={id}>
                  <TooltipTrigger asChild>
                    <Link
                      pathname={id === "chat" ? "/zero" : "/zero/:tab"}
                      options={
                        id === "chat" ? undefined : { pathParams: { tab: id } }
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
                      className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors duration-200 ${
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
              ))}
            </TooltipProvider>
          </nav>

          {/* Account avatar */}
          <div className="p-2 flex justify-center">
            <AccountDropdown
              onAccountAction={onAccountAction}
              onResetAgent={onResetAgent}
              collapsed
            />
          </div>
        </aside>
      </VM0ClerkProvider>
    );
  }

  return (
    <VM0ClerkProvider>
      <aside className="zero-nav flex h-full w-[255px] shrink-0 flex-col border-r-[0.7px] border-sidebar-border bg-sidebar overflow-hidden transition-all duration-300">
        {/* Organization switcher */}
        <div className="shrink-0 px-2 pt-1.5 pb-0">
          <div className="flex items-center justify-between rounded-lg pr-0 py-0.5">
            <div className="flex-1 min-w-0">
              <ClerkOrgSwitcher />
            </div>
            <button
              type="button"
              className="flex h-7 w-7 -mr-[3px] shrink-0 items-center justify-center rounded-lg text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
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
            <div className="h-7 flex items-center pl-2">
              <span className="text-[13px] leading-4 text-sidebar-foreground/50 font-medium">
                Manage
              </span>
            </div>
            <div className="flex flex-col gap-1">
              {manageNav.map(({ id, label, icon: Icon }) => (
                <Link
                  key={id}
                  pathname="/zero/:tab"
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
                  <Icon size={16} className="shrink-0" />
                  <span className="truncate">{label}</span>
                </Link>
              ))}
            </div>
          </div>

          {/* Chat section */}
          <div className="shrink-0 mt-4">
            <button
              type="button"
              className="flex h-7 w-full items-center gap-1 px-2 text-sidebar-foreground/50 hover:text-sidebar-foreground transition-colors"
              onClick={() => setChatExpanded(!chatExpanded)}
            >
              <span className="text-[13px] font-medium truncate">
                Talk to {talkToLabel}
              </span>
              <IconChevronDown
                size={14}
                className={`shrink-0 transition-transform ${chatExpanded ? "" : "-rotate-90"}`}
              />
            </button>
            {chatExpanded && (
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
                  {pinnedAgents.map((agent) => (
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
                          <AgentAvatarImg
                            name={agent.name}
                            alt={agent.displayName ?? agent.name}
                            className="h-full w-full object-cover object-top"
                          />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="text-xs">
                        {agent.displayName ?? agent.name}
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
              <Link
                pathname="/zero"
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey) {
                    return;
                  }
                  e.preventDefault();
                  onSelect("chat");
                }}
                className={`flex w-full h-8 items-center gap-2 rounded-lg p-2 text-left text-sm leading-5 transition-colors duration-200 ${
                  activeId === "chat" && !selectedRecentId
                    ? "bg-sidebar-active text-sidebar-primary font-medium"
                    : "text-sidebar-foreground hover:bg-sidebar-accent"
                }`}
              >
                <IconEdit size={16} className="shrink-0" />
                <span className="truncate">New chat</span>
              </Link>
            </div>
          </div>

          {/* Recent chat sessions */}
          <RecentChatSection
            recentSessions={recentSessions}
            recentSessionsLoading={recentSessionsLoading}
            recentSessionsError={recentSessionsError}
            selectedRecentId={selectedRecentId}
            onRecentSelect={onRecentSelect}
          />
        </nav>

        {/* Footer nav */}
        <div className="p-2">
          <div className="flex flex-col gap-1">
            {footerNav.map(({ id, label, icon: Icon, iconImg }) => (
              <Link
                key={id}
                pathname="/zero/:tab"
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
            <AccountDropdown
              onAccountAction={onAccountAction}
              onResetAgent={onResetAgent}
            />
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
        pinnedIds={pinnedIds}
        onPinnedIdsChange={setPinnedIds}
        saving={savingPinned}
      />
    </VM0ClerkProvider>
  );
}
