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
const ZERO_ME_MODEL_PROVIDER_TYPE_REWRITE_SOURCE =
  "/api/zero/me/model-providers/:type";
const ZERO_ME_MODEL_PROVIDER_TYPE_PATH_RE =
  /^\/api\/zero\/me\/model-providers\/[^/]+$/;
const AGENT_SESSION_ID_REWRITE_SOURCE = "/api/agent/sessions/:id";
const AGENT_SESSION_ID_PATH_RE = /^\/api\/agent\/sessions\/[^/]+$/;
const ZERO_SECRETS_BY_NAME_REWRITE_SOURCE = "/api/zero/secrets/:name";
const ZERO_SECRETS_BY_NAME_PATH_RE = /^\/api\/zero\/secrets\/[^/]+$/;
const ZERO_SKILLS_BY_NAME_REWRITE_SOURCE = "/api/zero/skills/:name";
const ZERO_SKILLS_BY_NAME_PATH_RE = /^\/api\/zero\/skills\/[^/]+$/;
const ZERO_ME_MODEL_PROVIDERS_REWRITE_SOURCE = "/api/zero/me/model-providers";
const ZERO_VARIABLE_BY_NAME_REWRITE_SOURCE = "/api/zero/variables/:name";
const ZERO_VARIABLE_BY_NAME_PATH_RE = /^\/api\/zero\/variables\/[^/]+$/;
const AGENT_CHECKPOINT_REWRITE_SOURCE = "/api/agent/checkpoints/:id";
const AGENT_CHECKPOINT_PATH_RE = /^\/api\/agent\/checkpoints\/[^/]+$/;
const AGENT_COMPOSES_LIST_REWRITE_SOURCE = "/api/agent/composes/list";
const AGENT_COMPOSES_INSTRUCTIONS_REWRITE_SOURCE = `/api/agent/composes/:id(${UUID_PATH_SEGMENT_PATTERN})/instructions`;
const AGENT_COMPOSES_INSTRUCTIONS_PATH_RE = new RegExp(
  `^/api/agent/composes/${UUID_PATH_SEGMENT_PATTERN}/instructions$`,
);
const AGENT_COMPOSES_METADATA_REWRITE_SOURCE = `/api/agent/composes/:id(${UUID_PATH_SEGMENT_PATTERN})/metadata`;
const AGENT_COMPOSES_METADATA_PATH_RE = new RegExp(
  `^/api/agent/composes/${UUID_PATH_SEGMENT_PATTERN}/metadata$`,
);
const AGENT_COMPOSES_VERSIONS_REWRITE_SOURCE = "/api/agent/composes/versions";
const ZERO_MODEL_PROVIDER_TYPE_REWRITE_SOURCE =
  "/api/zero/model-providers/:type";
const ZERO_MODEL_PROVIDER_TYPE_PATH_RE =
  /^\/api\/zero\/model-providers\/[^/]+$/;
const ZERO_AGENTS_REWRITE_SOURCE = "/api/zero/agents";
const ZERO_AGENT_BY_ID_REWRITE_SOURCE = "/api/zero/agents/:id";
const ZERO_AGENT_BY_ID_PATH_RE = /^\/api\/zero\/agents\/[^/]+$/;
const ZERO_AGENT_CUSTOM_CONNECTORS_REWRITE_SOURCE =
  "/api/zero/agents/:id/custom-connectors";
const ZERO_AGENT_CUSTOM_CONNECTORS_PATH_RE =
  /^\/api\/zero\/agents\/[^/]+\/custom-connectors$/;
const ZERO_AGENT_USER_CONNECTORS_REWRITE_SOURCE =
  "/api/zero/agents/:id/user-connectors";
const ZERO_AGENT_USER_CONNECTORS_PATH_RE =
  /^\/api\/zero\/agents\/[^/]+\/user-connectors$/;
