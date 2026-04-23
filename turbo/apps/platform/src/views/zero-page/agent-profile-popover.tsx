import { useGet, useSet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconMessageCircle,
  IconUser,
  IconCalendar,
  IconShield,
} from "@tabler/icons-react";
import { Popover, PopoverContent, PopoverTrigger } from "@vm0/ui";
import { agents$ } from "../../signals/agent.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { createNewChatThread$ } from "../../signals/chat-page/chat-message.ts";
import { navigateToChat$ } from "../../signals/zero-page/zero-nav.ts";
import { setZeroJobActiveTab$ } from "../../signals/zero-page/job-detail/index.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { AgentAvatarImg } from "./zero-sidebar-shared.tsx";

function useAgentData(agentId: string) {
  const agents = useLastResolved(agents$);
  if (!agentId || !agents) {
    return null;
  }
  const agent = agents.find((a) => {
    return a.id === agentId;
  });
  if (!agent) {
    return null;
  }
  return {
    displayName: agent.displayName ?? "Agent",
    description: agent.description ?? "",
  };
}

const ACTION_CLASS =
  "flex items-center gap-2 w-full px-3 py-2 text-xs text-foreground rounded-md hover:bg-accent transition-colors cursor-pointer";

export function AgentProfilePopover({
  agentId,
  children,
}: {
  agentId: string;
  children: React.ReactNode;
}) {
  const data = useAgentData(agentId);
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createNewChat] = useLoadableSet(createNewChatThread$);
  const navigateToChat = useSet(navigateToChat$);
  const setActiveTab = useSet(setZeroJobActiveTab$);
  const navigate = useSet(detachedNavigateTo$);
  const creating = createLoadable.state === "loading";

  if (!data) {
    return <>{children}</>;
  }

  const handleNewChat = () => {
    detach(
      createNewChat(agentId, pageSignal).then((threadId) => {
        if (threadId) {
          navigateToChat(threadId);
        }
      }),
      Reason.DomCallback,
    );
  };

  const navigateToTab = (tab: string) => {
    setActiveTab(tab);
    navigate("/agents/:agentId", { pathParams: { agentId } });
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-xl"
          aria-label={`View ${data.displayName}'s profile`}
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={8}
        className="w-56 p-0 overflow-hidden"
      >
        <div className="px-4 pt-4 pb-2 flex items-start gap-3">
          <div className="h-11 w-11 shrink-0 rounded-full overflow-hidden">
            <AgentAvatarImg
              name={agentId}
              alt={data.displayName}
              className="h-11 w-11 rounded-full object-cover object-top"
            />
          </div>
          <div className="min-w-0 flex-1 pt-0.5">
            <h3 className="text-sm font-semibold text-foreground truncate">
              {data.displayName}
            </h3>
            {data.description && (
              <p className="text-[11px] text-muted-foreground leading-snug mt-0.5 line-clamp-2">
                {data.description}
              </p>
            )}
          </div>
        </div>

        <div className="border-t border-border px-1.5 py-1.5 flex flex-col">
          <button
            type="button"
            disabled={creating}
            onClick={handleNewChat}
            className={ACTION_CLASS}
          >
            <IconMessageCircle size={14} stroke={1.5} />
            New chat
          </button>
          <button
            type="button"
            onClick={() => {
              navigateToTab("schedule");
            }}
            className={ACTION_CLASS}
          >
            <IconCalendar size={14} stroke={1.5} />
            Schedule
          </button>
          <button
            type="button"
            onClick={() => {
              navigateToTab("authorization");
            }}
            className={ACTION_CLASS}
          >
            <IconShield size={14} stroke={1.5} />
            Connectors
          </button>
          <button
            type="button"
            onClick={() => {
              navigateToTab("profile");
            }}
            className={ACTION_CLASS}
          >
            <IconUser size={14} stroke={1.5} />
            Profile
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
