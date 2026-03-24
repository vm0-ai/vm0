import { useGet, useSet, useLastLoadable } from "ccstate-react";
import { SidebarLayout } from "./sidebar-layout.tsx";
import { ZeroSessionChatPage } from "./zero-session-chat-page.tsx";
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
import { ZERO_AVATARS } from "./zero-avatars.ts";

export function ZeroChatSessionPageWrapper() {
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

  const defaultAgentIdLoadable = useLastLoadable(defaultAgentId$);
  const defaultRawName =
    defaultAgentIdLoadable.state === "hasData"
      ? defaultAgentIdLoadable.data
      : null;
  const resolvedAgentName = selectedSubagent?.name ?? defaultRawName;

  const navigateTo = useSet(navigateTo$);

  const handleNavigateToSchedule = () => {
    if (resolvedAgentName) {
      navigateTo("/team/:name", {
        pathParams: { name: resolvedAgentName },
        searchParams: new URLSearchParams({ tab: "schedule" }),
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
