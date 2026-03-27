import { useGet, useSet, useLastLoadable } from "ccstate-react";
import { SidebarLayout } from "./sidebar-layout.tsx";
import { ZeroSessionChatPage } from "./zero-session-chat-page.tsx";
import { useAgentAvatar } from "./zero-sidebar.tsx";
import { zeroChatAgentId$ } from "../../signals/zero-page/zero-nav.ts";
import { zeroSubagents$ } from "../../signals/zero-page/zero-agents.ts";
import {
  agentDisplayName$,
  defaultAgentId$,
} from "../../signals/zero-page/zero-agent-name.ts";
import { navigateTo$ } from "../../signals/route.ts";

export function ZeroChatSessionPageWrapper() {
  const currentChatAgentId = useGet(zeroChatAgentId$);
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

  const navigateTo = useSet(navigateTo$);

  const handleNavigateToSchedule = () => {
    if (resolvedAgentId) {
      navigateTo("/team/:id", {
        pathParams: { id: resolvedAgentId },
        searchParams: new URLSearchParams({ tab: "schedule" }),
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

  return (
    <SidebarLayout>
      <ZeroSessionChatPage
        zeroAvatarSrc={chatAvatarSrc}
        chatAgentName={chatAgentName}
        onNavigateToSchedule={handleNavigateToSchedule}
        onAvatarClick={handleChatAvatarClick}
      />
    </SidebarLayout>
  );
}