const AGENT_RUN_CANCEL_REWRITE_SOURCE = `/api/agent/runs/:id(${UUID_PATH_SEGMENT_PATTERN})/cancel`;
const AGENT_RUN_CANCEL_PATH_RE = new RegExp(
  `^/api/agent/runs/${UUID_PATH_SEGMENT_PATTERN}/cancel$`,
);
const ZERO_AGENT_INSTRUCTIONS_REWRITE_SOURCE =
  "/api/zero/agents/:id/instructions";
const ZERO_AGENT_INSTRUCTIONS_PATH_RE =
  /^\/api\/zero\/agents\/[^/]+\/instructions$/;
const ZERO_CHAT_THREAD_ARTIFACTS_REWRITE_SOURCE =
  "/api/zero/chat-threads/:threadId/artifacts";
const ZERO_CHAT_THREAD_ARTIFACTS_PATH_RE =
  /^\/api\/zero\/chat-threads\/[^/]+\/artifacts$/;
const ZERO_CHAT_THREAD_MARK_READ_REWRITE_SOURCE =
  "/api/zero/chat-threads/:id/mark-read";
const ZERO_CHAT_THREAD_MARK_READ_PATH_RE =
  /^\/api\/zero\/chat-threads\/[^/]+\/mark-read$/;
const ZERO_CHAT_THREAD_PIN_REWRITE_SOURCE = "/api/zero/chat-threads/:id/pin";
const ZERO_CHAT_THREAD_PIN_PATH_RE = /^\/api\/zero\/chat-threads\/[^/]+\/pin$/;
const ZERO_CHAT_THREAD_RENAME_REWRITE_SOURCE =
  "/api/zero/chat-threads/:id/rename";
const ZERO_CHAT_THREAD_RENAME_PATH_RE =
  /^\/api\/zero\/chat-threads\/[^/]+\/rename$/;
const ZERO_CHAT_THREAD_UNPIN_REWRITE_SOURCE =
  "/api/zero/chat-threads/:id/unpin";
const ZERO_CHAT_THREAD_UNPIN_PATH_RE =
  /^\/api\/zero\/chat-threads\/[^/]+\/unpin$/;

