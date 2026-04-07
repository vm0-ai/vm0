import { useLastResolved } from "ccstate-react";
import { agents$ } from "../../signals/agent.ts";
import { resolveAvatarUrl } from "./avatar-utils.ts";
import avatar1Img from "./assets/avatar_1.webp";

/**
 * Reactive hook that returns the agent avatar from the DB.
 * Returns `null` while the agent id is unknown (still loading) to avoid
 * flashing an incorrect fallback avatar before the real one resolves.
 * Falls back to the first preset avatar when nothing is persisted.
 */
export function useAgentAvatar(id: string): string | null {
  const resolved = useLastResolved(agents$);
  if (!id || resolved === undefined) {
    return null;
  }
  const agent = resolved.find((a) => {
    return a.id === id;
  });
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
  if (!src) {
    return <div className={`${className} bg-muted`} aria-hidden />;
  }
  return <img src={src} alt={alt} className={className} />;
}
