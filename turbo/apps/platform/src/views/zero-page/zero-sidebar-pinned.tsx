// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
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
  IconPinnedOff,
  IconChecks,
} from "@tabler/icons-react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import {
  isChatRoute,
  setSidebarExpanded$,
} from "../../signals/zero-page/zero-nav.ts";
import { activeRoute$ } from "../../signals/active-route.ts";
import { currentChatAgentId$ } from "../../signals/agent-chat.ts";
import { detachedNavigateTo$, pathParams$ } from "../../signals/route.ts";
import {
  chatListOpen$,
  setChatListOpen$,
  openAgentListDialog$,
  agentCardCollapsed$,
  setAgentCardCollapsed$,
} from "../../signals/zero-page/zero-sidebar-state.ts";
import {
  subagents$,
  defaultAgentId$,
  defaultAgentName$,
} from "../../signals/agent.ts";
import {
  pinnedAgentIds$,
  updatePinnedAgentIds$,
  pinnedAgents$,
} from "../../signals/zero-page/zero-pinned-agents.ts";
import {
  markAgentThreadsRead$,
  unreadAgentIds$,
} from "../../signals/chat-page/sidebar-unread-threads.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { AgentAvatarImg } from "./zero-sidebar-shared.tsx";
import { Link } from "../router/link.tsx";
import { AgentListDialog } from "./zero-sidebar-dialogs.tsx";
import { AgentRowSideActions } from "./zero-sidebar-agent-row-actions.tsx";

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
  const pinnedIds = useLastResolved(pinnedAgentIds$) ?? [];
  const [pinLoadable, savePinnedIds] = useLoadableSet(updatePinnedAgentIds$);
  const [markReadLoadable, markAgentThreadsRead] = useLoadableSet(
    markAgentThreadsRead$,
  );
  const savingPinned = pinLoadable.state === "loading";
  const markingRead = markReadLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);

  function unpinAgent() {
    const next = pinnedIds.filter((id): id is string => {
      return id !== null && id !== agentId;
    });
    detach(savePinnedIds(next, pageSignal), Reason.DomCallback);
  }

  function markAllRead() {
    detach(
      markAgentThreadsRead(agentId, pageSignal),
      Reason.DomCallback,
      "markAgentThreadsRead",
    );
  }

  const actions = [
    ...(hasUnread
      ? [
          {
            label: "Mark all read",
            disabled: markingRead,
            icon: <IconChecks size={16} stroke={2} />,
            onSelect: markAllRead,
          },
        ]
      : []),
    ...(!isDefaultAgent
      ? [
          {
            label: "Unpin",
            disabled: savingPinned,
            icon: <IconPinnedOff size={16} stroke={2} />,
            onSelect: unpinAgent,
          },
        ]
      : []),
  ];

  return (
    <AgentRowSideActions
      variant="sidebar"
      isPrimarySelected={isPrimarySelected}
      hasUnread={hasUnread}
      actions={actions}
    />
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
  const navigate = useSet(detachedNavigateTo$);
  const setExpanded = useSet(setSidebarExpanded$);
  const openAgentChat = (agentId: string | null) => {
    const resolvedAgentId = agentId ?? defaultAgentId;
    if (!resolvedAgentId) {
      return;
    }
    navigate("/agents/:agentId/chat", {
      pathParams: { agentId: resolvedAgentId },
    });
    setExpanded(false);
  };
  return (
    <AgentListDialog
      open={open}
      onOpenChange={onOpenChange}
      displayName={displayName}
      subagents={subagents}
      onSelectChatAgent={openAgentChat}
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

  const openAgentListDialog = useSet(openAgentListDialog$);
  const collapsed = useGet(agentCardCollapsed$);
  const setCollapsed = useSet(setAgentCardCollapsed$);
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
                  openAgentListDialog();
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
              const hasUnreadIndicator =
                agentUnreadIndicatorsEnabled && hasUnread;
              const hasSideActions = !isDefaultAgent || hasUnreadIndicator;
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
                      hasSideActions ? "pl-2 pr-8" : "px-2"
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
                  {hasSideActions ? (
                    <PinnedAgentSideDecorator
                      agentId={agent.id}
                      isDefaultAgent={isDefaultAgent}
                      isPrimarySelected={isPrimarySelected}
                      hasUnread={hasUnreadIndicator}
                    />
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
