import { useGet, useSet, useLastLoadable } from "ccstate-react";
import { SidebarLayout } from "./sidebar-layout.tsx";
import { ZeroSessionChatPage } from "./zero-session-chat-page.tsx";
import { useAgentAvatar } from "./zero-sidebar.tsx";
import {
  zeroChatAgentId$,
  zeroAvatarIndex$,
  navigateFromZeroSession$,
} from "../../signals/zero-page/zero-nav.ts";
import { zeroSubagents$ } from "../../signals/zero-page/zero-agents.ts";
import {
  agentDisplayName$,
  defaultAgentName$,
} from "../../signals/zero-page/zero-agent-name.ts";
import { navigateInReact$ } from "../../signals/route.ts";

import zeroAvatarImg from "./assets/zero-avatar.png";
import avatar1Img from "./assets/avatar-1.png";
import avatar2Img from "./assets/avatar-2.png";
import avatar3Img from "./assets/avatar-3.png";
import avatar4Img from "./assets/avatar-4.png";

const ZERO_AVATARS = [
  zeroAvatarImg,
  avatar1Img,
  avatar2Img,
  avatar3Img,
  avatar4Img,
] as const;

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

  const defaultAgentNameLoadable = useLastLoadable(defaultAgentName$);
  const defaultRawName =
    defaultAgentNameLoadable.state === "hasData"
      ? defaultAgentNameLoadable.data
      : null;
  const resolvedAgentName = selectedSubagent?.name ?? defaultRawName;

  const navigateInReact = useSet(navigateInReact$);
  const navigateBack = useSet(navigateFromZeroSession$);

  const handleNavigateToSchedule = () => {
    if (resolvedAgentName) {
      navigateInReact("/team/:name", {
        pathParams: { name: resolvedAgentName },
        searchParams: new URLSearchParams({ tab: "schedule" }),
      });
    }
  };

  const handleChatAvatarClick = () => {
    if (resolvedAgentName) {
      navigateInReact("/team/:name", {
        pathParams: { name: resolvedAgentName },
      });
    }
  };

  return (
    <SidebarLayout>
      <ZeroSessionChatPage
        zeroAvatarSrc={chatAvatarSrc}
        chatAgentName={chatAgentName}
        onBack={navigateBack}
        onNavigateToSchedule={handleNavigateToSchedule}
        onAvatarClick={handleChatAvatarClick}
      />
    </SidebarLayout>
  );
}
