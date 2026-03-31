import { useSet, useLastLoadable } from "ccstate-react";
import { SidebarLayout } from "./sidebar-layout.tsx";
import { ZeroChatPage } from "./zero-chat-page.tsx";
import { useAgentAvatar } from "./zero-sidebar.tsx";
import { zeroChatAgentId$ } from "../../signals/zero-page/zero-active-agent.ts";
import { zeroSubagents$ } from "../../signals/zero-page/zero-agents.ts";
import {
  agentDisplayName$,
  defaultAgentId$,
} from "../../signals/zero-page/zero-agent-name.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import {
  resetTalkSendSignal$,
  sendNewThreadMessage$,
  startNewZeroSession$,
} from "../../signals/zero-page/zero-chat.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function ZeroTalkPage() {
  const chatAgentLoadable = useLastLoadable(zeroChatAgentId$);
  const currentChatAgentId =
    chatAgentLoadable.state === "hasData" ? chatAgentLoadable.data : null;
  const subagentsLoadable = useLastLoadable(zeroSubagents$);
  const subagents =
    subagentsLoadable.state === "hasData" ? subagentsLoadable.data : [];
  const selectedSubagent = currentChatAgentId
    ? subagents.find((a) => a.id === currentChatAgentId)
    : null;

  const defaultAgentIdLoadable = useLastLoadable(defaultAgentId$);
  const defaultRawName =
    defaultAgentIdLoadable.state === "hasData"
      ? defaultAgentIdLoadable.data
      : null;
  const resolvedAgentId = selectedSubagent?.id ?? defaultRawName;
  const chatAvatarSrc = useAgentAvatar(resolvedAgentId ?? "");

  const agentDisplayNameLoadable = useLastLoadable(agentDisplayName$);
  const agentDisplayName =
    agentDisplayNameLoadable.state === "hasData"
      ? agentDisplayNameLoadable.data
      : "Zero";
  const chatAgentName = selectedSubagent
    ? (selectedSubagent.displayName ?? selectedSubagent.id)
    : agentDisplayName;

  const navigateTo = useSet(detachedNavigateTo$);
  const sendNewThread = useSet(sendNewThreadMessage$);
  const startNewSession = useSet(startNewZeroSession$);
  const resetTalkSendSignal = useSet(resetTalkSendSignal$);

  const handleNavigateToMeet = (tab?: string) => {
    if (resolvedAgentId) {
      const searchParams = tab ? new URLSearchParams({ tab }) : undefined;
      navigateTo("/team/:agentId", {
        pathParams: { agentId: resolvedAgentId },
        searchParams,
      });
    }
  };

  const handleSendMessage = (
    message: string,
    options?: { modelProvider?: string },
  ) => {
    if (!resolvedAgentId) {
      return;
    }
    startNewSession();
    // Use a dedicated reset signal instead of pageSignal because the send
    // flow navigates from /talk/ to /chat/:chatThreadId, which would abort the
    // page signal.  resetTalkSendSignal$ is reset by startNewZeroSession$
    // above, so each send gets a fresh signal and previous sends are aborted.
    const talkSignal = resetTalkSendSignal();
    detach(
      sendNewThread(resolvedAgentId, message, options, talkSignal),
      Reason.DomCallback,
    );
  };

  return (
    <SidebarLayout>
      <ZeroChatPage
        onSendMessage={handleSendMessage}
        onNavigateToMeet={handleNavigateToMeet}
        zeroAvatarSrc={chatAvatarSrc}
        chatAgentName={chatAgentName}
        avatarAgentId={resolvedAgentId ?? undefined}
      />
    </SidebarLayout>
  );
}
