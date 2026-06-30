// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import type { MouseEvent } from "react";
import {
  useGet,
  useSet,
  useLastResolved,
  useLastLoadable,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconPlus,
  IconChevronRight,
  IconX,
  IconDots,
  IconPinnedOff,
} from "@tabler/icons-react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@vm0/ui";
import {
  isChatRoute,
  setSidebarExpanded$,
} from "../../signals/zero-page/zero-nav.ts";
import { activeRoute$ } from "../../signals/active-route.ts";
import { currentChatAgentId$ } from "../../signals/agent-chat.ts";
import { pathParams$ } from "../../signals/route.ts";
import {
  chatListOpen$,
  setChatListOpen$,
  agentCardCollapsed$,
  setAgentCardCollapsed$,
} from "../../signals/zero-page/zero-sidebar-state.ts";
import {
  reloadAgents$,
  subagents$,
  defaultAgentId$,
  defaultAgentName$,
} from "../../signals/agent.ts";
import {
  pinnedAgentIds$,
  updatePinnedAgentIds$,
  pinnedAgents$,
} from "../../signals/zero-page/zero-pinned-agents.ts";
import { unreadAgentIds$ } from "../../signals/chat-page/sidebar-unread-threads.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { createNewChatThreadOptimistically$ } from "../../signals/chat-page/optimistic-chat-thread-page.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { AgentAvatarImg } from "./zero-sidebar-shared.tsx";
import { Link } from "../router/link.tsx";
import { AgentListDialog } from "./zero-sidebar-dialogs.tsx";

function UnpinButton({
  agentId,
  isPrimarySelected,
}: {
  agentId: string;
  isPrimarySelected: boolean;
}) {
  const pinnedIds = useLastResolved(pinnedAgentIds$) ?? [];
  const [pinLoadable, savePinnedIds] = useLoadableSet(updatePinnedAgentIds$);
  const savingPinned = pinLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              const next = pinnedIds.filter((id): id is string => {
                return id !== null && id !== agentId;
              });
              detach(savePinnedIds(next, pageSignal), Reason.DomCallback);
            }}
            disabled={savingPinned}
            className={`flex h-6 w-6 cursor-pointer items-center justify-center rounded-md invisible group-hover:visible transition-opacity duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${
              isPrimarySelected
                ? "text-sidebar-foreground/80 hover:text-foreground hover:bg-[hsl(var(--gray-300))]"
                : "text-sidebar-foreground/80 hover:text-foreground hover:bg-[hsl(var(--gray-200))]"
            }`}
            aria-label="Unpin"
          >
            <IconX size={12} stroke={2} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          <p className="text-xs">Unpin</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function AgentUnreadIndicator() {
  return (
    <span aria-label="Unread" className="h-2 w-2 rounded-full bg-sky-600" />
  );
}

function PinnedAgentMenu({
  agentId,
  isPrimarySelected,
}: {
  agentId: string;
  isPrimarySelected: boolean;
}) {
  const pinnedIds = useLastResolved(pinnedAgentIds$) ?? [];
  const [pinLoadable, savePinnedIds] = useLoadableSet(updatePinnedAgentIds$);
  const savingPinned = pinLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);

  function unpinAgent() {
    const next = pinnedIds.filter((id): id is string => {
      return id !== null && id !== agentId;
    });
    detach(savePinnedIds(next, pageSignal), Reason.DomCallback);
  }

  function handleMenuTriggerClick(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  return (
    <TooltipProvider delayDuration={200}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            onClick={handleMenuTriggerClick}
            disabled={savingPinned}
            className={`peer pointer-events-auto absolute left-1 top-1 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md invisible group-hover:visible data-[state=open]:visible transition-opacity duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${
              isPrimarySelected
                ? "text-sidebar-foreground/80 hover:text-foreground hover:bg-[hsl(var(--gray-300))]"
                : "text-sidebar-foreground/80 hover:text-foreground hover:bg-[hsl(var(--gray-200))]"
            }`}
            aria-label="Open agent menu"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <IconDots size={16} stroke={2} />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p className="text-xs">More</p>
              </TooltipContent>
            </Tooltip>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={unpinAgent} disabled={savingPinned}>
            <IconPinnedOff size={16} stroke={2} className="mr-2" />
            Unpin
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  );
}

function PinnedAgentSideDecorator({
  agentId,
  isDefaultAgent,
  isPrimarySelected,
  hasUnread,
}: {
  agentId: string;
  isDefaultAgent: boolean;
  isPrimarySelected: boolean;
  hasUnread: boolean;
}) {
  if (isDefaultAgent && !hasUnread) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute right-0 top-0 flex h-8 w-8 items-center justify-center">
      {!isDefaultAgent && (
        <PinnedAgentMenu
          agentId={agentId}
          isPrimarySelected={isPrimarySelected}
        />
      )}
      {hasUnread && (
        <span className="flex items-center justify-center group-hover:hidden group-focus-within:hidden peer-data-[state=open]:hidden">
          <AgentUnreadIndicator />
        </span>
      )}
    </div>
  );
}

