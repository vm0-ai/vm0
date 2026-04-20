import { useLastResolved } from "ccstate-react";
import { FeatureSwitchKey } from "@vm0/core";
import { agents$ } from "../../signals/agent.ts";
import { currentChatAgentDisplayName$ } from "../../signals/agent-chat.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { resolveAvatarUrl, resolveAvatarSvgConfig } from "./avatar-utils.ts";
import { AvatarSvgPreview } from "./avatar-svg-preview.tsx";
import { getAvatarPresets } from "./zero-avatars.ts";

/**
 * Returns label/placeholder strings that vary based on the UnifyChatThreads
 * feature switch. Used by both the sidebar thread list and the full chat-list
 * page so the two surfaces stay in sync without duplicating the logic.
 */
export function useChatThreadsTitleLabels() {
  const agentDisplayName = useLastResolved(currentChatAgentDisplayName$);
  const features = useLastResolved(featureSwitch$);
  const unify = features?.[FeatureSwitchKey.UnifyChatThreads] ?? false;
  return {
    titleLabel: unify ? "Chats" : `Chats with ${agentDisplayName}`,
    searchPlaceholder: unify
      ? "Search chats"
      : `Search chat with ${agentDisplayName}`,
    newChatAriaLabel: unify ? "New chat" : `New chat with ${agentDisplayName}`,
  };
}

/**
 * Fallback preset config used when the agent hasn't loaded yet or has no avatar.
 * Matches preset:0 — the default avatar.
 */
function getFallbackConfig() {
  return getAvatarPresets()[0];
}

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
  return { src: dbAvatar, rawAvatarUrl };
}

/**
 * Render an avatar from an avatarUrl string (preset, svg, or custom upload).
 * Does NOT look up the agent — use this when you already have the avatarUrl.
 */
export function AvatarFromUrl({
  avatarUrl,
  alt,
  className,
  size,
  "data-testid": testId,
}: {
  avatarUrl: string | null | undefined;
  alt: string;
  className: string;
  size?: number;
  "data-testid"?: string;
}) {
  const svgConfig = resolveAvatarSvgConfig(avatarUrl);
  if (svgConfig) {
    return (
      <AvatarSvgPreview
        config={svgConfig}
        size={size}
        className={className}
        alt={alt}
        data-testid={testId}
      />
    );
  }
  const src = resolveAvatarUrl(avatarUrl);
  if (src) {
    return (
      <img src={src} alt={alt} className={className} data-testid={testId} />
    );
  }
  return (
    <AvatarSvgPreview
      config={getFallbackConfig()}
      size={size}
      className={className}
      alt={alt}
      data-testid={testId}
    />
  );
}

/** Reactive avatar image that respects DB-persisted and user overrides. */
export function AgentAvatarImg({
  name,
  alt,
  className,
  size,
  "data-testid": testId,
}: {
  name: string;
  alt: string;
  className: string;
  size?: number;
  "data-testid"?: string;
}) {
  const { src, rawAvatarUrl } = useAgentAvatarState(name);

  // SVG avatar (preset or custom svg:)
  const svgConfig = resolveAvatarSvgConfig(rawAvatarUrl);
  if (svgConfig) {
    return (
      <AvatarSvgPreview
        config={svgConfig}
        size={size}
        className={className}
        alt={alt}
        data-testid={testId}
      />
    );
  }

  // Custom uploaded image
  if (src) {
    return (
      <img src={src} alt={alt} className={className} data-testid={testId} />
    );
  }

  // Fallback: default preset SVG
  return (
    <AvatarSvgPreview
      config={getFallbackConfig()}
      size={size}
      className={className}
      alt={alt}
      data-testid={testId}
    />
  );
}
