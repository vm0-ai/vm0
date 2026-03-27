import { useLastResolved } from "ccstate-react";
import { agents$ } from "../../signals/zero-page/agents-list.ts";
import { resolveAvatarUrl } from "./avatar-utils.ts";
import avatar1Img from "./assets/avatar_1.png";

/**
 * Reactive hook that returns the agent avatar from the DB.
 * Falls back to the first preset avatar when nothing is persisted.
 */
export function useAgentAvatar(id: string): string {
  const agents = useLastResolved(agents$) ?? [];
  const agent = agents.find((a) => a.id === id);
  const dbAvatar = resolveAvatarUrl(agent?.avatarUrl);
  return dbAvatar ?? avatar1Img;
}

/** Reactive avatar image that respects DB-persisted and user overrides. */
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
