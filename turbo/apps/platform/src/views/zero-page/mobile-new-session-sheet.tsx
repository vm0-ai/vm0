import { useGet, useLastResolved, useSet } from "ccstate-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@vm0/ui";
import { sortedAgents$ } from "../../signals/agent.ts";
import {
  setChatAgentId$,
} from "../../signals/agent-chat.ts";
import { createNewChatThreadOptimistically$ } from "../../signals/chat-page/optimistic-chat-thread-page.ts";
import {
  mobileNewSessionSheetOpen$,
  setMobileNewSessionSheetOpen$,
} from "../../signals/zero-page/zero-nav.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { AvatarFromUrl } from "./zero-sidebar-shared.tsx";

/**
 * Bottom sheet for picking which agent to start a fresh chat with. Lives
 * behind the top-bar [+] icon on the Home (chat list) tab. Tapping an agent
 * row scopes the chat list to that agent and creates an optimistic new
 * thread, which routes to /chats/:threadId.
 */
export function MobileNewSessionSheet() {
  const open = useGet(mobileNewSessionSheetOpen$);
  const setOpen = useSet(setMobileNewSessionSheetOpen$);
  const agents = useLastResolved(sortedAgents$) ?? [];
  const setAgentId = useSet(setChatAgentId$);
  const createNewChat = useSet(createNewChatThreadOptimistically$);
  const rootSignal = useGet(rootSignal$);

  const onPick = (agentId: string) => {
    setOpen(false);
    setAgentId(agentId);
    detach(
      createNewChat(agentId, "main", rootSignal),
      Reason.DomCallback,
    );
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="bottom"
        hideClose
        className="rounded-t-2xl max-h-[75vh] overflow-y-auto p-0 shadow-[0_-12px_32px_-12px_rgba(0,0,0,0.18)] dark:shadow-[0_-16px_48px_-12px_rgba(0,0,0,0.55)]"
        data-testid="mobile-new-session-sheet"
      >
        <SheetHeader className="px-4 pt-2.5 pb-2">
          <div className="flex justify-center pb-3">
            <span
              aria-hidden
              className="h-1 w-10 rounded-full bg-[hsl(var(--gray-300))]"
            />
          </div>
          <SheetTitle className="text-[17px] font-semibold">
            Start a new chat
          </SheetTitle>
          <SheetDescription className="text-[15px]">
            Pick the agent you want to talk to.
          </SheetDescription>
        </SheetHeader>
        <ul className="flex flex-col gap-1 px-2 pb-6">
          {agents.map((agent) => {
            const label = agent.displayName ?? "Agent";
            return (
              <li key={agent.id}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(agent.id);
                  }}
                  data-testid={`mobile-new-session-${agent.id}`}
                  className="flex w-full items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-muted text-left transition-colors"
                >
                  <AvatarFromUrl
                    avatarUrl={agent.avatarUrl}
                    alt=""
                    className="h-9 w-9 shrink-0 rounded-full object-cover object-top"
                  />
                  <span className="min-w-0 flex-1 truncate text-[17px] font-medium">
                    {label}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </SheetContent>
    </Sheet>
  );
}
