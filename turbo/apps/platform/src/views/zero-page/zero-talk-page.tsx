import { useSet, useLastLoadable, useGet } from "ccstate-react";
import { SidebarLayout } from "./sidebar-layout.tsx";
import { ZeroChatPage } from "./zero-chat-page.tsx";
import { useAgentAvatar } from "./zero-sidebar.tsx";
import { zeroChatAgentId$ } from "../../signals/zero-page/zero-active-agent.ts";
import { zeroSubagents$ } from "../../signals/zero-page/zero-agents.ts";
import {
  agentDisplayName$,
  defaultAgentId$,
} from "../../signals/zero-page/zero-agent-name.ts";
import {
  sendNewThreadMessage$,
  startNewZeroSession$,
} from "../../signals/zero-page/zero-chat.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";

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

  const sendNewThread = useSet(sendNewThreadMessage$);
  const startNewSession = useSet(startNewZeroSession$);
  const pageSignal = useGet(pageSignal$);

  const handleSendMessage = (
    message: string,
    options?: { modelProvider?: string },
  ) => {
    if (!resolvedAgentId) {
      return;
    }
    startNewSession();

    detach(
      sendNewThread(resolvedAgentId, message, options, pageSignal),
      Reason.DomCallback,
    );
  };

  return (
    <SidebarLayout>
      <ZeroChatPage
        onSendMessage={handleSendMessage}
        zeroAvatarSrc={chatAvatarSrc}
        chatAgentName={chatAgentName}
        avatarAgentId={resolvedAgentId ?? undefined}
      />
    </SidebarLayout>
  );
}
