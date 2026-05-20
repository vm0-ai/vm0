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
const ZERO_RUNS_REWRITE_SOURCE = "/api/zero/runs";
const ZERO_RUNS_QUEUE_REWRITE_SOURCE = "/api/zero/runs/queue";
const ZERO_RUNS_BY_ID_REWRITE_SOURCE = `/api/zero/runs/:id(${UUID_PATH_SEGMENT_PATTERN})`;
const ZERO_RUNS_BY_ID_PATH_RE = new RegExp(
  `^/api/zero/runs/${UUID_PATH_SEGMENT_PATTERN}$`,
);
const ZERO_RUNS_CANCEL_REWRITE_SOURCE = `/api/zero/runs/:id(${UUID_PATH_SEGMENT_PATTERN})/cancel`;
const ZERO_RUNS_CANCEL_PATH_RE = new RegExp(
  `^/api/zero/runs/${UUID_PATH_SEGMENT_PATTERN}/cancel$`,
);
const ZERO_RUNS_CONTEXT_REWRITE_SOURCE = `/api/zero/runs/:id(${UUID_PATH_SEGMENT_PATTERN})/context`;
const ZERO_RUNS_CONTEXT_PATH_RE = new RegExp(
  `^/api/zero/runs/${UUID_PATH_SEGMENT_PATTERN}/context$`,
);
const ZERO_RUNS_NETWORK_REWRITE_SOURCE = `/api/zero/runs/:id(${UUID_PATH_SEGMENT_PATTERN})/network`;
const ZERO_RUNS_NETWORK_PATH_RE = new RegExp(
  `^/api/zero/runs/${UUID_PATH_SEGMENT_PATTERN}/network$`,
);
const ZERO_RUNS_RUNNER_REWRITE_SOURCE = `/api/zero/runs/:id(${UUID_PATH_SEGMENT_PATTERN})/runner`;
const ZERO_RUNS_RUNNER_PATH_RE = new RegExp(
  `^/api/zero/runs/${UUID_PATH_SEGMENT_PATTERN}/runner$`,
);
const ZERO_RUNS_AGENT_EVENTS_REWRITE_SOURCE = `/api/zero/runs/:id(${UUID_PATH_SEGMENT_PATTERN})/telemetry/agent`;
const ZERO_RUNS_AGENT_EVENTS_PATH_RE = new RegExp(
  `^/api/zero/runs/${UUID_PATH_SEGMENT_PATTERN}/telemetry/agent$`,
);
const ZERO_LOGS_BY_ID_REWRITE_SOURCE = `/api/zero/logs/:id(${UUID_PATH_SEGMENT_PATTERN})`;
const ZERO_LOGS_BY_ID_PATH_RE = new RegExp(
  `^/api/zero/logs/${UUID_PATH_SEGMENT_PATTERN}$`,
);
const ZERO_SCHEDULES_BY_NAME_REWRITE_SOURCE = "/api/zero/schedules/:name";
const ZERO_SCHEDULES_BY_NAME_PATH_RE = /^\/api\/zero\/schedules\/[^/]+$/;
const TEST_TELEGRAM_MOCK_REWRITE_SOURCE =
  "/api/test/telegram-mock/:botToken/:method";
const TEST_TELEGRAM_MOCK_PATH_RE = /^\/api\/test\/telegram-mock\/[^/]+\/[^/]+$/;
const ZERO_SCHEDULES_RUN_REWRITE_SOURCE = "/api/zero/schedules/run";
const ZERO_SCHEDULES_DISABLE_REWRITE_SOURCE =
  "/api/zero/schedules/:name/disable";
const ZERO_SCHEDULES_DISABLE_PATH_RE =
  /^\/api\/zero\/schedules\/[^/]+\/disable$/;
const ZERO_SCHEDULES_ENABLE_REWRITE_SOURCE = "/api/zero/schedules/:name/enable";
const ZERO_SCHEDULES_ENABLE_PATH_RE = /^\/api\/zero\/schedules\/[^/]+\/enable$/;
const ZERO_SKILLS_BY_NAME_REWRITE_SOURCE = "/api/zero/skills/:name";
const ZERO_SKILLS_BY_NAME_PATH_RE = /^\/api\/zero\/skills\/[^/]+$/;
const ZERO_ME_MODEL_PROVIDERS_REWRITE_SOURCE = "/api/zero/me/model-providers";
const ZERO_VARIABLE_BY_NAME_REWRITE_SOURCE = "/api/zero/variables/:name";
const ZERO_VARIABLE_BY_NAME_PATH_RE = /^\/api\/zero\/variables\/[^/]+$/;
const AGENT_CHECKPOINT_REWRITE_SOURCE = "/api/agent/checkpoints/:id";
const AGENT_CHECKPOINT_PATH_RE = /^\/api\/agent\/checkpoints\/[^/]+$/;
const AGENT_COMPOSES_BY_ID_REWRITE_SOURCE = `/api/agent/composes/:id(${UUID_PATH_SEGMENT_PATTERN})`;
const AGENT_COMPOSES_BY_ID_PATH_RE = new RegExp(
  `^/api/agent/composes/${UUID_PATH_SEGMENT_PATTERN}$`,
);
const AGENT_COMPOSES_REWRITE_SOURCE = "/api/agent/composes";
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
const ZERO_CUSTOM_CONNECTORS_REWRITE_SOURCE = "/api/zero/custom-connectors";
const ZERO_CUSTOM_CONNECTORS_PATH_RE = /^\/api\/zero\/custom-connectors$/;
const ZERO_CUSTOM_CONNECTOR_BY_ID_REWRITE_SOURCE =
  "/api/zero/custom-connectors/:id";
const ZERO_CUSTOM_CONNECTOR_BY_ID_PATH_RE =
  /^\/api\/zero\/custom-connectors\/[^/]+$/;
const ZERO_CUSTOM_CONNECTOR_SECRET_REWRITE_SOURCE =
  "/api/zero/custom-connectors/:id/secret";
const ZERO_CUSTOM_CONNECTOR_SECRET_PATH_RE =
  /^\/api\/zero\/custom-connectors\/[^/]+\/secret$/;
