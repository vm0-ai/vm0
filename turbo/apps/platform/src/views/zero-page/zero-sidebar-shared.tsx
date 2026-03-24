import { useGet } from "ccstate-react";
import { agentAvatarOverrides$ } from "../../signals/zero-page/zero-agent-avatars.ts";
import avatar1Img from "./assets/avatar-1.webp";
import avatar2Img from "./assets/avatar-2.webp";
import avatar3Img from "./assets/avatar-3.webp";
import avatar4Img from "./assets/avatar-4.webp";

export const AGENT_AVATARS = [
  avatar1Img,
  avatar2Img,
  avatar3Img,
  avatar4Img,
] as const;

function getAgentAvatar(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return AGENT_AVATARS[Math.abs(hash) % AGENT_AVATARS.length];
}

/**
 * Reactive hook that returns the agent avatar, respecting any user override.
 */
export function useAgentAvatar(id: string): string {
  const overrides = useGet(agentAvatarOverrides$);
  return overrides[id] ?? getAgentAvatar(id);
}

/** Reactive avatar image that respects user overrides. */
export function AgentAvatarImg({
  name,
  alt,
  className,
}: {
  name: string;
  alt: string;
  className: string;
}) {
  const src = useAgentAvatar(name);
  return <img src={src} alt={alt} className={className} />;
}

export interface SubagentInfo {
  id: string;
  displayName?: string | null;
}
