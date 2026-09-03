export const AVATAR_PRESET_PREFIX = "preset:";

/** Avatar used by the default assistant across branded chat surfaces. */
export const DEFAULT_AGENT_AVATAR_URL =
  "https://static.vm0.io/public/default-agent-avatar-ceb298b79964.svg";

/** Keep the organization default agent on its canonical avatar. */
export function agentAvatarUrlForDefaultAgent(args: {
  readonly agentId: string;
  readonly defaultAgentId: string | null;
  readonly avatarUrl: string | null;
}): string | null {
  return args.agentId === args.defaultAgentId
    ? DEFAULT_AGENT_AVATAR_URL
    : args.avatarUrl;
}

/**
 * Number of built-in preset avatars: `preset:0` through `preset:4`.
 * Kept in sync with the render catalog in the platform's `zero-avatars.ts`.
 */
export const AVATAR_PRESET_COUNT = 5;

/** Return a random preset avatar string like `preset:2`. */
export function randomPresetAvatar(): string {
  return `${AVATAR_PRESET_PREFIX}${Math.floor(Math.random() * AVATAR_PRESET_COUNT)}`;
}