export const API_BACKEND_REWRITES = [
  [
    AGENT_CHECKPOINT_REWRITE_SOURCE,
    "/api/agent/checkpoints/:id",
    AGENT_CHECKPOINT_PATH_RE,
  ],
  [AGENT_COMPOSES_LIST_REWRITE_SOURCE, "/api/agent/composes/list"],
  [
    AGENT_COMPOSES_INSTRUCTIONS_REWRITE_SOURCE,
    "/api/agent/composes/:id/instructions",
    AGENT_COMPOSES_INSTRUCTIONS_PATH_RE,
  ],
  [
    AGENT_COMPOSES_METADATA_REWRITE_SOURCE,
    "/api/agent/composes/:id/metadata",
    AGENT_COMPOSES_METADATA_PATH_RE,
  ],
  [AGENT_COMPOSES_VERSIONS_REWRITE_SOURCE, "/api/agent/composes/versions"],
  ["/api/auth/me", "/api/auth/me"],
  ["/api/desktop-auth/handoff", "/api/desktop-auth/handoff"],
  ["/api/desktop-auth/consume", "/api/desktop-auth/consume"],
  [
    AGENT_RUN_CANCEL_REWRITE_SOURCE,
    "/api/agent/runs/:id/cancel",
    AGENT_RUN_CANCEL_PATH_RE,
  ],
  ["/api/agent/runs/queue", "/api/agent/runs/queue"],
  [
    AGENT_SESSION_ID_REWRITE_SOURCE,
    "/api/agent/sessions/:id",
    AGENT_SESSION_ID_PATH_RE,
  ],
  ["/api/cli/auth/device", "/api/cli/auth/device"],
  ["/api/cli/auth/org", "/api/cli/auth/org"],
  ["/api/cli/auth/test-approve", "/api/cli/auth/test-approve"],
  ["/api/cli/auth/test-codex-oauth", "/api/cli/auth/test-codex-oauth"],
  ["/api/cli/auth/test-connector", "/api/cli/auth/test-connector"],
  [
    "/api/cli/auth/test-enable-connector",
    "/api/cli/auth/test-enable-connector",
  ],
  ["/api/cli/auth/test-token", "/api/cli/auth/test-token"],
  ["/api/device-token", "/api/device-token"],
  ["/api/device-token/poll", "/api/device-token/poll"],
  ["/api/agentphone/:path*", "/api/agentphone/:path*"],
  ["/api/email/unsubscribe", "/api/email/unsubscribe"],
  ["/api/generate-image", "/api/generate-image"],
  ["/api/github/oauth/callback", "/api/github/oauth/callback"],
  ["/api/github/oauth/install", "/api/github/oauth/install"],
  ["/api/integrations/github", "/api/integrations/github"],
  ["/api/logs/search", "/api/logs/search"],
  ["/api/storages/commit", "/api/storages/commit"],
  ["/api/storages/download", "/api/storages/download"],
  ["/api/storages/list", "/api/storages/list"],
  ["/api/storages/prepare", "/api/storages/prepare"],
  ["/api/usage", "/api/usage"],
  [
    "/api/webhooks/built-in-generations/:path*",
    "/api/webhooks/built-in-generations/:path*",
  ],
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
  [
    "/api/internal/event-consumers/axiom",
    "/api/internal/event-consumers/axiom",
  ],
  [
    "/api/internal/event-consumers/chat-assistant",
    "/api/internal/event-consumers/chat-assistant",
  ],
  [
    "/api/internal/event-consumers/telegram-typing",
    "/api/internal/event-consumers/telegram-typing",
  ],
  [
    "/api/internal/event-consumers/voice-chat",
    "/api/internal/event-consumers/voice-chat",
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
  [ZERO_ME_MODEL_PROVIDERS_REWRITE_SOURCE, "/api/zero/me/model-providers"],
  [
    ZERO_ME_MODEL_PROVIDER_TYPE_REWRITE_SOURCE,
    "/api/zero/me/model-providers/:type",
    ZERO_ME_MODEL_PROVIDER_TYPE_PATH_RE,
  ],
  [
    "/api/zero/me/model-providers/codex-oauth-token/oauth/authorize",
    "/api/zero/me/model-providers/codex-oauth-token/oauth/authorize",
  ],
  [
    "/api/zero/me/model-providers/codex-oauth-token/oauth/callback",
    "/api/zero/me/model-providers/codex-oauth-token/oauth/callback",
  ],
  ["/api/zero/model-providers", "/api/zero/model-providers"],
  [
    ZERO_MODEL_PROVIDER_TYPE_REWRITE_SOURCE,
    "/api/zero/model-providers/:type",
    ZERO_MODEL_PROVIDER_TYPE_PATH_RE,
  ],
  [ZERO_AGENTS_REWRITE_SOURCE, "/api/zero/agents"],
  [
    ZERO_AGENT_BY_ID_REWRITE_SOURCE,
    "/api/zero/agents/:id",
    ZERO_AGENT_BY_ID_PATH_RE,
  ],
  [
    ZERO_AGENT_CUSTOM_CONNECTORS_REWRITE_SOURCE,
    "/api/zero/agents/:id/custom-connectors",
    ZERO_AGENT_CUSTOM_CONNECTORS_PATH_RE,
  ],
  [
    ZERO_AGENT_USER_CONNECTORS_REWRITE_SOURCE,
    "/api/zero/agents/:id/user-connectors",
    ZERO_AGENT_USER_CONNECTORS_PATH_RE,
  ],
  [
    ZERO_AGENT_INSTRUCTIONS_REWRITE_SOURCE,
    "/api/zero/agents/:id/instructions",
    ZERO_AGENT_INSTRUCTIONS_PATH_RE,
  ],
  [
    "/api/zero/built-in-generations/:path*",
    "/api/zero/built-in-generations/:path*",
  ],
  ["/api/zero/chat/search", "/api/zero/chat/search"],
  [
    ZERO_CHAT_THREAD_ARTIFACTS_REWRITE_SOURCE,
    "/api/zero/chat-threads/:threadId/artifacts",
    ZERO_CHAT_THREAD_ARTIFACTS_PATH_RE,
  ],
  [
    ZERO_CHAT_THREAD_MARK_READ_REWRITE_SOURCE,
    "/api/zero/chat-threads/:id/mark-read",
    ZERO_CHAT_THREAD_MARK_READ_PATH_RE,
  ],
  [
    ZERO_CHAT_THREAD_PIN_REWRITE_SOURCE,
    "/api/zero/chat-threads/:id/pin",
    ZERO_CHAT_THREAD_PIN_PATH_RE,
  ],
  [
    ZERO_CHAT_THREAD_RENAME_REWRITE_SOURCE,
    "/api/zero/chat-threads/:id/rename",
    ZERO_CHAT_THREAD_RENAME_PATH_RE,
  ],
  [
    ZERO_CHAT_THREAD_UNPIN_REWRITE_SOURCE,
    "/api/zero/chat-threads/:id/unpin",
    ZERO_CHAT_THREAD_UNPIN_PATH_RE,
  ],
  ["/api/zero/image-io/generate", "/api/zero/image-io/generate"],
  ["/api/zero/onboarding/setup", "/api/zero/onboarding/setup"],
  ["/api/zero/onboarding/status", "/api/zero/onboarding/status"],
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
  ["/api/zero/permission-policies", "/api/zero/permission-policies"],
  ["/api/zero/push-subscriptions", "/api/zero/push-subscriptions"],
  ["/api/zero/queue-position", "/api/zero/queue-position"],
  ["/api/zero/secrets", "/api/zero/secrets"],
  ["/api/zero/report-error", "/api/zero/report-error"],
  [
    ZERO_SECRETS_BY_NAME_REWRITE_SOURCE,
    "/api/zero/secrets/:name",
    ZERO_SECRETS_BY_NAME_PATH_RE,
  ],
  ["/api/zero/skills", "/api/zero/skills"],
  [
    ZERO_SKILLS_BY_NAME_REWRITE_SOURCE,
    "/api/zero/skills/:name",
    ZERO_SKILLS_BY_NAME_PATH_RE,
  ],
  ["/api/zero/team", "/api/zero/team"],
  ["/api/zero/model-policies", "/api/zero/model-policies"],
  ["/api/zero/realtime/token", "/api/zero/realtime/token"],
  ["/api/zero/user-model-preference", "/api/zero/user-model-preference"],
  ["/api/zero/user-preferences", "/api/zero/user-preferences"],
  ["/api/zero/org", "/api/zero/org"],
  ["/api/zero/org/delete", "/api/zero/org/delete"],
  ["/api/zero/org/domains", "/api/zero/org/domains"],
  ["/api/zero/org/invite", "/api/zero/org/invite"],
  ["/api/zero/org/leave", "/api/zero/org/leave"],
  ["/api/zero/org/list", "/api/zero/org/list"],
  ["/api/zero/org/logo", "/api/zero/org/logo"],
  ["/api/zero/org/members", "/api/zero/org/members"],
  ["/api/zero/org/members/credit-cap", "/api/zero/org/members/credit-cap"],
  ["/api/zero/org/membership-requests", "/api/zero/org/membership-requests"],
  ["/api/zero/variables", "/api/zero/variables"],
  [
    ZERO_VARIABLE_BY_NAME_REWRITE_SOURCE,
    "/api/zero/variables/:name",
    ZERO_VARIABLE_BY_NAME_PATH_RE,
  ],
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
