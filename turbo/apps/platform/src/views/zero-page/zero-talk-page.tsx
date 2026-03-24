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
  defaultAgentName$,
} from "../../signals/zero-page/zero-agent-name.ts";
import { navigateTo$ } from "../../signals/route.ts";
import {
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
  const subagentAvatarSrc = useAgentAvatar(selectedSubagent?.name ?? "");
  const chatAvatarSrc = selectedSubagent ? subagentAvatarSrc : zeroAvatarSrc;

  const agentDisplayNameLoadable = useLastLoadable(agentDisplayName$);
  const agentDisplayName =
    agentDisplayNameLoadable.state === "hasData"
      ? agentDisplayNameLoadable.data
      : "Zero";
  const chatAgentName = selectedSubagent
    ? (selectedSubagent.displayName ?? selectedSubagent.name)
    : agentDisplayName;

  const defaultAgentNameLoadable = useLastLoadable(defaultAgentName$);
  const defaultRawName =
    defaultAgentNameLoadable.state === "hasData"
      ? defaultAgentNameLoadable.data
      : null;
  const resolvedAgentName = selectedSubagent?.name ?? defaultRawName;

  const navigateTo = useSet(navigateTo$);
  const sendMessage = useSet(sendZeroChatMessage$);
  const startNewSession = useSet(startNewZeroSession$);

  const handleNavigateToMeet = (tab?: string) => {
    if (resolvedAgentName) {
      const searchParams = tab ? new URLSearchParams({ tab }) : undefined;
      navigateTo("/team/:name", {
        pathParams: { name: resolvedAgentName },
        searchParams,
      });
    }
  };

  const handleChatAvatarClick = () => {
    if (resolvedAgentName) {
      navigateTo("/team/:name", {
        pathParams: { name: resolvedAgentName },
      });
    }
  };

  const handleSendMessage = (
    message: string,
    options?: { modelProvider?: string },
  ) => {
    startNewSession();
    detach(sendMessage(message, options), Reason.DomCallback);
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
