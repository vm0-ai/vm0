import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { SidebarLayout } from "../zero-page/sidebar-layout.tsx";
import { ZeroJobDetailPage } from "../zero-page/zero-job-detail-page.tsx";
import { defaultAgentId$ } from "../../signals/zero-page/zero-agent-name.ts";
import {
  zeroAvatarIndex$,
  cycleZeroAvatar$,
} from "../../signals/zero-page/zero-nav.ts";
import { ZERO_AVATARS } from "../zero-page/zero-avatars.ts";
import { currentAgentId$ } from "../../signals/zero-page/agent.ts";

export function ZeroTeamDetailPage() {
  const agentId = useGet(currentAgentId$);

  const defaultAgentIdLoadable = useLastLoadable(defaultAgentId$);
  const defaultAgentId =
    defaultAgentIdLoadable.state === "hasData"
      ? defaultAgentIdLoadable.data
      : null;
  const isDefaultAgent = agentId !== null && agentId === defaultAgentId;

  const avatarIndex = useGet(zeroAvatarIndex$);
  const zeroAvatarSrc = ZERO_AVATARS[avatarIndex] ?? ZERO_AVATARS[0];
  const cycleZeroAvatar = useSet(cycleZeroAvatar$);

  return (
    <SidebarLayout>
      {agentId ? (
        <ZeroJobDetailPage
          agentId={agentId}
          {...(isDefaultAgent && {
            zeroAvatarSrc,
            onCycleAvatar: () => cycleZeroAvatar(ZERO_AVATARS.length),
          })}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          No agent selected
        </div>
      )}
    </SidebarLayout>
  );
}
