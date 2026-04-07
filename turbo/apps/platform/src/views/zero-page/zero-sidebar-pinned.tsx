import { useGet, useSet } from "ccstate-react";
import { IconPlus, IconChevronRight, IconX } from "@tabler/icons-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import { isChatRoute } from "../../signals/zero-page/zero-nav.ts";
import type { RouteKey } from "../../signals/route-paths.ts";
import { reloadAgents$ } from "../../signals/zero-page/agents-list.ts";
import {
  chatListOpen$,
  setChatListOpen$,
  agentCardCollapsed$,
  setAgentCardCollapsed$,
} from "../../signals/zero-page/zero-sidebar-state.ts";
import { AgentAvatarImg, type SubagentInfo } from "./zero-sidebar-shared.tsx";
import { Link } from "../router/link.tsx";
import { ChatListDialog } from "./zero-sidebar-dialogs.tsx";

export function TalkToSection({
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
  activeId: RouteKey | null;
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
  const chatListOpen = useGet(chatListOpen$);
  const setChatListOpenFn = useSet(setChatListOpen$);
  const collapsed = useGet(agentCardCollapsed$);
  const setCollapsed = useSet(setAgentCardCollapsed$);
  const reloadAgents = useSet(reloadAgents$);

  return (
    <div className="shrink-0">
      <div
        className="group flex h-8 cursor-pointer items-center justify-between rounded-lg pl-2 pr-0 hover:bg-sidebar-accent/50 transition-colors"
        data-testid="pinned-section-header"
        onPointerDown={() => {
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
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setChatListOpenFn(true);
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
              isChatRoute(activeId) &&
              !selectedRecentId &&
              currentChatAgentId === null;
            const isFromChat =
              selectedAgentIdFromChat !== undefined &&
              selectedAgentIdFromChat === null;
            return (
              <Link
                pathname={defaultAgentRawName ? "/agents/:id/chat" : "/"}
                options={
                  defaultAgentRawName
                    ? { pathParams: { id: defaultAgentRawName } }
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
              isChatRoute(activeId) &&
              !selectedRecentId &&
              currentChatAgentId === agent.id;
            const isFromChat = selectedAgentIdFromChat === agent.id;
            return (
              <div
                key={agent.id}
                className="group relative"
                data-testid="pinned-agent-card"
              >
                <Link
                  pathname="/agents/:id/chat"
                  options={{ pathParams: { id: agent.id } }}
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
                          onPointerDown={(e) => {
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
        onOpenChange={setChatListOpenFn}
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