const AGENT_RUN_CANCEL_REWRITE_SOURCE = `/api/agent/runs/:id(${UUID_PATH_SEGMENT_PATTERN})/cancel`;
const AGENT_RUN_CANCEL_PATH_RE = new RegExp(
  `^/api/agent/runs/${UUID_PATH_SEGMENT_PATTERN}/cancel$`,
);
const AGENT_RUN_EVENTS_REWRITE_SOURCE = `/api/agent/runs/:id(${UUID_PATH_SEGMENT_PATTERN})/events`;
const AGENT_RUN_EVENTS_PATH_RE = new RegExp(
  `^/api/agent/runs/${UUID_PATH_SEGMENT_PATTERN}/events$`,
);
const AGENT_RUN_BY_ID_REWRITE_SOURCE = `/api/agent/runs/:id(${UUID_PATH_SEGMENT_PATTERN})`;
const AGENT_RUN_BY_ID_PATH_RE = new RegExp(
  `^/api/agent/runs/${UUID_PATH_SEGMENT_PATTERN}$`,
);
const AGENT_RUN_TELEMETRY_REWRITE_SOURCE = `/api/agent/runs/:id(${UUID_PATH_SEGMENT_PATTERN})/telemetry`;
const AGENT_RUN_TELEMETRY_PATH_RE = new RegExp(
  `^/api/agent/runs/${UUID_PATH_SEGMENT_PATTERN}/telemetry$`,
);
const AGENT_RUN_TELEMETRY_AGENT_REWRITE_SOURCE = `/api/agent/runs/:id(${UUID_PATH_SEGMENT_PATTERN})/telemetry/agent`;
const AGENT_RUN_TELEMETRY_AGENT_PATH_RE = new RegExp(
  `^/api/agent/runs/${UUID_PATH_SEGMENT_PATTERN}/telemetry/agent$`,
);
const AGENT_RUN_TELEMETRY_METRICS_REWRITE_SOURCE = `/api/agent/runs/:id(${UUID_PATH_SEGMENT_PATTERN})/telemetry/metrics`;
const AGENT_RUN_TELEMETRY_METRICS_PATH_RE = new RegExp(
  `^/api/agent/runs/${UUID_PATH_SEGMENT_PATTERN}/telemetry/metrics$`,
);
const AGENT_RUN_TELEMETRY_NETWORK_REWRITE_SOURCE = `/api/agent/runs/:id(${UUID_PATH_SEGMENT_PATTERN})/telemetry/network`;
const AGENT_RUN_TELEMETRY_NETWORK_PATH_RE = new RegExp(
  `^/api/agent/runs/${UUID_PATH_SEGMENT_PATTERN}/telemetry/network$`,
);
const CONNECTORS_AUTHORIZE_REWRITE_SOURCE = "/api/connectors/:type/authorize";
const CONNECTORS_AUTHORIZE_PATH_RE = /^\/api\/connectors\/[^/]+\/authorize$/;
const AGENT_RUN_TELEMETRY_SYSTEM_LOG_REWRITE_SOURCE = `/api/agent/runs/:id(${UUID_PATH_SEGMENT_PATTERN})/telemetry/system-log`;
const AGENT_RUN_TELEMETRY_SYSTEM_LOG_PATH_RE = new RegExp(
  `^/api/agent/runs/${UUID_PATH_SEGMENT_PATTERN}/telemetry/system-log$`,
);
const CONNECTORS_CALLBACK_REWRITE_SOURCE = "/api/connectors/:type/callback";
const CONNECTORS_CALLBACK_PATH_RE = /^\/api\/connectors\/[^/]+\/callback$/;
const AGENTPHONE_CONNECT_REWRITE_SOURCE = "/api/agentphone/connect";
const AGENTPHONE_WEBHOOK_REWRITE_SOURCE = "/api/agentphone/webhook";
const RUNNERS_JOB_CLAIM_REWRITE_SOURCE = "/api/runners/jobs/:id/claim";
const RUNNERS_JOB_CLAIM_PATH_RE = /^\/api\/runners\/jobs\/[^/]+\/claim$/;
const GITHUB_OAUTH_CALLBACK_REWRITE_SOURCE = "/api/github/oauth/callback";
const GITHUB_OAUTH_INSTALL_REWRITE_SOURCE = "/api/github/oauth/install";
const GITHUB_OAUTH_PATH_RE = /^\/api\/github\/oauth\/(?:callback|install)$/;
const INTEGRATIONS_GITHUB_REWRITE_SOURCE = "/api/integrations/github";
const BUILT_IN_GENERATIONS_FAL_WEBHOOK_REWRITE_SOURCE = `/api/webhooks/built-in-generations/fal/:generationId(${UUID_PATH_SEGMENT_PATTERN})`;
const BUILT_IN_GENERATIONS_FAL_WEBHOOK_PATH_RE = new RegExp(
  `^/api/webhooks/built-in-generations/fal/${UUID_PATH_SEGMENT_PATTERN}$`,
);
const AGENT_COMPLETE_REWRITE_SOURCE = "/api/webhooks/agent/complete";
const AGENT_EVENTS_REWRITE_SOURCE = "/api/webhooks/agent/events";
const AGENT_FIREWALL_AUTH_REWRITE_SOURCE = "/api/webhooks/agent/firewall/auth";
const AGENT_HEARTBEAT_REWRITE_SOURCE = "/api/webhooks/agent/heartbeat";
const AGENT_STORAGES_COMMIT_REWRITE_SOURCE =
  "/api/webhooks/agent/storages/commit";
const AGENT_STORAGES_PREPARE_REWRITE_SOURCE =
  "/api/webhooks/agent/storages/prepare";
const AGENT_CHECKPOINTS_REWRITE_SOURCE = "/api/webhooks/agent/checkpoints";
const AGENT_CHECKPOINTS_PREPARE_HISTORY_REWRITE_SOURCE =
  "/api/webhooks/agent/checkpoints/prepare-history";
const CLERK_WEBHOOK_REWRITE_SOURCE = "/api/webhooks/clerk";
const GITHUB_WEBHOOK_REWRITE_SOURCE = "/api/webhooks/github";
const STRIPE_WEBHOOK_REWRITE_SOURCE = "/api/webhooks/stripe";
const TELEGRAM_REGISTER_REWRITE_SOURCE = "/api/telegram/register";
const TELEGRAM_SETUP_STATUS_REWRITE_SOURCE = "/api/telegram/setup-status";
const TELEGRAM_WEBHOOK_REWRITE_SOURCE = "/api/telegram/webhook/:telegramBotId";
const TELEGRAM_WEBHOOK_PATH_RE = /^\/api\/telegram\/webhook\/[^/]+$/;
const TELEGRAM_INTEGRATIONS_REWRITE_SOURCE = "/api/integrations/telegram";
const TELEGRAM_LINK_REWRITE_SOURCE = "/api/integrations/telegram/link";
const TELEGRAM_BOT_REWRITE_SOURCE =
  "/api/integrations/telegram/:botId((?!link$|auth-callback$)[^/]+)";
const TELEGRAM_BOT_PATH_RE =
  /^\/api\/integrations\/telegram\/(?!link$|auth-callback$)[^/]+$/;
const TELEGRAM_AVATAR_REWRITE_SOURCE =
  "/api/integrations/telegram/:botId/avatar";
const TELEGRAM_AVATAR_PATH_RE =
  /^\/api\/integrations\/telegram\/[^/]+\/avatar$/;
