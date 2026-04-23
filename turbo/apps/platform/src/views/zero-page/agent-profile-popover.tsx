import { useGet, useSet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { IconMessageCircle, IconUser } from "@tabler/icons-react";
import { Popover, PopoverContent, PopoverTrigger } from "@vm0/ui";
import { agents$ } from "../../signals/agent.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { createNewChatThread$ } from "../../signals/chat-page/chat-message.ts";
import { navigateToChat$ } from "../../signals/zero-page/zero-nav.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { AgentAvatarImg } from "./zero-sidebar-shared.tsx";
import { toneLabel, type Tone } from "./zero-tone-constants.ts";
import { Link } from "../router/link.tsx";

function resolveSound(raw: string | null | undefined): Tone {
  if (raw === "friendly" || raw === "direct" || raw === "supportive") {
    return raw;
  }
  return "professional";
}

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
    tone: resolveSound(agent.sound),
  };
}

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
        className="w-64 p-0 overflow-hidden"
      >
        <div className="px-4 pt-4 pb-3 flex items-start gap-3">
          <div className="h-12 w-12 shrink-0 rounded-full overflow-hidden">
            <AgentAvatarImg
              name={agentId}
              alt={data.displayName}
              className="h-12 w-12 rounded-full object-cover object-top"
            />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-foreground truncate">
              {data.displayName}
            </h3>
            <span className="inline-flex items-center gap-1 mt-0.5 text-xs text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
              Online
            </span>
          </div>
        </div>

        {data.description && (
          <div className="px-4 pb-3">
            <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
              {data.description}
            </p>
          </div>
        )}

        <div className="px-4 pb-3">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-medium text-foreground/70">Tone:</span>
            {toneLabel(data.tone)}
          </div>
        </div>

        <div className="border-t border-border px-3 py-2.5 flex gap-2">
          <button
            type="button"
            disabled={creating}
            onClick={handleNewChat}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <IconMessageCircle size={13} stroke={2} />
            New chat
          </button>
          <Link
            pathname="/agents/:agentId"
            options={{ pathParams: { agentId } }}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border text-foreground hover:bg-accent transition-colors"
          >
            <IconUser size={13} stroke={2} />
            Profile
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
