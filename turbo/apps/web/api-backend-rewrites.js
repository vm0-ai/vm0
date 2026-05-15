export const API_BACKEND_REWRITES = [
  ["/api/device-token", "/api/device-token"],
  ["/api/device-token/poll", "/api/device-token/poll"],
  ["/api/agentphone/:path*", "/api/agentphone/:path*"],
  ["/api/internal/callbacks/agentphone", "/api/internal/callbacks/agentphone"],
  [
    "/api/internal/event-consumers/agentphone-typing",
    "/api/internal/event-consumers/agentphone-typing",
  ],
  ["/api/user/export", "/api/user/export"],
  ["/api/zero/devices/bb0/confirm", "/api/zero/devices/bb0/confirm"],
  [
    "/api/zero/me/model-providers/codex-oauth-token/oauth/authorize",
    "/api/zero/me/model-providers/codex-oauth-token/oauth/authorize",
  ],
  [
    "/api/zero/me/model-providers/codex-oauth-token/oauth/callback",
    "/api/zero/me/model-providers/codex-oauth-token/oauth/callback",
  ],
  ["/api/zero/image-io/generate", "/api/zero/image-io/generate"],
  ["/api/zero/presentation-io/generate", "/api/zero/presentation-io/generate"],
  ["/api/zero/remote-agent/:path*", "/api/zero/remote-agent/:path*"],
  ["/api/zero/video-io/generate", "/api/zero/video-io/generate"],
  ["/api/zero/host/deployments/prepare", "/api/zero/host/deployments/prepare"],
  ["/api/zero/host/deployments/:path*", "/api/zero/host/deployments/:path*"],
  [
    "/api/zero/integrations/phone/:path*",
    "/api/zero/integrations/phone/:path*",
  ],
  ["/api/zero/user-preferences", "/api/zero/user-preferences"],
  ["/api/zero/voice-chat", "/api/zero/voice-chat"],
];

export function matchesApiBackendRewritePath(pathname) {
  return API_BACKEND_REWRITES.some(([source]) => {
    if (source.endsWith("/:path*")) {
      const prefix = source.slice(0, -"/:path*".length);
      return pathname === prefix || pathname.startsWith(`${prefix}/`);
    }

    return pathname === source;
  });
}