const TELEGRAM_AUTH_CALLBACK_REWRITE_SOURCE =
  "/api/integrations/telegram/auth-callback";
const ZERO_EMAIL_REPLY_CALLBACK_REWRITE_SOURCE =
  "/api/zero/email/callbacks/reply";
const ZERO_EMAIL_TRIGGER_CALLBACK_REWRITE_SOURCE =
  "/api/zero/email/callbacks/trigger";
const ZERO_EMAIL_INBOUND_REWRITE_SOURCE = "/api/zero/email/inbound";
const V1_CHAT_THREADS_MESSAGES_REWRITE_SOURCE = "/api/v1/chat-threads/messages";
const V1_CHAT_THREAD_DETAIL_REWRITE_SOURCE =
  "/api/v1/chat-threads/:threadId((?!messages$)[^/]+)";
const V1_CHAT_THREAD_DETAIL_PATH_RE =
  /^\/api\/v1\/chat-threads\/(?!messages$)[^/]+$/;
const V1_CHAT_THREAD_MESSAGES_REWRITE_SOURCE =
  "/api/v1/chat-threads/:threadId/messages";
const V1_CHAT_THREAD_MESSAGES_PATH_RE =
  /^\/api\/v1\/chat-threads\/[^/]+\/messages$/;
const ZERO_AGENT_INSTRUCTIONS_REWRITE_SOURCE =
  "/api/zero/agents/:id/instructions";
const ZERO_AGENT_INSTRUCTIONS_PATH_RE =
  /^\/api\/zero\/agents\/[^/]+\/instructions$/;
const ZERO_CHAT_MESSAGES_REWRITE_SOURCE = "/api/zero/chat/messages";
const ZERO_CHAT_MESSAGES_PATH_RE = /^\/api\/zero\/chat\/messages$/;
const ZERO_COMPOSES_REWRITE_SOURCE = "/api/zero/composes";
const ZERO_COMPOSES_LIST_REWRITE_SOURCE = "/api/zero/composes/list";
const ZERO_COMPOSES_BY_ID_REWRITE_SOURCE =
  "/api/zero/composes/:id((?!list$)[^/]+)";
const ZERO_COMPOSES_BY_ID_PATH_RE = /^\/api\/zero\/composes\/(?!list$)[^/]+$/;
const ZERO_COMPOSES_METADATA_REWRITE_SOURCE = "/api/zero/composes/:id/metadata";
const ZERO_COMPOSES_METADATA_PATH_RE =
  /^\/api\/zero\/composes\/[^/]+\/metadata$/;
const ZERO_COMPUTER_USE_HOST_REWRITE_SOURCE = "/api/zero/computer-use/host";
const ZERO_COMPUTER_USE_REGISTER_REWRITE_SOURCE =
  "/api/zero/computer-use/register";
const ZERO_COMPUTER_USE_UNREGISTER_REWRITE_SOURCE =
  "/api/zero/computer-use/unregister";
const ZERO_COMPUTER_USE_AUDIT_EVENTS_REWRITE_SOURCE =
  "/api/zero/computer-use/audit-events";
const ZERO_COMPUTER_USE_COMMANDS_REWRITE_SOURCE =
  "/api/zero/computer-use/commands";
const ZERO_COMPUTER_USE_COMMAND_BY_ID_REWRITE_SOURCE = `/api/zero/computer-use/commands/:commandId(${UUID_PATH_SEGMENT_PATTERN})`;
const ZERO_COMPUTER_USE_COMMAND_BY_ID_PATH_RE = new RegExp(
  `^/api/zero/computer-use/commands/${UUID_PATH_SEGMENT_PATTERN}$`,
);
const ZERO_COMPUTER_USE_COMMAND_APPROVAL_REWRITE_SOURCE = `${ZERO_COMPUTER_USE_COMMAND_BY_ID_REWRITE_SOURCE}/approval`;
const ZERO_COMPUTER_USE_COMMAND_APPROVAL_PATH_RE = new RegExp(
  `^/api/zero/computer-use/commands/${UUID_PATH_SEGMENT_PATTERN}/approval$`,
);
const ZERO_COMPUTER_USE_HEARTBEAT_REWRITE_SOURCE =
  "/api/zero/computer-use/heartbeat";
const ZERO_COMPUTER_USE_HOST_COMMANDS_NEXT_REWRITE_SOURCE =
  "/api/zero/computer-use/host/commands/next";
const ZERO_COMPUTER_USE_HOST_COMMAND_COMPLETE_REWRITE_SOURCE = `/api/zero/computer-use/host/commands/:commandId(${UUID_PATH_SEGMENT_PATTERN})/complete`;
const ZERO_COMPUTER_USE_HOST_COMMAND_COMPLETE_PATH_RE = new RegExp(
  `^/api/zero/computer-use/host/commands/${UUID_PATH_SEGMENT_PATTERN}/complete$`,
);
const ZERO_COMPUTER_USE_HOSTS_REWRITE_SOURCE = "/api/zero/computer-use/hosts";
const ZERO_COMPUTER_USE_HOST_BY_ID_REWRITE_SOURCE = `/api/zero/computer-use/hosts/:hostId(${UUID_PATH_SEGMENT_PATTERN})`;
const ZERO_COMPUTER_USE_HOST_BY_ID_PATH_RE = new RegExp(
  `^/api/zero/computer-use/hosts/${UUID_PATH_SEGMENT_PATTERN}$`,
);
const ZERO_COMPUTER_USE_HOSTS_START_REWRITE_SOURCE =
  "/api/zero/computer-use/hosts/start";
const ZERO_COMPUTER_USE_WRITE_COMMANDS_REWRITE_SOURCE =
  "/api/zero/computer-use/write-commands";
const ZERO_CONNECTORS_AUTHORIZE_REWRITE_SOURCE =
  "/api/zero/connectors/:type/authorize";
const ZERO_CONNECTORS_AUTHORIZE_PATH_RE =
  /^\/api\/zero\/connectors\/[^/]+\/authorize$/;
const ZERO_CONNECTORS_LIST_REWRITE_SOURCE = "/api/zero/connectors";
const ZERO_CONNECTORS_SEARCH_REWRITE_SOURCE = "/api/zero/connectors/search";
const ZERO_CONNECTORS_COMPUTER_REWRITE_SOURCE = "/api/zero/connectors/computer";
const ZERO_CONNECTORS_BY_TYPE_REWRITE_SOURCE =
  "/api/zero/connectors/:type((?!search$|computer$)[^/]+)";
const ZERO_CONNECTORS_BY_TYPE_PATH_RE =
  /^\/api\/zero\/connectors\/(?!search$|computer$)[^/]+$/;