function AgentListDialogContainer() {
  const open = useGet(chatListOpen$);
  const onOpenChange = useSet(setChatListOpen$);
  const displayNameLoadable = useLastLoadable(defaultAgentName$);
  const displayName =
    displayNameLoadable.state === "hasData"
      ? (displayNameLoadable.data ?? "Zero")
      : "Zero";
  const subagents = useLastResolved(subagents$) ?? [];
  const defaultAgentId = useLastResolved(defaultAgentId$);
  const createNewChat = useSet(createNewChatThreadOptimistically$);
  const setExpanded = useSet(setSidebarExpanded$);
  const rootSignal = useGet(rootSignal$);
  const onNewChat = (agentId: string | null) => {
    const resolvedAgentId = agentId ?? defaultAgentId;
    if (!resolvedAgentId) {
      return;
    }
    detach(
      createNewChat(resolvedAgentId, "main", rootSignal),
      Reason.DomCallback,
    );
    setExpanded(false);
  };
  return (
    <AgentListDialog
      open={open}
      onOpenChange={onOpenChange}
      displayName={displayName}
      subagents={subagents}
      onNewChat={onNewChat}
    />
  );
}

export function PinnedAgentListSection() {
  const activeRoute = useGet(activeRoute$);
  const pathParams = useGet(pathParams$);
  const routeAgentId =
    typeof pathParams?.agentId === "string" ? pathParams.agentId : null;
  const routeThreadId =
    typeof pathParams?.threadId === "string" ? pathParams.threadId : null;
  const sidebarAgentId = useLastResolved(currentChatAgentId$) ?? null;
  const pinnedAgentsLoadable = useLastLoadable(pinnedAgents$);
  const features = useGet(featureSwitch$);
  const agentUnreadIndicatorsEnabled =
    features[FeatureSwitchKey.AgentUnreadIndicators] ?? false;
  const unreadAgentIds = useLastResolved(unreadAgentIds$);

  const setChatListOpenFn = useSet(setChatListOpen$);
  const collapsed = useGet(agentCardCollapsed$);
  const setCollapsed = useSet(setAgentCardCollapsed$);
  const reloadAgents = useSet(reloadAgents$);
  const defaultAgentId = useLastResolved(defaultAgentId$);

  return (
    <div className="shrink-0">
      <div
        className="group flex h-8 cursor-pointer items-center justify-between rounded-lg pl-2 pr-0 hover:bg-sidebar-accent transition-colors"
        data-testid="pinned-section-header"
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
                  setChatListOpenFn(true);
                  reloadAgents();
                }}
                className="relative z-10 flex h-8 w-8 items-center justify-center rounded-lg text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-[hsl(var(--gray-200))] transition-colors"
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
          {pinnedAgentsLoadable.state === "loading" && (
            <>
              <div className="flex h-8 items-center gap-2 px-2">
                <div className="h-5 w-5 shrink-0 rounded-md bg-muted animate-pulse" />
                <div className="h-3 w-20 rounded bg-muted animate-pulse" />
              </div>
              <div className="flex h-8 items-center gap-2 px-2">
                <div className="h-5 w-5 shrink-0 rounded-md bg-muted animate-pulse" />
                <div className="h-3 w-16 rounded bg-muted animate-pulse" />
              </div>
            </>
          )}
          {pinnedAgentsLoadable.state === "hasData" &&
            pinnedAgentsLoadable.data.map((agent) => {
              const selectedAgentId =
                routeAgentId ?? (routeThreadId ? null : sidebarAgentId);
              const isPrimarySelected =
                isChatRoute(activeRoute) && selectedAgentId === agent.id;
              const isFromChat = sidebarAgentId === agent.id;
              const hasUnread = unreadAgentIds?.has(agent.id) ?? false;
              const isDefaultAgent = agent.id === defaultAgentId;
              return (
                <div
                  key={agent.id}
                  className="group relative"
                  data-testid="pinned-agent-card"
                >
                  <Link
                    pathname="/agents/:agentId/chat"
                    options={{ pathParams: { agentId: agent.id } }}
                    className={`flex w-full h-8 shrink-0 items-center gap-2 rounded-lg text-left text-sm leading-5 no-underline transition-colors duration-200 ${
                      agentUnreadIndicatorsEnabled ? "pl-2 pr-8" : "px-2"
                    } ${
                      isPrimarySelected
                        ? "bg-gray-200 text-foreground font-medium"
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
                  {agentUnreadIndicatorsEnabled ? (
                    <PinnedAgentSideDecorator
                      agentId={agent.id}
                      isDefaultAgent={isDefaultAgent}
                      isPrimarySelected={isPrimarySelected}
                      hasUnread={hasUnread}
                    />
                  ) : agent.id !== defaultAgentId ? (
                    <div className="absolute right-0 top-0 flex h-8 w-8 items-center justify-center">
                      <UnpinButton
                        agentId={agent.id}
                        isPrimarySelected={isPrimarySelected}
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
        </div>
      )}

      <AgentListDialogContainer />
    </div>
  );
}
