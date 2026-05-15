export const API_BACKEND_REWRITES = [
  ["/api/device-token", "/api/device-token"],
  ["/api/device-token/poll", "/api/device-token/poll"],
  ["/api/agentphone/:path*", "/api/agentphone/:path*"],
  ["/api/integrations/agentphone/link", "/api/integrations/agentphone/link"],
  ["/api/internal/callbacks/agentphone", "/api/internal/callbacks/agentphone"],
  [
    "/api/internal/cron/aggregate-model-stats",
    "/api/internal/cron/aggregate-model-stats",
  ],
  [
    "/api/internal/event-consumers/agentphone-typing",
    "/api/internal/event-consumers/agentphone-typing",
  ],
  ["/api/internal/vercel-sandbox/smoke", "/api/internal/vercel-sandbox/smoke"],
  ["/api/test/telegram-dispatch-probe", "/api/test/telegram-dispatch-probe"],
  ["/api/user/export", "/api/user/export"],
  ["/api/v1/audio/transcriptions", "/api/v1/audio/transcriptions"],
  [
    "/api/zero/connectors/stripe/cli-auth/sessions/:path*",
    "/api/zero/connectors/stripe/cli-auth/sessions/:path*",
  ],
  ["/api/zero/devices/bb0/confirm", "/api/zero/devices/bb0/confirm"],
  [
    "/api/zero/host/deployments/:deploymentId/complete",
    "/api/zero/host/deployments/:deploymentId/complete",
  ],
  ["/api/zero/host/deployments/prepare", "/api/zero/host/deployments/prepare"],
  [
    "/api/zero/me/model-providers/codex-oauth-token/oauth/authorize",
    "/api/zero/me/model-providers/codex-oauth-token/oauth/authorize",
  ],
  [
    "/api/zero/me/model-providers/codex-oauth-token/oauth/callback",
    "/api/zero/me/model-providers/codex-oauth-token/oauth/callback",
  ],
  ["/api/zero/image-io/generate", "/api/zero/image-io/generate"],
  ["/api/zero/local-browser/:path*", "/api/zero/local-browser/:path*"],
  ["/api/zero/presentation-io/generate", "/api/zero/presentation-io/generate"],
  ["/api/zero/remote-agent/:path*", "/api/zero/remote-agent/:path*"],
  ["/api/zero/video-io/generate", "/api/zero/video-io/generate"],
  ["/api/zero/host/deployments/prepare", "/api/zero/host/deployments/prepare"],
  ["/api/zero/host/deployments/:path*", "/api/zero/host/deployments/:path*"],
  ["/api/zero/voice-io/quota", "/api/zero/voice-io/quota"],
  [
    "/api/zero/voice-chat/:id/session-ended",
    "/api/zero/voice-chat/:id/session-ended",
  ],
  [
    "/api/zero/voice-chat/:id/session-started",
    "/api/zero/voice-chat/:id/session-started",
  ],
  ["/api/zero/voice-chat/:id/usage", "/api/zero/voice-chat/:id/usage"],
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