const ZERO_CONNECTORS_SCOPE_DIFF_REWRITE_SOURCE =
  "/api/zero/connectors/:type/scope-diff";
const ZERO_CONNECTORS_SCOPE_DIFF_PATH_RE =
  /^\/api\/zero\/connectors\/[^/]+\/scope-diff$/;
const ZERO_CONNECTORS_SESSIONS_REWRITE_SOURCE =
  "/api/zero/connectors/:type/sessions";
const ZERO_CONNECTORS_SESSIONS_PATH_RE =
  /^\/api\/zero\/connectors\/[^/]+\/sessions$/;
const ZERO_CONNECTORS_SESSION_BY_ID_REWRITE_SOURCE = `/api/zero/connectors/:type/sessions/:sessionId(${UUID_PATH_SEGMENT_PATTERN})`;
const ZERO_CONNECTORS_SESSION_BY_ID_PATH_RE = new RegExp(
  `^/api/zero/connectors/[^/]+/sessions/${UUID_PATH_SEGMENT_PATTERN}$`,
);
const ZERO_CONNECTORS_OAUTH_START_REWRITE_SOURCE =
  "/api/zero/connectors/:type/oauth/start";
const ZERO_CONNECTORS_OAUTH_START_PATH_RE =
  /^\/api\/zero\/connectors\/[^/]+\/oauth\/start$/;
const ZERO_SLACK_OAUTH_INSTALL_REWRITE_SOURCE = "/api/zero/slack/oauth/install";
const ZERO_SLACK_OAUTH_CONNECT_REWRITE_SOURCE = "/api/zero/slack/oauth/connect";
const ZERO_SLACK_OAUTH_CALLBACK_REWRITE_SOURCE =
  "/api/zero/slack/oauth/callback";
const ZERO_SLACK_OAUTH_PATH_RE =
  /^\/api\/zero\/slack\/oauth\/(?:install|connect|callback)$/;
const ZERO_SLACK_CHANNELS_REWRITE_SOURCE = "/api/zero/slack/channels";
const ZERO_SLACK_CONNECT_REWRITE_SOURCE = "/api/zero/slack/connect";
const ZERO_SLACK_EVENTS_REWRITE_SOURCE = "/api/zero/slack/events";
const ZERO_SLACK_COMMANDS_REWRITE_SOURCE = "/api/zero/slack/commands";
const ZERO_SLACK_INTERACTIVE_REWRITE_SOURCE = "/api/zero/slack/interactive";
const ZERO_CHAT_THREAD_ARTIFACTS_REWRITE_SOURCE =
  "/api/zero/chat-threads/:threadId/artifacts";
const ZERO_CHAT_THREAD_ARTIFACTS_PATH_RE =
  /^\/api\/zero\/chat-threads\/[^/]+\/artifacts$/;
const ZERO_CHAT_THREAD_MESSAGES_REWRITE_SOURCE =
  "/api/zero/chat-threads/:threadId/messages";
const ZERO_CHAT_THREAD_MESSAGES_PATH_RE =
  /^\/api\/zero\/chat-threads\/[^/]+\/messages$/;
const ZERO_CHAT_THREAD_MARK_READ_REWRITE_SOURCE =
  "/api/zero/chat-threads/:id/mark-read";
const ZERO_CHAT_THREAD_MARK_READ_PATH_RE =
  /^\/api\/zero\/chat-threads\/[^/]+\/mark-read$/;
const ZERO_CHAT_THREADS_REWRITE_SOURCE = "/api/zero/chat-threads";
const ZERO_CHAT_THREADS_PATH_RE = /^\/api\/zero\/chat-threads$/;
const ZERO_CHAT_THREAD_DETAIL_REWRITE_SOURCE = "/api/zero/chat-threads/:id";
const ZERO_CHAT_THREAD_DETAIL_PATH_RE = /^\/api\/zero\/chat-threads\/[^/]+$/;
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
const ZERO_API_KEY_BY_ID_REWRITE_SOURCE = `/api/zero/api-keys/:id(${UUID_PATH_SEGMENT_PATTERN})`;
const ZERO_API_KEY_BY_ID_PATH_RE = new RegExp(
  `^/api/zero/api-keys/${UUID_PATH_SEGMENT_PATTERN}$`,
);
const ZERO_BILLING_AUTO_RECHARGE_REWRITE_SOURCE =
  "/api/zero/billing/auto-recharge";
const ZERO_BILLING_CHECKOUT_REWRITE_SOURCE = "/api/zero/billing/checkout";
const ZERO_BILLING_DOWNGRADE_REWRITE_SOURCE = "/api/zero/billing/downgrade";
const ZERO_BILLING_INVOICES_REWRITE_SOURCE = "/api/zero/billing/invoices";
const ZERO_BILLING_PORTAL_REWRITE_SOURCE = "/api/zero/billing/portal";
const ZERO_BILLING_REDEEM_REWRITE_SOURCE = "/api/zero/billing/redeem/:campaign";
const ZERO_BILLING_REDEEM_PATH_RE = /^\/api\/zero\/billing\/redeem\/[^/]+$/;
const ZERO_BILLING_STATUS_REWRITE_SOURCE = "/api/zero/billing/status";
const ZERO_DEFAULT_AGENT_REWRITE_SOURCE = "/api/zero/default-agent";

