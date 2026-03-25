import { useGet, useSet, useLastLoadable } from "ccstate-react";
import { SidebarLayout } from "./sidebar-layout.tsx";
import { ZeroChatPage } from "./zero-chat-page.tsx";
import { useAgentAvatar } from "./zero-sidebar.tsx";
import {
  zeroChatAgentId$,
  zeroAvatarIndex$,
} from "../../signals/zero-page/zero-nav.ts";
import { zeroSubagents$ } from "../../signals/zero-page/zero-agents.ts";
import {
  agentDisplayName$,
  defaultAgentId$,
} from "../../signals/zero-page/zero-agent-name.ts";
import { navigateTo$ } from "../../signals/route.ts";
import {
  resetTalkSendSignal$,
  sendZeroChatMessage$,
  startNewZeroSession$,
} from "../../signals/zero-page/zero-chat.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ZERO_AVATARS } from "./zero-avatars.ts";

export function ZeroTalkPage() {
  const avatarIndex = useGet(zeroAvatarIndex$);
  const zeroAvatarSrc = ZERO_AVATARS[avatarIndex] ?? ZERO_AVATARS[0];

  const currentChatAgentId = useGet(zeroChatAgentId$);
  const subagentsLoadable = useLastLoadable(zeroSubagents$);
  const subagents =
    subagentsLoadable.state === "hasData" ? subagentsLoadable.data : [];
  const selectedSubagent = currentChatAgentId
    ? subagents.find((a) => a.id === currentChatAgentId)
    : null;
  const subagentAvatarSrc = useAgentAvatar(selectedSubagent?.id ?? "");
  const chatAvatarSrc = selectedSubagent ? subagentAvatarSrc : zeroAvatarSrc;

  const agentDisplayNameLoadable = useLastLoadable(agentDisplayName$);
  const agentDisplayName =
    agentDisplayNameLoadable.state === "hasData"
      ? agentDisplayNameLoadable.data
      : "Zero";
  const chatAgentName = selectedSubagent
    ? (selectedSubagent.displayName ?? selectedSubagent.id)
    : agentDisplayName;

  const defaultAgentIdLoadable = useLastLoadable(defaultAgentId$);
  const defaultRawName =
    defaultAgentIdLoadable.state === "hasData"
      ? defaultAgentIdLoadable.data
      : null;
  const resolvedAgentId = selectedSubagent?.id ?? defaultRawName;

  const navigateTo = useSet(navigateTo$);
  const sendMessage = useSet(sendZeroChatMessage$);
  const startNewSession = useSet(startNewZeroSession$);
  const resetTalkSendSignal = useSet(resetTalkSendSignal$);

  const handleNavigateToMeet = (tab?: string) => {
    if (resolvedAgentId) {
      const searchParams = tab ? new URLSearchParams({ tab }) : undefined;
      navigateTo("/team/:id", {
        pathParams: { id: resolvedAgentId },
        searchParams,
      });
    }
  };

  const handleChatAvatarClick = () => {
    if (resolvedAgentId) {
      navigateTo("/team/:id", {
        pathParams: { id: resolvedAgentId },
      });
    }
  };

  const handleSendMessage = (
    message: string,
    options?: { modelProvider?: string },
  ) => {
    startNewSession();
    // Use a dedicated reset signal instead of pageSignal because the send
    // flow navigates from /talk/ to /chat/:sessionId, which would abort the
    // page signal.  resetTalkSendSignal$ is reset by startNewZeroSession$
    // above, so each send gets a fresh signal and previous sends are aborted.
    const talkSignal = resetTalkSendSignal();
    detach(sendMessage(message, options, talkSignal), Reason.DomCallback);
  };

  return (
    <SidebarLayout>
      <ZeroChatPage
        onSendMessage={handleSendMessage}
        onNavigateToMeet={handleNavigateToMeet}
        zeroAvatarSrc={chatAvatarSrc}
        chatAgentName={chatAgentName}
        onAvatarClick={handleChatAvatarClick}
      />
    </SidebarLayout>
  );
}
