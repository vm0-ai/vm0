const UUID_PATH_SEGMENT_PATTERN =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

const ZERO_VOICE_CHAT_SESSION_DETAIL_REWRITE_SOURCE = `/api/zero/voice-chat/:id(${UUID_PATH_SEGMENT_PATTERN})`;
const ZERO_VOICE_CHAT_SESSION_DETAIL_PATH_RE = new RegExp(
  `^/api/zero/voice-chat/${UUID_PATH_SEGMENT_PATTERN}$`,
);
const ZERO_VOICE_CHAT_ITEM_APPEND_REWRITE_SOURCE = `${ZERO_VOICE_CHAT_SESSION_DETAIL_REWRITE_SOURCE}/items`;
const ZERO_VOICE_CHAT_ITEM_APPEND_PATH_RE = new RegExp(
  `^/api/zero/voice-chat/${UUID_PATH_SEGMENT_PATTERN}/items$`,
);
const ZERO_VOICE_CHAT_TASKS_REWRITE_SOURCE = `/api/zero/voice-chat/:id(${UUID_PATH_SEGMENT_PATTERN})/tasks`;
const ZERO_VOICE_CHAT_TASKS_PATH_RE = new RegExp(
  `^/api/zero/voice-chat/${UUID_PATH_SEGMENT_PATTERN}/tasks$`,
);
const ZERO_VOICE_CHAT_TRIGGER_REASONING_REWRITE_SOURCE = `${ZERO_VOICE_CHAT_SESSION_DETAIL_REWRITE_SOURCE}/trigger-reasoning`;
const ZERO_VOICE_CHAT_TRIGGER_REASONING_PATH_RE = new RegExp(
  `^/api/zero/voice-chat/${UUID_PATH_SEGMENT_PATTERN}/trigger-reasoning$`,
);

export const API_BACKEND_REWRITES = [
  ["/api/device-token", "/api/device-token"],
  ["/api/device-token/poll", "/api/device-token/poll"],
  ["/api/agentphone/:path*", "/api/agentphone/:path*"],
  ["/api/email/unsubscribe", "/api/email/unsubscribe"],
  ["/api/generate-image", "/api/generate-image"],
  ["/api/github/oauth/callback", "/api/github/oauth/callback"],
  ["/api/github/oauth/install", "/api/github/oauth/install"],
  ["/api/integrations/github", "/api/integrations/github"],
  ["/api/logs/search", "/api/logs/search"],
  ["/api/storages/list", "/api/storages/list"],
  ["/api/usage", "/api/usage"],
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
    "/api/zero/connectors/stripe/cli-auth/sessions",
    "/api/zero/connectors/stripe/cli-auth/sessions",
  ],
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
  [
    "/api/zero/built-in-generations/:path*",
    "/api/zero/built-in-generations/:path*",
  ],
  ["/api/zero/image-io/generate", "/api/zero/image-io/generate"],
  ["/api/zero/local-browser/:path*", "/api/zero/local-browser/:path*"],
  ["/api/zero/presentation-io/generate", "/api/zero/presentation-io/generate"],
  ["/api/zero/local-agent/:path*", "/api/zero/local-agent/:path*"],
  ["/api/zero/usage/insight", "/api/zero/usage/insight"],
  ["/api/zero/usage/members", "/api/zero/usage/members"],
  ["/api/zero/usage/runs", "/api/zero/usage/runs"],
  ["/api/zero/video-io/generate", "/api/zero/video-io/generate"],
  ["/api/zero/host/deployments/prepare", "/api/zero/host/deployments/prepare"],
  ["/api/zero/host/deployments/:path*", "/api/zero/host/deployments/:path*"],
  ["/api/zero/voice-io/quota", "/api/zero/voice-io/quota"],
  ["/api/zero/voice-io/speech", "/api/zero/voice-io/speech"],
  ["/api/zero/voice-io/stt", "/api/zero/voice-io/stt"],
  ["/api/zero/voice-io/tts", "/api/zero/voice-io/tts"],
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
  ["/api/zero/uploads/complete", "/api/zero/uploads/complete"],
  ["/api/zero/uploads/prepare", "/api/zero/uploads/prepare"],
  [
    "/api/zero/permission-access-requests",
    "/api/zero/permission-access-requests",
  ],
  ["/api/zero/push-subscriptions", "/api/zero/push-subscriptions"],
  ["/api/zero/queue-position", "/api/zero/queue-position"],
  ["/api/zero/team", "/api/zero/team"],
  ["/api/zero/user-model-preference", "/api/zero/user-model-preference"],
  ["/api/zero/user-preferences", "/api/zero/user-preferences"],
  ["/api/zero/org/list", "/api/zero/org/list"],
  ["/api/zero/voice-chat", "/api/zero/voice-chat"],
  ["/api/zero/voice-chat/token", "/api/zero/voice-chat/token"],
  [
    ZERO_VOICE_CHAT_SESSION_DETAIL_REWRITE_SOURCE,
    "/api/zero/voice-chat/:id",
    ZERO_VOICE_CHAT_SESSION_DETAIL_PATH_RE,
  ],
  [
    ZERO_VOICE_CHAT_ITEM_APPEND_REWRITE_SOURCE,
    "/api/zero/voice-chat/:id/items",
    ZERO_VOICE_CHAT_ITEM_APPEND_PATH_RE,
  ],
  [
    ZERO_VOICE_CHAT_TASKS_REWRITE_SOURCE,
    "/api/zero/voice-chat/:id/tasks",
    ZERO_VOICE_CHAT_TASKS_PATH_RE,
  ],
  [
    ZERO_VOICE_CHAT_TRIGGER_REASONING_REWRITE_SOURCE,
    "/api/zero/voice-chat/:id/trigger-reasoning",
    ZERO_VOICE_CHAT_TRIGGER_REASONING_PATH_RE,
  ],
  ["/api/zero/web/download-file", "/api/zero/web/download-file"],
];

export function matchesApiBackendRewritePath(pathname) {
  return API_BACKEND_REWRITES.some(([source, , pathMatcher]) => {
    if (pathMatcher) {
      return pathMatcher.test(pathname);
    }

    if (source.endsWith("/:path*")) {
      const prefix = source.slice(0, -"/:path*".length);
      return pathname === prefix || pathname.startsWith(`${prefix}/`);
    }

    return pathname === source;
  });
}
