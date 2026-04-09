import { useLastResolved } from "ccstate-react";
import { agents$ } from "../../signals/agent.ts";
import { resolveAvatarUrl, isAvatarSvg } from "./avatar-utils.ts";
import { parseAvatarSvgConfig } from "./avatar-svg-utils.ts";
import { AvatarSvgPreview } from "./avatar-svg-preview.tsx";
import avatar1Img from "./assets/avatar_1.webp";

interface AgentAvatarState {
  /** Resolved image URL, or null when SVG/loading. */
  src: string | null;
  /** Raw avatarUrl from the DB, used to detect SVG avatars. */
  rawAvatarUrl: string | null | undefined;
}

/**
 * Reactive hook that returns the agent avatar state from the DB.
 * Returns `{ src: null, rawAvatarUrl: null }` while the agent id is unknown
 * (still loading) to avoid flashing an incorrect fallback.
 */
function useAgentAvatarState(id: string): AgentAvatarState {
  const resolved = useLastResolved(agents$);
  if (!id || resolved === undefined) {
    return { src: null, rawAvatarUrl: null };
  }
  const agent = resolved.find((a) => {
    return a.id === id;
  });
  const rawAvatarUrl = agent?.avatarUrl;
  const dbAvatar = resolveAvatarUrl(rawAvatarUrl);
  return { src: dbAvatar ?? avatar1Img, rawAvatarUrl };
}

/**
 * Reactive hook that returns the agent avatar image URL from the DB.
 * Backwards-compatible: returns a string URL or null.
 */
export function useAgentAvatar(id: string): string | null {
  const { src } = useAgentAvatarState(id);
  return src;
}

/** Reactive avatar image that respects DB-persisted and user overrides. */
export function AgentAvatarImg({
  name,
  alt,
  className,
  size,
}: {
  name: string;
  alt: string;
  className: string;
  size?: number;
}) {
  const { src, rawAvatarUrl } = useAgentAvatarState(name);
  if (isAvatarSvg(rawAvatarUrl)) {
    const config = parseAvatarSvgConfig(rawAvatarUrl);
    if (config) {
      return (
        <AvatarSvgPreview
          config={config}
          size={size ?? 40}
          className={className}
        />
      );
    }
  }
  if (!src) {
    return <div className={`${className} bg-muted`} aria-hidden />;
  }
  return <img src={src} alt={alt} className={className} />;
}