export const API_BACKEND_REWRITES = [
  [
    AGENT_CHECKPOINT_REWRITE_SOURCE,
    "/api/agent/checkpoints/:id",
    AGENT_CHECKPOINT_PATH_RE,
  ],
  [
    AGENT_COMPOSES_BY_ID_REWRITE_SOURCE,
    "/api/agent/composes/:id",
    AGENT_COMPOSES_BY_ID_PATH_RE,
  ],
  [AGENT_COMPOSES_REWRITE_SOURCE, "/api/agent/composes"],
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
  [
    AGENT_RUN_EVENTS_REWRITE_SOURCE,
    "/api/agent/runs/:id/events",
    AGENT_RUN_EVENTS_PATH_RE,
  ],
  [
    AGENT_RUN_BY_ID_REWRITE_SOURCE,
    "/api/agent/runs/:id",
    AGENT_RUN_BY_ID_PATH_RE,
  ],
  [
    AGENT_RUN_TELEMETRY_REWRITE_SOURCE,
    "/api/agent/runs/:id/telemetry",
    AGENT_RUN_TELEMETRY_PATH_RE,
  ],
  [
    AGENT_RUN_TELEMETRY_AGENT_REWRITE_SOURCE,
    "/api/agent/runs/:id/telemetry/agent",
    AGENT_RUN_TELEMETRY_AGENT_PATH_RE,
  ],
  [
    AGENT_RUN_TELEMETRY_METRICS_REWRITE_SOURCE,
    "/api/agent/runs/:id/telemetry/metrics",
    AGENT_RUN_TELEMETRY_METRICS_PATH_RE,
  ],
  [
    AGENT_RUN_TELEMETRY_NETWORK_REWRITE_SOURCE,
    "/api/agent/runs/:id/telemetry/network",
    AGENT_RUN_TELEMETRY_NETWORK_PATH_RE,
  ],
  [
    AGENT_RUN_TELEMETRY_SYSTEM_LOG_REWRITE_SOURCE,
    "/api/agent/runs/:id/telemetry/system-log",
    AGENT_RUN_TELEMETRY_SYSTEM_LOG_PATH_RE,
  ],
  ["/api/agent/runs", "/api/agent/runs"],
  ["/api/agent/runs/queue", "/api/agent/runs/queue"],
  [
    AGENT_SESSION_ID_REWRITE_SOURCE,
    "/api/agent/sessions/:id",
    AGENT_SESSION_ID_PATH_RE,
  ],
  ["/api/cli/auth/device", "/api/cli/auth/device"],
  ["/api/cli/auth/org", "/api/cli/auth/org"],
  ["/api/cli/auth/token", "/api/cli/auth/token"],
  ["/api/cli/auth/test-approve", "/api/cli/auth/test-approve"],
  ["/api/cli/auth/test-codex-oauth", "/api/cli/auth/test-codex-oauth"],
  ["/api/cli/auth/test-connector", "/api/cli/auth/test-connector"],
  [
    "/api/cli/auth/test-enable-connector",
    "/api/cli/auth/test-enable-connector",
  ],
  ["/api/cli/auth/test-token", "/api/cli/auth/test-token"],
  ["/api/cron/aggregate-insights", "/api/cron/aggregate-insights"],
  ["/api/cron/aggregate-usage", "/api/cron/aggregate-usage"],
  ["/api/cron/cleanup-sandboxes", "/api/cron/cleanup-sandboxes"],
  ["/api/cron/drain-email-outbox", "/api/cron/drain-email-outbox"],
  ["/api/cron/execute-schedules", "/api/cron/execute-schedules"],
  ["/api/cron/process-usage-events", "/api/cron/process-usage-events"],
  [
    "/api/cron/reconcile-billing-entitlements",
    "/api/cron/reconcile-billing-entitlements",
  ],
  ["/api/cron/sync-skills", "/api/cron/sync-skills"],
  ["/api/cron/telegram-cleanup", "/api/cron/telegram-cleanup"],
  ["/api/cron/voice-chat-cleanup", "/api/cron/voice-chat-cleanup"],
  [
    CONNECTORS_AUTHORIZE_REWRITE_SOURCE,
    "/api/connectors/:type/authorize",
    CONNECTORS_AUTHORIZE_PATH_RE,
  ],
  [
    CONNECTORS_CALLBACK_REWRITE_SOURCE,
    "/api/connectors/:type/callback",
    CONNECTORS_CALLBACK_PATH_RE,
  ],
  ["/api/device-token", "/api/device-token"],
  ["/api/device-token/poll", "/api/device-token/poll"],
  [AGENTPHONE_CONNECT_REWRITE_SOURCE, "/api/agentphone/connect"],
  [AGENTPHONE_WEBHOOK_REWRITE_SOURCE, "/api/agentphone/webhook"],
  ["/api/email/unsubscribe", "/api/email/unsubscribe"],
  ["/api/runners/heartbeat", "/api/runners/heartbeat"],
  [
    RUNNERS_JOB_CLAIM_REWRITE_SOURCE,
    "/api/runners/jobs/:id/claim",
    RUNNERS_JOB_CLAIM_PATH_RE,
  ],
  ["/api/runners/poll", "/api/runners/poll"],
  ["/api/runners/realtime/token", "/api/runners/realtime/token"],
  [ZERO_EMAIL_REPLY_CALLBACK_REWRITE_SOURCE, "/api/zero/email/callbacks/reply"],
  [
    ZERO_EMAIL_TRIGGER_CALLBACK_REWRITE_SOURCE,
    "/api/zero/email/callbacks/trigger",
  ],
  [ZERO_EMAIL_INBOUND_REWRITE_SOURCE, "/api/zero/email/inbound"],
  ["/api/generate-image", "/api/generate-image"],
  [GITHUB_OAUTH_CALLBACK_REWRITE_SOURCE, "/api/github/oauth/callback"],
  [GITHUB_OAUTH_INSTALL_REWRITE_SOURCE, "/api/github/oauth/install"],
  [INTEGRATIONS_GITHUB_REWRITE_SOURCE, "/api/integrations/github"],
  [AGENT_COMPLETE_REWRITE_SOURCE, "/api/webhooks/agent/complete"],
  [AGENT_EVENTS_REWRITE_SOURCE, "/api/webhooks/agent/events"],
  [AGENT_FIREWALL_AUTH_REWRITE_SOURCE, "/api/webhooks/agent/firewall/auth"],
  [AGENT_HEARTBEAT_REWRITE_SOURCE, "/api/webhooks/agent/heartbeat"],
  [AGENT_STORAGES_COMMIT_REWRITE_SOURCE, "/api/webhooks/agent/storages/commit"],
  [
    AGENT_STORAGES_PREPARE_REWRITE_SOURCE,
    "/api/webhooks/agent/storages/prepare",
  ],
  [AGENT_CHECKPOINTS_REWRITE_SOURCE, "/api/webhooks/agent/checkpoints"],
  [TELEGRAM_INTEGRATIONS_REWRITE_SOURCE, "/api/integrations/telegram"],
  [TELEGRAM_LINK_REWRITE_SOURCE, "/api/integrations/telegram/link"],
  [
    TELEGRAM_BOT_REWRITE_SOURCE,
    "/api/integrations/telegram/:botId",
    TELEGRAM_BOT_PATH_RE,
  ],
  [
    TELEGRAM_AVATAR_REWRITE_SOURCE,
    "/api/integrations/telegram/:botId/avatar",
    TELEGRAM_AVATAR_PATH_RE,
  ],
  [
    AGENT_CHECKPOINTS_PREPARE_HISTORY_REWRITE_SOURCE,
    "/api/webhooks/agent/checkpoints/prepare-history",
  ],
  [CLERK_WEBHOOK_REWRITE_SOURCE, "/api/webhooks/clerk"],
  [GITHUB_WEBHOOK_REWRITE_SOURCE, "/api/webhooks/github"],
  [STRIPE_WEBHOOK_REWRITE_SOURCE, "/api/webhooks/stripe"],
  [
    TELEGRAM_AUTH_CALLBACK_REWRITE_SOURCE,
    "/api/integrations/telegram/auth-callback",
  ],
  ["/api/logs/search", "/api/logs/search"],
  ["/api/zero/logs", "/api/zero/logs"],
  [
    ZERO_LOGS_BY_ID_REWRITE_SOURCE,
    "/api/zero/logs/:id",
    ZERO_LOGS_BY_ID_PATH_RE,
  ],
  ["/api/zero/logs/search", "/api/zero/logs/search"],
  ["/api/storages/commit", "/api/storages/commit"],
  ["/api/storages/download", "/api/storages/download"],
  ["/api/storages/list", "/api/storages/list"],
  ["/api/storages/prepare", "/api/storages/prepare"],
  ["/api/usage", "/api/usage"],
  [
    BUILT_IN_GENERATIONS_FAL_WEBHOOK_REWRITE_SOURCE,
    "/api/webhooks/built-in-generations/fal/:generationId",
    BUILT_IN_GENERATIONS_FAL_WEBHOOK_PATH_RE,
  ],
  ["/api/integrations/agentphone/link", "/api/integrations/agentphone/link"],
  ["/api/internal/callbacks/agent", "/api/internal/callbacks/agent"],
  ["/api/internal/callbacks/chat", "/api/internal/callbacks/chat"],
  [
    "/api/internal/callbacks/github/issues",
    "/api/internal/callbacks/github/issues",
  ],
  [
    "/api/internal/callbacks/schedule/cron",
    "/api/internal/callbacks/schedule/cron",
  ],
  [
    "/api/internal/callbacks/schedule/loop",
    "/api/internal/callbacks/schedule/loop",
  ],
  ["/api/internal/callbacks/slack/org", "/api/internal/callbacks/slack/org"],
  ["/api/internal/callbacks/telegram", "/api/internal/callbacks/telegram"],
  ["/api/internal/callbacks/voice-chat", "/api/internal/callbacks/voice-chat"],
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
  ["/api/test/oauth-provider/authorize", "/api/test/oauth-provider/authorize"],
  ["/api/test/oauth-provider/echo", "/api/test/oauth-provider/echo"],
  ["/api/test/oauth-provider/token", "/api/test/oauth-provider/token"],
  ["/api/test/oauth-provider/userinfo", "/api/test/oauth-provider/userinfo"],
  ["/api/test/slack-mock/auth.test", "/api/test/slack-mock/auth.test"],
  ["/api/test/slack-dispatch-probe", "/api/test/slack-dispatch-probe"],
  [
    "/api/test/slack-mock/assistant.threads.setStatus",
    "/api/test/slack-mock/assistant.threads.setStatus",
  ],
  [
    "/api/test/slack-mock/chat.postMessage",
    "/api/test/slack-mock/chat.postMessage",
  ],
  [
    "/api/test/slack-mock/chat.postEphemeral",
    "/api/test/slack-mock/chat.postEphemeral",
  ],
  [
    "/api/test/slack-mock/conversations.history",
    "/api/test/slack-mock/conversations.history",
  ],
  [
    "/api/test/slack-mock/conversations.open",
    "/api/test/slack-mock/conversations.open",
  ],
  [
    "/api/test/slack-mock/conversations.replies",
    "/api/test/slack-mock/conversations.replies",
  ],
  [
    "/api/test/slack-mock/oauth.v2.access",
    "/api/test/slack-mock/oauth.v2.access",
  ],
  ["/api/test/slack-mock/users.info", "/api/test/slack-mock/users.info"],
  ["/api/test/slack-mock/views.publish", "/api/test/slack-mock/views.publish"],
  [
    TEST_TELEGRAM_MOCK_REWRITE_SOURCE,
    "/api/test/telegram-mock/:botToken/:method",
    TEST_TELEGRAM_MOCK_PATH_RE,
  ],
  ["/api/test/slack-state", "/api/test/slack-state"],
  ["/api/test/telegram-state", "/api/test/telegram-state"],
  [TELEGRAM_REGISTER_REWRITE_SOURCE, "/api/telegram/register"],
  [TELEGRAM_SETUP_STATUS_REWRITE_SOURCE, "/api/telegram/setup-status"],
  [
    TELEGRAM_WEBHOOK_REWRITE_SOURCE,
    "/api/telegram/webhook/:telegramBotId",
    TELEGRAM_WEBHOOK_PATH_RE,
  ],
  ["/api/test/telegram-dispatch-probe", "/api/test/telegram-dispatch-probe"],
  ["/api/user/export", "/api/user/export"],
  ["/api/v1/audio/transcriptions", "/api/v1/audio/transcriptions"],
  [V1_CHAT_THREADS_MESSAGES_REWRITE_SOURCE, "/api/v1/chat-threads/messages"],
  [
    V1_CHAT_THREAD_MESSAGES_REWRITE_SOURCE,
    "/api/v1/chat-threads/:threadId/messages",
    V1_CHAT_THREAD_MESSAGES_PATH_RE,
  ],
  [
    V1_CHAT_THREAD_DETAIL_REWRITE_SOURCE,
    "/api/v1/chat-threads/:threadId",
    V1_CHAT_THREAD_DETAIL_PATH_RE,
  ],
  [
    "/api/zero/connectors/stripe/cli-auth/sessions",
    "/api/zero/connectors/stripe/cli-auth/sessions",
  ],
  [
    "/api/zero/connectors/stripe/cli-auth/sessions/:path*",
    "/api/zero/connectors/stripe/cli-auth/sessions/:path*",
  ],
  ["/api/zero/api-keys", "/api/zero/api-keys"],
  [
    ZERO_API_KEY_BY_ID_REWRITE_SOURCE,
    "/api/zero/api-keys/:id",
    ZERO_API_KEY_BY_ID_PATH_RE,
  ],
  [
    ZERO_BILLING_AUTO_RECHARGE_REWRITE_SOURCE,
    "/api/zero/billing/auto-recharge",
  ],
  [ZERO_BILLING_CHECKOUT_REWRITE_SOURCE, "/api/zero/billing/checkout"],
  [ZERO_BILLING_DOWNGRADE_REWRITE_SOURCE, "/api/zero/billing/downgrade"],
  [ZERO_BILLING_INVOICES_REWRITE_SOURCE, "/api/zero/billing/invoices"],
  [ZERO_BILLING_PORTAL_REWRITE_SOURCE, "/api/zero/billing/portal"],
  [
    ZERO_BILLING_REDEEM_REWRITE_SOURCE,
    "/api/zero/billing/redeem/:campaign",
    ZERO_BILLING_REDEEM_PATH_RE,
  ],
  [ZERO_BILLING_STATUS_REWRITE_SOURCE, "/api/zero/billing/status"],
  [ZERO_DEFAULT_AGENT_REWRITE_SOURCE, "/api/zero/default-agent"],
  [ZERO_CONNECTORS_LIST_REWRITE_SOURCE, "/api/zero/connectors"],
  [ZERO_CONNECTORS_SEARCH_REWRITE_SOURCE, "/api/zero/connectors/search"],
  [ZERO_CONNECTORS_COMPUTER_REWRITE_SOURCE, "/api/zero/connectors/computer"],
  [
    ZERO_CONNECTORS_BY_TYPE_REWRITE_SOURCE,
    "/api/zero/connectors/:type",
    ZERO_CONNECTORS_BY_TYPE_PATH_RE,
  ],
  [
    ZERO_CONNECTORS_SCOPE_DIFF_REWRITE_SOURCE,
    "/api/zero/connectors/:type/scope-diff",
    ZERO_CONNECTORS_SCOPE_DIFF_PATH_RE,
  ],
  [
    ZERO_CONNECTORS_SESSIONS_REWRITE_SOURCE,
    "/api/zero/connectors/:type/sessions",
    ZERO_CONNECTORS_SESSIONS_PATH_RE,
  ],
  [
    ZERO_CONNECTORS_SESSION_BY_ID_REWRITE_SOURCE,
    "/api/zero/connectors/:type/sessions/:sessionId",
    ZERO_CONNECTORS_SESSION_BY_ID_PATH_RE,
  ],
  [
    ZERO_CONNECTORS_AUTHORIZE_REWRITE_SOURCE,
    "/api/zero/connectors/:type/authorize",
    ZERO_CONNECTORS_AUTHORIZE_PATH_RE,
  ],
  [
    ZERO_CONNECTORS_OAUTH_START_REWRITE_SOURCE,
    "/api/zero/connectors/:type/oauth/start",
    ZERO_CONNECTORS_OAUTH_START_PATH_RE,
  ],
  [ZERO_SLACK_OAUTH_INSTALL_REWRITE_SOURCE, "/api/zero/slack/oauth/install"],
  [ZERO_SLACK_OAUTH_CONNECT_REWRITE_SOURCE, "/api/zero/slack/oauth/connect"],
  [ZERO_SLACK_OAUTH_CALLBACK_REWRITE_SOURCE, "/api/zero/slack/oauth/callback"],
  [ZERO_SLACK_CHANNELS_REWRITE_SOURCE, "/api/zero/slack/channels"],
  [ZERO_SLACK_CONNECT_REWRITE_SOURCE, "/api/zero/slack/connect"],
  [ZERO_SLACK_EVENTS_REWRITE_SOURCE, "/api/zero/slack/events"],
  [ZERO_SLACK_COMMANDS_REWRITE_SOURCE, "/api/zero/slack/commands"],
  [ZERO_SLACK_INTERACTIVE_REWRITE_SOURCE, "/api/zero/slack/interactive"],
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
    ZERO_CUSTOM_CONNECTORS_REWRITE_SOURCE,
    "/api/zero/custom-connectors",
    ZERO_CUSTOM_CONNECTORS_PATH_RE,
  ],
  [
    ZERO_CUSTOM_CONNECTOR_BY_ID_REWRITE_SOURCE,
    "/api/zero/custom-connectors/:id",
    ZERO_CUSTOM_CONNECTOR_BY_ID_PATH_RE,
  ],
  [
    ZERO_CUSTOM_CONNECTOR_SECRET_REWRITE_SOURCE,
    "/api/zero/custom-connectors/:id/secret",
    ZERO_CUSTOM_CONNECTOR_SECRET_PATH_RE,
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
  [
    ZERO_CHAT_MESSAGES_REWRITE_SOURCE,
    "/api/zero/chat/messages",
    ZERO_CHAT_MESSAGES_PATH_RE,
  ],
  [ZERO_COMPOSES_REWRITE_SOURCE, "/api/zero/composes"],
  [ZERO_COMPOSES_LIST_REWRITE_SOURCE, "/api/zero/composes/list"],
  [
    ZERO_COMPOSES_BY_ID_REWRITE_SOURCE,
    "/api/zero/composes/:id",
    ZERO_COMPOSES_BY_ID_PATH_RE,
  ],
  [
    ZERO_COMPOSES_METADATA_REWRITE_SOURCE,
    "/api/zero/composes/:id/metadata",
    ZERO_COMPOSES_METADATA_PATH_RE,
  ],
  [ZERO_COMPUTER_USE_HOST_REWRITE_SOURCE, "/api/zero/computer-use/host"],
  [
    ZERO_COMPUTER_USE_REGISTER_REWRITE_SOURCE,
    "/api/zero/computer-use/register",
  ],
  [
    ZERO_COMPUTER_USE_UNREGISTER_REWRITE_SOURCE,
    "/api/zero/computer-use/unregister",
  ],
  [
    ZERO_COMPUTER_USE_AUDIT_EVENTS_REWRITE_SOURCE,
    "/api/zero/computer-use/audit-events",
  ],
  [
    ZERO_COMPUTER_USE_COMMANDS_REWRITE_SOURCE,
    "/api/zero/computer-use/commands",
  ],
  [
    ZERO_COMPUTER_USE_COMMAND_BY_ID_REWRITE_SOURCE,
    "/api/zero/computer-use/commands/:commandId",
    ZERO_COMPUTER_USE_COMMAND_BY_ID_PATH_RE,
  ],
  [
    ZERO_COMPUTER_USE_COMMAND_APPROVAL_REWRITE_SOURCE,
    "/api/zero/computer-use/commands/:commandId/approval",
    ZERO_COMPUTER_USE_COMMAND_APPROVAL_PATH_RE,
  ],
  [
    ZERO_COMPUTER_USE_HEARTBEAT_REWRITE_SOURCE,
    "/api/zero/computer-use/heartbeat",
  ],
  [
    ZERO_COMPUTER_USE_HOST_COMMANDS_NEXT_REWRITE_SOURCE,
    "/api/zero/computer-use/host/commands/next",
  ],
  [
    ZERO_COMPUTER_USE_HOST_COMMAND_COMPLETE_REWRITE_SOURCE,
    "/api/zero/computer-use/host/commands/:commandId/complete",
    ZERO_COMPUTER_USE_HOST_COMMAND_COMPLETE_PATH_RE,
  ],
  [ZERO_COMPUTER_USE_HOSTS_REWRITE_SOURCE, "/api/zero/computer-use/hosts"],
  [
    ZERO_COMPUTER_USE_HOST_BY_ID_REWRITE_SOURCE,
    "/api/zero/computer-use/hosts/:hostId",
    ZERO_COMPUTER_USE_HOST_BY_ID_PATH_RE,
  ],
  [
    ZERO_COMPUTER_USE_HOSTS_START_REWRITE_SOURCE,
    "/api/zero/computer-use/hosts/start",
  ],
  [
    ZERO_COMPUTER_USE_WRITE_COMMANDS_REWRITE_SOURCE,
    "/api/zero/computer-use/write-commands",
  ],
  ["/api/zero/chat/search", "/api/zero/chat/search"],
  [
    ZERO_CHAT_THREADS_REWRITE_SOURCE,
    "/api/zero/chat-threads",
    ZERO_CHAT_THREADS_PATH_RE,
  ],
  [
    ZERO_CHAT_THREAD_ARTIFACTS_REWRITE_SOURCE,
    "/api/zero/chat-threads/:threadId/artifacts",
    ZERO_CHAT_THREAD_ARTIFACTS_PATH_RE,
  ],
  [
    ZERO_CHAT_THREAD_MESSAGES_REWRITE_SOURCE,
    "/api/zero/chat-threads/:threadId/messages",
    ZERO_CHAT_THREAD_MESSAGES_PATH_RE,
  ],
  [
    ZERO_CHAT_THREAD_MARK_READ_REWRITE_SOURCE,
    "/api/zero/chat-threads/:id/mark-read",
    ZERO_CHAT_THREAD_MARK_READ_PATH_RE,
  ],
  [
    ZERO_CHAT_THREAD_DETAIL_REWRITE_SOURCE,
    "/api/zero/chat-threads/:id",
    ZERO_CHAT_THREAD_DETAIL_PATH_RE,
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
  ["/api/zero/insights", "/api/zero/insights"],
  ["/api/zero/insights/range", "/api/zero/insights/range"],
  ["/api/zero/maps/:path*", "/api/zero/maps/:path*"],
  ["/api/zero/onboarding/setup", "/api/zero/onboarding/setup"],
  ["/api/zero/onboarding/status", "/api/zero/onboarding/status"],
  ["/api/zero/local-browser/:path*", "/api/zero/local-browser/:path*"],
  ["/api/zero/presentation-io/generate", "/api/zero/presentation-io/generate"],
  ["/api/zero/local-agent/:path*", "/api/zero/local-agent/:path*"],
  ["/api/zero/usage/insight", "/api/zero/usage/insight"],
  ["/api/zero/usage/members", "/api/zero/usage/members"],
  ["/api/zero/usage/runs", "/api/zero/usage/runs"],
  ["/api/zero/video-io/generate", "/api/zero/video-io/generate"],
  ["/api/zero/website-io/generate", "/api/zero/website-io/generate"],
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
  [
    "/api/zero/integrations/chat/message",
    "/api/zero/integrations/chat/message",
  ],
  [
    "/api/zero/integrations/slack/connect",
    "/api/zero/integrations/slack/connect",
  ],
  [
    "/api/zero/integrations/slack/message",
    "/api/zero/integrations/slack/message",
  ],
  [
    "/api/zero/integrations/telegram/bots",
    "/api/zero/integrations/telegram/bots",
  ],
  [
    "/api/zero/integrations/telegram/download-file",
    "/api/zero/integrations/telegram/download-file",
  ],
  [
    "/api/zero/integrations/telegram/message",
    "/api/zero/integrations/telegram/message",
  ],
  [
    "/api/zero/integrations/telegram/upload-file/complete",
    "/api/zero/integrations/telegram/upload-file/complete",
  ],
  [
    "/api/zero/integrations/telegram/upload-file/init",
    "/api/zero/integrations/telegram/upload-file/init",
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
  ["/api/zero/developer-support", "/api/zero/developer-support"],
  ["/api/zero/report-error", "/api/zero/report-error"],
  [ZERO_RUNS_REWRITE_SOURCE, "/api/zero/runs"],
  [ZERO_RUNS_QUEUE_REWRITE_SOURCE, "/api/zero/runs/queue"],
  [
    ZERO_RUNS_BY_ID_REWRITE_SOURCE,
    "/api/zero/runs/:id",
    ZERO_RUNS_BY_ID_PATH_RE,
  ],
  [
    ZERO_RUNS_CANCEL_REWRITE_SOURCE,
    "/api/zero/runs/:id/cancel",
    ZERO_RUNS_CANCEL_PATH_RE,
  ],
  [
    ZERO_RUNS_CONTEXT_REWRITE_SOURCE,
    "/api/zero/runs/:id/context",
    ZERO_RUNS_CONTEXT_PATH_RE,
  ],
  [
    ZERO_RUNS_NETWORK_REWRITE_SOURCE,
    "/api/zero/runs/:id/network",
    ZERO_RUNS_NETWORK_PATH_RE,
  ],
  [
    ZERO_RUNS_RUNNER_REWRITE_SOURCE,
    "/api/zero/runs/:id/runner",
    ZERO_RUNS_RUNNER_PATH_RE,
  ],
  [
    ZERO_RUNS_AGENT_EVENTS_REWRITE_SOURCE,
    "/api/zero/runs/:id/telemetry/agent",
    ZERO_RUNS_AGENT_EVENTS_PATH_RE,
  ],
  ["/api/zero/schedules", "/api/zero/schedules"],
  [ZERO_SCHEDULES_RUN_REWRITE_SOURCE, "/api/zero/schedules/run"],
  [
    ZERO_SECRETS_BY_NAME_REWRITE_SOURCE,
    "/api/zero/secrets/:name",
    ZERO_SECRETS_BY_NAME_PATH_RE,
  ],
  [
    ZERO_SCHEDULES_BY_NAME_REWRITE_SOURCE,
    "/api/zero/schedules/:name",
    ZERO_SCHEDULES_BY_NAME_PATH_RE,
  ],
  [
    ZERO_SCHEDULES_DISABLE_REWRITE_SOURCE,
    "/api/zero/schedules/:name/disable",
    ZERO_SCHEDULES_DISABLE_PATH_RE,
  ],
  [
    ZERO_SCHEDULES_ENABLE_REWRITE_SOURCE,
    "/api/zero/schedules/:name/enable",
    ZERO_SCHEDULES_ENABLE_PATH_RE,
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

export function matchesConnectorOAuthRewritePath(pathname) {
  return (
    CONNECTORS_AUTHORIZE_PATH_RE.test(pathname) ||
    CONNECTORS_CALLBACK_PATH_RE.test(pathname) ||
    ZERO_CONNECTORS_AUTHORIZE_PATH_RE.test(pathname) ||
    ZERO_CONNECTORS_OAUTH_START_PATH_RE.test(pathname)
  );
}

export function matchesGithubOAuthRewritePath(pathname) {
  return (
    GITHUB_OAUTH_PATH_RE.test(pathname) ||
    pathname === INTEGRATIONS_GITHUB_REWRITE_SOURCE
  );
}

export function matchesOAuthWebOriginRewritePath(pathname) {
  return (
    matchesConnectorOAuthRewritePath(pathname) ||
    ZERO_SLACK_OAUTH_PATH_RE.test(pathname) ||
    matchesGithubOAuthRewritePath(pathname)
  );
}
