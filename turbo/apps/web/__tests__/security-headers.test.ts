import { createRequire } from "node:module";

import { afterEach, describe, expect, it, vi } from "vitest";
import { matchesApiBackendRewritePath } from "../api-backend-rewrites.js";

type PathMatchResult =
  | false
  | Record<string, string | readonly string[] | undefined>;

type GetPathMatch = (
  path: string,
  options?: {
    readonly removeUnnamedParams?: boolean;
    readonly strict?: boolean;
    readonly sensitive?: boolean;
  },
) => (pathname: string) => PathMatchResult;

const require = createRequire(import.meta.url);
const { getPathMatch } =
  require("next/dist/shared/lib/router/utils/path-match.js") as {
    readonly getPathMatch: GetPathMatch;
  };

const AGENT_RUN_ID = "550e8400-e29b-41d4-a716-446655440000";
const ZERO_RUN_ID = "550e8400-e29b-41d4-a716-446655440000";
const ZERO_LOG_ID = "550e8400-e29b-41d4-a716-446655440000";
const ZERO_CONNECTOR_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const VOICE_CHAT_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const AGENT_COMPOSE_ID = "550e8400-e29b-41d4-a716-446655440000";
const ZERO_API_KEY_ID = "550e8400-e29b-41d4-a716-446655440000";
const AGENT_CHECKPOINT_REWRITE_SOURCE = "/api/agent/checkpoints/:id";
const AGENT_CHECKPOINT_PATH = "/api/agent/checkpoints/checkpoint_123";
const AGENT_CHECKPOINT_NEXT_NEGATIVE_PATHS = [
  "/api/agent/checkpoints",
  "/api/agent/checkpoints/checkpoint_123/extra",
  "/api/agent/checkpoint/checkpoint_123",
] as const;
const AGENT_COMPOSES_REWRITE_SOURCE = "/api/agent/composes";
const AGENT_COMPOSES_PATH = "/api/agent/composes";
const AGENT_COMPOSES_NEXT_NEGATIVE_PATHS = [
  "/api/agent/composes/extra",
  "/api/agent/compose",
  "/api/agent/composes-list",
] as const;
const AGENT_COMPOSES_LIST_REWRITE_SOURCE = "/api/agent/composes/list";
const AGENT_COMPOSES_LIST_PATH = "/api/agent/composes/list";
const AGENT_COMPOSES_LIST_NEXT_NEGATIVE_PATHS = [
  "/api/agent/composes/list/extra",
  "/api/agent/composes/lists",
  "/api/agent/composes",
  "/api/agent/composes/versions",
] as const;
const AGENT_COMPOSES_BY_ID_REWRITE_SOURCE =
  "/api/agent/composes/:id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})";
const AGENT_COMPOSES_BY_ID_PATH = `/api/agent/composes/${AGENT_COMPOSE_ID}`;
const AGENT_COMPOSES_BY_ID_NEXT_NEGATIVE_PATHS = [
  "/api/agent/composes",
  "/api/agent/composes/not-a-uuid",
  "/api/agent/composes/list",
  "/api/agent/composes/versions",
  `/api/agent/composes/${AGENT_COMPOSE_ID}/metadata`,
  `/api/agent/composes/${AGENT_COMPOSE_ID}/instructions`,
  `/api/agent/composes/${AGENT_COMPOSE_ID}/extra`,
] as const;
const AGENT_COMPOSES_BY_ID_PROXY_NEGATIVE_PATHS = [
  "/api/agent/composes/not-a-uuid",
  `/api/agent/composes/${AGENT_COMPOSE_ID}/extra`,
] as const;
const AGENT_COMPOSES_INSTRUCTIONS_REWRITE_SOURCE =
  "/api/agent/composes/:id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/instructions";
const AGENT_COMPOSES_INSTRUCTIONS_PATH = `/api/agent/composes/${AGENT_COMPOSE_ID}/instructions`;
const AGENT_COMPOSES_INSTRUCTIONS_NEXT_NEGATIVE_PATHS = [
  "/api/agent/composes/not-a-uuid/instructions",
  "/api/agent/composes/list/instructions",
  "/api/agent/composes/versions/instructions",
  `/api/agent/composes/${AGENT_COMPOSE_ID}`,
  `/api/agent/composes/${AGENT_COMPOSE_ID}/instructions/extra`,
] as const;
const AGENT_COMPOSES_INSTRUCTIONS_PROXY_NEGATIVE_PATHS = [
  "/api/agent/composes/not-a-uuid/instructions",
  "/api/agent/composes/list/instructions",
  "/api/agent/composes/versions/instructions",
  `/api/agent/composes/${AGENT_COMPOSE_ID}/instructions/extra`,
] as const;
const AGENT_COMPOSES_METADATA_REWRITE_SOURCE =
  "/api/agent/composes/:id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/metadata";
const AGENT_COMPOSES_METADATA_PATH = `/api/agent/composes/${AGENT_COMPOSE_ID}/metadata`;
const AGENT_COMPOSES_METADATA_NEXT_NEGATIVE_PATHS = [
  "/api/agent/composes/not-a-uuid/metadata",
  "/api/agent/composes/list/metadata",
  "/api/agent/composes/versions/metadata",
  `/api/agent/composes/${AGENT_COMPOSE_ID}`,
  `/api/agent/composes/${AGENT_COMPOSE_ID}/metadata/extra`,
] as const;
const AGENT_COMPOSES_VERSIONS_REWRITE_SOURCE = "/api/agent/composes/versions";
const AGENT_COMPOSES_VERSIONS_PATH = "/api/agent/composes/versions";
const AGENT_COMPOSES_VERSIONS_NEXT_NEGATIVE_PATHS = [
  "/api/agent/composes/versions/extra",
  "/api/agent/composes/version",
  "/api/agent/composes",
] as const;
const AGENT_RUNS_REWRITE_SOURCE = "/api/agent/runs";
const AGENT_RUNS_PATH = "/api/agent/runs";
const AGENT_RUNS_NEXT_NEGATIVE_PATHS = [
  "/api/agent/runs/extra",
  "/api/agent/run",
  "/api/agent/runs/queue",
] as const;
const AGENT_RUNS_PROXY_NEGATIVE_PATHS = [
  "/api/agent/runs/extra",
  "/api/agent/run",
] as const;
const AGENT_RUNS_QUEUE_REWRITE_SOURCE = "/api/agent/runs/queue";
const AGENT_RUNS_QUEUE_PATH = "/api/agent/runs/queue";
const AGENT_RUNS_QUEUE_NEXT_NEGATIVE_PATHS = [
  "/api/agent/runs/queue/extra",
  "/api/agent/runs/queues",
] as const;
const AGENT_RUN_BY_ID_REWRITE_SOURCE =
  "/api/agent/runs/:id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})";
const AGENT_RUN_BY_ID_PATH = `/api/agent/runs/${AGENT_RUN_ID}`;
const AGENT_RUN_BY_ID_NEXT_NEGATIVE_PATHS = [
  "/api/agent/runs",
  "/api/agent/runs/queue",
  "/api/agent/runs/not-a-uuid",
  `/api/agent/runs/${AGENT_RUN_ID}/cancel`,
  `/api/agent/runs/${AGENT_RUN_ID}/events`,
  `/api/agent/runs/${AGENT_RUN_ID}/extra`,
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry`,
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry/agent`,
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry/metrics`,
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry/network`,
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry/system-log`,
] as const;
const AGENT_RUN_BY_ID_PROXY_NEGATIVE_PATHS = [
  "/api/agent/runs/not-a-uuid",
  `/api/agent/runs/${AGENT_RUN_ID}/extra`,
] as const;
const AGENT_RUN_TELEMETRY_REWRITE_SOURCE =
  "/api/agent/runs/:id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/telemetry";
const AGENT_RUN_TELEMETRY_PATH = `/api/agent/runs/${AGENT_RUN_ID}/telemetry`;
const AGENT_RUN_TELEMETRY_NEXT_NEGATIVE_PATHS = [
  "/api/agent/runs/queue/telemetry",
  "/api/agent/runs/not-a-uuid/telemetry",
  `/api/agent/runs/${AGENT_RUN_ID}`,
  `/api/agent/runs/${AGENT_RUN_ID}/cancel`,
  `/api/agent/runs/${AGENT_RUN_ID}/events`,
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry/agent`,
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry/metrics`,
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry/network`,
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry/extra`,
] as const;
const AGENT_RUN_TELEMETRY_PROXY_NEGATIVE_PATHS = [
  "/api/agent/runs/queue/telemetry",
  "/api/agent/runs/not-a-uuid/telemetry",
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry/extra`,
] as const;
const AGENT_RUN_TELEMETRY_AGENT_REWRITE_SOURCE =
  "/api/agent/runs/:id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/telemetry/agent";
const AGENT_RUN_TELEMETRY_AGENT_PATH = `/api/agent/runs/${AGENT_RUN_ID}/telemetry/agent`;
const AGENT_RUN_TELEMETRY_AGENT_NEXT_NEGATIVE_PATHS = [
  "/api/agent/runs/queue/telemetry/agent",
  "/api/agent/runs/not-a-uuid/telemetry/agent",
  `/api/agent/runs/${AGENT_RUN_ID}`,
  `/api/agent/runs/${AGENT_RUN_ID}/cancel`,
  `/api/agent/runs/${AGENT_RUN_ID}/events`,
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry`,
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry/metrics`,
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry/network`,
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry/agent/extra`,
] as const;
const AGENT_RUN_TELEMETRY_AGENT_PROXY_NEGATIVE_PATHS = [
  "/api/agent/runs/queue/telemetry/agent",
  "/api/agent/runs/not-a-uuid/telemetry/agent",
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry/agent/extra`,
] as const;
const AGENT_RUN_TELEMETRY_METRICS_REWRITE_SOURCE =
  "/api/agent/runs/:id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/telemetry/metrics";
const AGENT_RUN_TELEMETRY_METRICS_PATH = `/api/agent/runs/${AGENT_RUN_ID}/telemetry/metrics`;
const AGENT_RUN_TELEMETRY_METRICS_NEXT_NEGATIVE_PATHS = [
  "/api/agent/runs/queue/telemetry/metrics",
  "/api/agent/runs/not-a-uuid/telemetry/metrics",
  `/api/agent/runs/${AGENT_RUN_ID}`,
  `/api/agent/runs/${AGENT_RUN_ID}/cancel`,
  `/api/agent/runs/${AGENT_RUN_ID}/events`,
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry`,
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry/agent`,
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry/network`,
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry/metrics/extra`,
] as const;
const AGENT_RUN_TELEMETRY_METRICS_PROXY_NEGATIVE_PATHS = [
  "/api/agent/runs/queue/telemetry/metrics",
  "/api/agent/runs/not-a-uuid/telemetry/metrics",
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry/metrics/extra`,
] as const;
const AGENT_RUN_TELEMETRY_NETWORK_REWRITE_SOURCE =
  "/api/agent/runs/:id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/telemetry/network";
const AGENT_RUN_TELEMETRY_NETWORK_PATH = `/api/agent/runs/${AGENT_RUN_ID}/telemetry/network`;
const AGENT_RUN_TELEMETRY_NETWORK_NEXT_NEGATIVE_PATHS = [
  "/api/agent/runs/queue/telemetry/network",
  "/api/agent/runs/not-a-uuid/telemetry/network",
  `/api/agent/runs/${AGENT_RUN_ID}`,
  `/api/agent/runs/${AGENT_RUN_ID}/cancel`,
  `/api/agent/runs/${AGENT_RUN_ID}/events`,
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry`,
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry/agent`,
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry/metrics`,
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry/network/extra`,
] as const;
const AGENT_RUN_TELEMETRY_NETWORK_PROXY_NEGATIVE_PATHS = [
  "/api/agent/runs/queue/telemetry/network",
  "/api/agent/runs/not-a-uuid/telemetry/network",
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry/network/extra`,
] as const;
const AGENT_RUN_TELEMETRY_SYSTEM_LOG_REWRITE_SOURCE =
  "/api/agent/runs/:id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/telemetry/system-log";
const AGENT_RUN_TELEMETRY_SYSTEM_LOG_PATH = `/api/agent/runs/${AGENT_RUN_ID}/telemetry/system-log`;
const AGENT_RUN_TELEMETRY_SYSTEM_LOG_NEXT_NEGATIVE_PATHS = [
  "/api/agent/runs/queue/telemetry/system-log",
  "/api/agent/runs/not-a-uuid/telemetry/system-log",
  `/api/agent/runs/${AGENT_RUN_ID}`,
  `/api/agent/runs/${AGENT_RUN_ID}/cancel`,
  `/api/agent/runs/${AGENT_RUN_ID}/events`,
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry`,
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry/agent`,
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry/metrics`,
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry/network`,
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry/system-log/extra`,
] as const;
const AGENT_RUN_TELEMETRY_SYSTEM_LOG_PROXY_NEGATIVE_PATHS = [
  "/api/agent/runs/queue/telemetry/system-log",
  "/api/agent/runs/not-a-uuid/telemetry/system-log",
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry/system-log/extra`,
] as const;
const AGENT_RUN_CANCEL_REWRITE_SOURCE =
  "/api/agent/runs/:id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/cancel";
const AGENT_RUN_CANCEL_PATH = `/api/agent/runs/${AGENT_RUN_ID}/cancel`;
const AGENT_RUN_CANCEL_NEXT_NEGATIVE_PATHS = [
  "/api/agent/runs/queue/cancel",
  "/api/agent/runs/not-a-uuid/cancel",
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry`,
  `/api/agent/runs/${AGENT_RUN_ID}/cancel/extra`,
] as const;
const AGENT_RUN_CANCEL_PROXY_NEGATIVE_PATHS = [
  "/api/agent/runs/queue/cancel",
  "/api/agent/runs/not-a-uuid/cancel",
  `/api/agent/runs/${AGENT_RUN_ID}/cancel/extra`,
] as const;
const AGENT_RUN_EVENTS_REWRITE_SOURCE =
  "/api/agent/runs/:id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/events";
const AGENT_RUN_EVENTS_PATH = `/api/agent/runs/${AGENT_RUN_ID}/events`;
const AGENT_RUN_EVENTS_NEXT_NEGATIVE_PATHS = [
  "/api/agent/runs/queue/events",
  "/api/agent/runs/not-a-uuid/events",
  `/api/agent/runs/${AGENT_RUN_ID}/cancel`,
  `/api/agent/runs/${AGENT_RUN_ID}/events/extra`,
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry`,
  `/api/agent/runs/${AGENT_RUN_ID}/telemetry/agent`,
] as const;
const AGENT_RUN_EVENTS_PROXY_NEGATIVE_PATHS = [
  "/api/agent/runs/queue/events",
  "/api/agent/runs/not-a-uuid/events",
  `/api/agent/runs/${AGENT_RUN_ID}/events/extra`,
] as const;
const AUTH_ME_REWRITE_SOURCE = "/api/auth/me";
const AUTH_ME_PATH = "/api/auth/me";
const AUTH_ME_NEXT_NEGATIVE_PATHS = [
  "/api/auth/me/extra",
  "/api/auth",
] as const;
const CLI_AUTH_DEVICE_REWRITE_SOURCE = "/api/cli/auth/device";
const CLI_AUTH_DEVICE_PATH = "/api/cli/auth/device";
const CLI_AUTH_DEVICE_NEXT_NEGATIVE_PATHS = [
  "/api/cli/auth/device/extra",
  "/api/cli/auth",
] as const;
const CLI_AUTH_ORG_REWRITE_SOURCE = "/api/cli/auth/org";
const CLI_AUTH_ORG_PATH = "/api/cli/auth/org";
const CLI_AUTH_ORG_NEXT_NEGATIVE_PATHS = [
  "/api/cli/auth/org/extra",
  "/api/cli/auth",
] as const;
const CLI_AUTH_TOKEN_REWRITE_SOURCE = "/api/cli/auth/token";
const CLI_AUTH_TOKEN_PATH = "/api/cli/auth/token";
const CLI_AUTH_TOKEN_NEXT_NEGATIVE_PATHS = [
  "/api/cli/auth/token/extra",
  "/api/cli/auth",
] as const;
const CLI_AUTH_TEST_APPROVE_REWRITE_SOURCE = "/api/cli/auth/test-approve";
const CLI_AUTH_TEST_APPROVE_PATH = "/api/cli/auth/test-approve";
const CLI_AUTH_TEST_APPROVE_NEXT_NEGATIVE_PATHS = [
  "/api/cli/auth/test-approve/extra",
  "/api/cli/auth",
] as const;
const CLI_AUTH_TEST_CODEX_OAUTH_REWRITE_SOURCE =
  "/api/cli/auth/test-codex-oauth";
const CLI_AUTH_TEST_CODEX_OAUTH_PATH = "/api/cli/auth/test-codex-oauth";
const CLI_AUTH_TEST_CODEX_OAUTH_NEXT_NEGATIVE_PATHS = [
  "/api/cli/auth/test-codex-oauth/extra",
  "/api/cli/auth",
] as const;
const CLI_AUTH_TEST_CONNECTOR_REWRITE_SOURCE = "/api/cli/auth/test-connector";
const CLI_AUTH_TEST_CONNECTOR_PATH = "/api/cli/auth/test-connector";
const CLI_AUTH_TEST_CONNECTOR_NEXT_NEGATIVE_PATHS = [
  "/api/cli/auth/test-connector/extra",
  "/api/cli/auth",
] as const;
const CLI_AUTH_TEST_ENABLE_CONNECTOR_REWRITE_SOURCE =
  "/api/cli/auth/test-enable-connector";
const CLI_AUTH_TEST_ENABLE_CONNECTOR_PATH =
  "/api/cli/auth/test-enable-connector";
const CLI_AUTH_TEST_ENABLE_CONNECTOR_NEXT_NEGATIVE_PATHS = [
  "/api/cli/auth/test-enable-connector/extra",
  "/api/cli/auth",
] as const;
const CLI_AUTH_TEST_TOKEN_REWRITE_SOURCE = "/api/cli/auth/test-token";
const CLI_AUTH_TEST_TOKEN_PATH = "/api/cli/auth/test-token";
const CLI_AUTH_TEST_TOKEN_NEXT_NEGATIVE_PATHS = [
  "/api/cli/auth/test-token/extra",
  "/api/cli/auth",
] as const;
const TEST_OAUTH_PROVIDER_AUTHORIZE_REWRITE_SOURCE =
  "/api/test/oauth-provider/authorize";
const TEST_OAUTH_PROVIDER_AUTHORIZE_PATH = "/api/test/oauth-provider/authorize";
const TEST_OAUTH_PROVIDER_AUTHORIZE_PROXY_NEGATIVE_PATHS = [
  "/api/test/oauth-provider/authorize/extra",
  "/api/test/oauth-provider",
  "/api/test/oauth-provider/profile",
] as const;
const TEST_OAUTH_PROVIDER_ECHO_REWRITE_SOURCE = "/api/test/oauth-provider/echo";
const TEST_OAUTH_PROVIDER_ECHO_PATH = "/api/test/oauth-provider/echo";
const TEST_OAUTH_PROVIDER_ECHO_PROXY_NEGATIVE_PATHS = [
  "/api/test/oauth-provider/echo/extra",
  "/api/test/oauth-provider",
  "/api/test/oauth-provider/profile",
] as const;
const TEST_OAUTH_PROVIDER_TOKEN_REWRITE_SOURCE =
  "/api/test/oauth-provider/token";
const TEST_OAUTH_PROVIDER_TOKEN_PATH = "/api/test/oauth-provider/token";
const TEST_OAUTH_PROVIDER_TOKEN_PROXY_NEGATIVE_PATHS = [
  "/api/test/oauth-provider/token/extra",
  "/api/test/oauth-provider",
  "/api/test/oauth-provider/profile",
] as const;
const TEST_OAUTH_PROVIDER_USERINFO_REWRITE_SOURCE =
  "/api/test/oauth-provider/userinfo";
const TEST_OAUTH_PROVIDER_USERINFO_PATH = "/api/test/oauth-provider/userinfo";
const TEST_OAUTH_PROVIDER_USERINFO_PROXY_NEGATIVE_PATHS = [
  "/api/test/oauth-provider/userinfo/extra",
  "/api/test/oauth-provider",
  "/api/test/oauth-provider/profile",
] as const;
const TEST_SLACK_MOCK_AUTH_TEST_REWRITE_SOURCE =
  "/api/test/slack-mock/auth.test";
const TEST_SLACK_MOCK_AUTH_TEST_PATH = "/api/test/slack-mock/auth.test";
const TEST_SLACK_MOCK_AUTH_TEST_NEXT_NEGATIVE_PATHS = [
  "/api/test/slack-mock/auth.test/extra",
  "/api/test/slack-mock/auth",
  "/api/test/slack-mock/auth.tests",
] as const;
const TEST_SLACK_MOCK_CHAT_POST_MESSAGE_REWRITE_SOURCE =
  "/api/test/slack-mock/chat.postMessage";
const TEST_SLACK_MOCK_CHAT_POST_MESSAGE_PATH =
  "/api/test/slack-mock/chat.postMessage";
const TEST_SLACK_MOCK_CHAT_POST_MESSAGE_NEXT_NEGATIVE_PATHS = [
  "/api/test/slack-mock/chat.postMessage/extra",
  "/api/test/slack-mock/chat.post",
  "/api/test/slack-mock/chat.postMessages",
] as const;
const TEST_SLACK_MOCK_CONVERSATIONS_HISTORY_REWRITE_SOURCE =
  "/api/test/slack-mock/conversations.history";
const TEST_SLACK_MOCK_CONVERSATIONS_HISTORY_PATH =
  "/api/test/slack-mock/conversations.history";
const TEST_SLACK_MOCK_CONVERSATIONS_HISTORY_NEXT_NEGATIVE_PATHS = [
  "/api/test/slack-mock/conversations.history/extra",
  "/api/test/slack-mock/conversations",
  "/api/test/slack-mock/conversations.historys",
] as const;
const TEST_SLACK_MOCK_CONVERSATIONS_REPLIES_REWRITE_SOURCE =
  "/api/test/slack-mock/conversations.replies";
const TEST_SLACK_MOCK_CONVERSATIONS_REPLIES_PATH =
  "/api/test/slack-mock/conversations.replies";
const TEST_SLACK_MOCK_CONVERSATIONS_REPLIES_NEXT_NEGATIVE_PATHS = [
  "/api/test/slack-mock/conversations.replies/extra",
  "/api/test/slack-mock/conversations",
  "/api/test/slack-mock/conversations.repliess",
] as const;
const TEST_SLACK_MOCK_OAUTH_ACCESS_REWRITE_SOURCE =
  "/api/test/slack-mock/oauth.v2.access";
const TEST_SLACK_MOCK_OAUTH_ACCESS_PATH =
  "/api/test/slack-mock/oauth.v2.access";
const TEST_SLACK_MOCK_OAUTH_ACCESS_NEXT_NEGATIVE_PATHS = [
  "/api/test/slack-mock/oauth.v2.access/extra",
  "/api/test/slack-mock/oauth.v2",
  "/api/test/slack-mock/oauth.v2.accesses",
] as const;
const TEST_SLACK_MOCK_USERS_INFO_REWRITE_SOURCE =
  "/api/test/slack-mock/users.info";
const TEST_SLACK_MOCK_USERS_INFO_PATH = "/api/test/slack-mock/users.info";
const TEST_SLACK_MOCK_USERS_INFO_NEXT_NEGATIVE_PATHS = [
  "/api/test/slack-mock/users.info/extra",
  "/api/test/slack-mock/users",
  "/api/test/slack-mock/users.infos",
] as const;
const TEST_SLACK_MOCK_VIEWS_PUBLISH_REWRITE_SOURCE =
  "/api/test/slack-mock/views.publish";
const TEST_SLACK_MOCK_VIEWS_PUBLISH_PATH = "/api/test/slack-mock/views.publish";
const TEST_SLACK_MOCK_VIEWS_PUBLISH_NEXT_NEGATIVE_PATHS = [
  "/api/test/slack-mock/views.publish/extra",
  "/api/test/slack-mock/views",
  "/api/test/slack-mock/views.published",
] as const;
const TEST_TELEGRAM_MOCK_REWRITE_SOURCE =
  "/api/test/telegram-mock/:botToken/:method";
const TEST_TELEGRAM_MOCK_PATH = "/api/test/telegram-mock/bot123/sendMessage";
const TEST_TELEGRAM_MOCK_NEXT_NEGATIVE_PATHS = [
  "/api/test/telegram-mock/bot123/sendMessage/extra",
  "/api/test/telegram-mock/bot123",
  "/api/test/telegram-mock",
] as const;
const CRON_AGGREGATE_INSIGHTS_REWRITE_SOURCE = "/api/cron/aggregate-insights";
const CRON_AGGREGATE_INSIGHTS_PATH = "/api/cron/aggregate-insights";
const CRON_AGGREGATE_INSIGHTS_NEXT_NEGATIVE_PATHS = [
  "/api/cron/aggregate-insights/extra",
  "/api/cron",
] as const;
const CRON_AGGREGATE_USAGE_REWRITE_SOURCE = "/api/cron/aggregate-usage";
const CRON_AGGREGATE_USAGE_PATH = "/api/cron/aggregate-usage";
const CRON_AGGREGATE_USAGE_NEXT_NEGATIVE_PATHS = [
  "/api/cron/aggregate-usage/extra",
  "/api/cron",
] as const;
const CRON_CLEANUP_SANDBOXES_REWRITE_SOURCE = "/api/cron/cleanup-sandboxes";
const CRON_CLEANUP_SANDBOXES_PATH = "/api/cron/cleanup-sandboxes";
const CRON_CLEANUP_SANDBOXES_NEXT_NEGATIVE_PATHS = [
  "/api/cron/cleanup-sandboxes/extra",
  "/api/cron",
] as const;
const CRON_DRAIN_EMAIL_OUTBOX_REWRITE_SOURCE = "/api/cron/drain-email-outbox";
const CRON_DRAIN_EMAIL_OUTBOX_PATH = "/api/cron/drain-email-outbox";
const CRON_DRAIN_EMAIL_OUTBOX_NEXT_NEGATIVE_PATHS = [
  "/api/cron/drain-email-outbox/extra",
  "/api/cron",
] as const;
const CRON_EXECUTE_SCHEDULES_REWRITE_SOURCE = "/api/cron/execute-schedules";
const CRON_EXECUTE_SCHEDULES_PATH = "/api/cron/execute-schedules";
const CRON_EXECUTE_SCHEDULES_NEXT_NEGATIVE_PATHS = [
  "/api/cron/execute-schedules/extra",
  "/api/cron",
] as const;
const CRON_PROCESS_USAGE_EVENTS_REWRITE_SOURCE =
  "/api/cron/process-usage-events";
const CRON_PROCESS_USAGE_EVENTS_PATH = "/api/cron/process-usage-events";
const CRON_PROCESS_USAGE_EVENTS_NEXT_NEGATIVE_PATHS = [
  "/api/cron/process-usage-events/extra",
  "/api/cron",
] as const;
const CRON_RECONCILE_BILLING_ENTITLEMENTS_REWRITE_SOURCE =
  "/api/cron/reconcile-billing-entitlements";
const CRON_RECONCILE_BILLING_ENTITLEMENTS_PATH =
  "/api/cron/reconcile-billing-entitlements";
const CRON_RECONCILE_BILLING_ENTITLEMENTS_NEXT_NEGATIVE_PATHS = [
  "/api/cron/reconcile-billing-entitlements/extra",
  "/api/cron",
] as const;
const CRON_SYNC_SKILLS_REWRITE_SOURCE = "/api/cron/sync-skills";
const CRON_SYNC_SKILLS_PATH = "/api/cron/sync-skills";
const CRON_SYNC_SKILLS_NEXT_NEGATIVE_PATHS = [
  "/api/cron/sync-skills/extra",
  "/api/cron",
] as const;
const CRON_TELEGRAM_CLEANUP_REWRITE_SOURCE = "/api/cron/telegram-cleanup";
const CRON_TELEGRAM_CLEANUP_PATH = "/api/cron/telegram-cleanup";
const CRON_TELEGRAM_CLEANUP_NEXT_NEGATIVE_PATHS = [
  "/api/cron/telegram-cleanup/extra",
  "/api/cron",
] as const;
const CRON_VOICE_CHAT_CLEANUP_REWRITE_SOURCE = "/api/cron/voice-chat-cleanup";
const CRON_VOICE_CHAT_CLEANUP_PATH = "/api/cron/voice-chat-cleanup";
const CRON_VOICE_CHAT_CLEANUP_NEXT_NEGATIVE_PATHS = [
  "/api/cron/voice-chat-cleanup/extra",
  "/api/cron",
] as const;
const CONNECTORS_AUTHORIZE_REWRITE_SOURCE = "/api/connectors/:type/authorize";
const CONNECTORS_AUTHORIZE_PATH = "/api/connectors/github/authorize";
const CONNECTORS_AUTHORIZE_NEXT_NEGATIVE_PATHS = [
  "/api/connectors/github/authorize/extra",
  "/api/connectors/authorize",
  "/api/connectors/github/authorizes",
] as const;
const CONNECTORS_CALLBACK_REWRITE_SOURCE = "/api/connectors/:type/callback";
const CONNECTORS_CALLBACK_PATH = "/api/connectors/github/callback";
const CONNECTORS_CALLBACK_NEXT_NEGATIVE_PATHS = [
  "/api/connectors/github/callback/extra",
  "/api/connectors/callback",
  "/api/connectors/github/callbacks",
] as const;
const RUNNERS_HEARTBEAT_REWRITE_SOURCE = "/api/runners/heartbeat";
const RUNNERS_HEARTBEAT_PATH = "/api/runners/heartbeat";
const RUNNERS_HEARTBEAT_NEXT_NEGATIVE_PATHS = [
  "/api/runners/heartbeat/extra",
  "/api/runners",
] as const;
const RUNNERS_JOB_CLAIM_REWRITE_SOURCE = "/api/runners/jobs/:id/claim";
const RUNNERS_JOB_CLAIM_PATH =
  "/api/runners/jobs/11111111-1111-4111-8111-111111111111/claim";
const RUNNERS_JOB_CLAIM_NEXT_NEGATIVE_PATHS = [
  "/api/runners/jobs/11111111-1111-4111-8111-111111111111/claim/extra",
  "/api/runners/jobs/11111111-1111-4111-8111-111111111111",
  "/api/runners/jobs",
  "/api/runners",
] as const;
const RUNNERS_POLL_REWRITE_SOURCE = "/api/runners/poll";
const RUNNERS_POLL_PATH = "/api/runners/poll";
const RUNNERS_POLL_NEXT_NEGATIVE_PATHS = [
  "/api/runners/poll/extra",
  "/api/runners",
] as const;
const RUNNERS_REALTIME_TOKEN_REWRITE_SOURCE = "/api/runners/realtime/token";
const RUNNERS_REALTIME_TOKEN_PATH = "/api/runners/realtime/token";
const RUNNERS_REALTIME_TOKEN_NEXT_NEGATIVE_PATHS = [
  "/api/runners/realtime/token/extra",
  "/api/runners/realtime",
  "/api/runners",
] as const;
const AGENTPHONE_CONNECT_REWRITE_SOURCE = "/api/agentphone/connect";
const AGENTPHONE_CONNECT_PATH = "/api/agentphone/connect";
const AGENTPHONE_CONNECT_NEXT_NEGATIVE_PATHS = [
  "/api/agentphone/connect/extra",
  "/api/agentphone",
  "/api/agentphone/webhook",
] as const;
const AGENTPHONE_WEBHOOK_REWRITE_SOURCE = "/api/agentphone/webhook";
const AGENTPHONE_WEBHOOK_PATH = "/api/agentphone/webhook";
const AGENTPHONE_WEBHOOK_NEXT_NEGATIVE_PATHS = [
  "/api/agentphone/webhook/extra",
  "/api/agentphone",
  "/api/agentphone/messages",
] as const;
const INTERNAL_CALLBACKS_AGENT_REWRITE_SOURCE = "/api/internal/callbacks/agent";
const INTERNAL_CALLBACKS_AGENT_PATH = "/api/internal/callbacks/agent";
const INTERNAL_CALLBACKS_AGENT_NEXT_NEGATIVE_PATHS = [
  "/api/internal/callbacks/agent/extra",
  "/api/internal/callbacks",
] as const;
const INTERNAL_CALLBACKS_CHAT_REWRITE_SOURCE = "/api/internal/callbacks/chat";
const INTERNAL_CALLBACKS_CHAT_PATH = "/api/internal/callbacks/chat";
const INTERNAL_CALLBACKS_CHAT_NEXT_NEGATIVE_PATHS = [
  "/api/internal/callbacks/chat/extra",
  "/api/internal/callbacks",
] as const;
const INTERNAL_CALLBACKS_GITHUB_ISSUES_REWRITE_SOURCE =
  "/api/internal/callbacks/github/issues";
const INTERNAL_CALLBACKS_GITHUB_ISSUES_PATH =
  "/api/internal/callbacks/github/issues";
const INTERNAL_CALLBACKS_GITHUB_ISSUES_NEXT_NEGATIVE_PATHS = [
  "/api/internal/callbacks/github/issues/extra",
  "/api/internal/callbacks/github",
  "/api/internal/callbacks",
] as const;
const INTERNAL_CALLBACKS_SCHEDULE_CRON_REWRITE_SOURCE =
  "/api/internal/callbacks/schedule/cron";
const INTERNAL_CALLBACKS_SCHEDULE_CRON_PATH =
  "/api/internal/callbacks/schedule/cron";
const INTERNAL_CALLBACKS_SCHEDULE_CRON_NEXT_NEGATIVE_PATHS = [
  "/api/internal/callbacks/schedule/cron/extra",
  "/api/internal/callbacks/schedule",
  "/api/internal/callbacks",
] as const;
const INTERNAL_CALLBACKS_SCHEDULE_LOOP_REWRITE_SOURCE =
  "/api/internal/callbacks/schedule/loop";
const INTERNAL_CALLBACKS_SCHEDULE_LOOP_PATH =
  "/api/internal/callbacks/schedule/loop";
const INTERNAL_CALLBACKS_SCHEDULE_LOOP_NEXT_NEGATIVE_PATHS = [
  "/api/internal/callbacks/schedule/loop/extra",
  "/api/internal/callbacks/schedule",
  "/api/internal/callbacks",
] as const;
const INTERNAL_CALLBACKS_SLACK_ORG_REWRITE_SOURCE =
  "/api/internal/callbacks/slack/org";
const INTERNAL_CALLBACKS_SLACK_ORG_PATH = "/api/internal/callbacks/slack/org";
const INTERNAL_CALLBACKS_SLACK_ORG_NEXT_NEGATIVE_PATHS = [
  "/api/internal/callbacks/slack/org/extra",
  "/api/internal/callbacks/slack",
  "/api/internal/callbacks",
] as const;
const INTERNAL_CALLBACKS_TELEGRAM_REWRITE_SOURCE =
  "/api/internal/callbacks/telegram";
const INTERNAL_CALLBACKS_TELEGRAM_PATH = "/api/internal/callbacks/telegram";
const INTERNAL_CALLBACKS_TELEGRAM_NEXT_NEGATIVE_PATHS = [
  "/api/internal/callbacks/telegram/extra",
  "/api/internal/callbacks",
] as const;
const INTERNAL_CALLBACKS_VOICE_CHAT_REWRITE_SOURCE =
  "/api/internal/callbacks/voice-chat";
const INTERNAL_CALLBACKS_VOICE_CHAT_PATH = "/api/internal/callbacks/voice-chat";
const INTERNAL_CALLBACKS_VOICE_CHAT_NEXT_NEGATIVE_PATHS = [
  "/api/internal/callbacks/voice-chat/extra",
  "/api/internal/callbacks",
] as const;
const EMAIL_UNSUBSCRIBE_REWRITE_SOURCE = "/api/email/unsubscribe";
const EMAIL_UNSUBSCRIBE_PATH = "/api/email/unsubscribe";
const EMAIL_UNSUBSCRIBE_NEXT_NEGATIVE_PATHS = [
  "/api/email/unsubscribe/extra",
  "/api/email",
] as const;
const ZERO_EMAIL_INBOUND_REWRITE_SOURCE = "/api/zero/email/inbound";
const ZERO_EMAIL_INBOUND_PATH = "/api/zero/email/inbound";
const ZERO_EMAIL_INBOUND_NEXT_NEGATIVE_PATHS = [
  "/api/zero/email/inbound/extra",
  "/api/zero/email",
] as const;
const ZERO_EMAIL_REPLY_CALLBACK_REWRITE_SOURCE =
  "/api/zero/email/callbacks/reply";
const ZERO_EMAIL_REPLY_CALLBACK_PATH = "/api/zero/email/callbacks/reply";
const ZERO_EMAIL_REPLY_CALLBACK_NEXT_NEGATIVE_PATHS = [
  "/api/zero/email/callbacks/reply/extra",
  "/api/zero/email/callbacks",
] as const;
const ZERO_EMAIL_TRIGGER_CALLBACK_REWRITE_SOURCE =
  "/api/zero/email/callbacks/trigger";
const ZERO_EMAIL_TRIGGER_CALLBACK_PATH = "/api/zero/email/callbacks/trigger";
const ZERO_EMAIL_TRIGGER_CALLBACK_NEXT_NEGATIVE_PATHS = [
  "/api/zero/email/callbacks/trigger/extra",
  "/api/zero/email/callbacks",
] as const;
const GENERATE_IMAGE_REWRITE_SOURCE = "/api/generate-image";
const GENERATE_IMAGE_PATH = "/api/generate-image";
const GENERATE_IMAGE_NEXT_NEGATIVE_PATHS = [
  "/api/generate-image/extra",
  "/api/generate",
] as const;
const GITHUB_OAUTH_CALLBACK_REWRITE_SOURCE = "/api/github/oauth/callback";
const GITHUB_OAUTH_CALLBACK_PATH = "/api/github/oauth/callback";
const GITHUB_OAUTH_CALLBACK_NEXT_NEGATIVE_PATHS = [
  "/api/github/oauth/callback/extra",
  "/api/github/oauth/install",
  "/api/github/oauth",
] as const;
const GITHUB_OAUTH_INSTALL_REWRITE_SOURCE = "/api/github/oauth/install";
const GITHUB_OAUTH_INSTALL_PATH = "/api/github/oauth/install";
const GITHUB_OAUTH_INSTALL_NEXT_NEGATIVE_PATHS = [
  "/api/github/oauth/install/extra",
  "/api/github/oauth",
] as const;
const LOGS_SEARCH_REWRITE_SOURCE = "/api/logs/search";
const LOGS_SEARCH_PATH = "/api/logs/search";
const LOGS_SEARCH_NEXT_NEGATIVE_PATHS = [
  "/api/logs/search/extra",
  "/api/logs",
] as const;
const ZERO_LOGS_REWRITE_SOURCE = "/api/zero/logs";
const ZERO_LOGS_PATH = "/api/zero/logs";
const ZERO_LOGS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/logs/search",
  "/api/zero/logs/extra",
  "/api/zero",
] as const;
const ZERO_LOGS_SEARCH_REWRITE_SOURCE = "/api/zero/logs/search";
const ZERO_LOGS_SEARCH_PATH = "/api/zero/logs/search";
const ZERO_LOGS_SEARCH_NEXT_NEGATIVE_PATHS = [
  "/api/zero/logs/search/extra",
  "/api/zero/logs/searches",
  "/api/zero/logs",
] as const;
const ZERO_LOGS_BY_ID_REWRITE_SOURCE =
  "/api/zero/logs/:id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})";
const ZERO_LOGS_BY_ID_PATH = `/api/zero/logs/${ZERO_LOG_ID}`;
const ZERO_LOGS_BY_ID_NEXT_NEGATIVE_PATHS = [
  "/api/zero/logs",
  "/api/zero/logs/search",
  "/api/zero/logs/not-a-uuid",
  `/api/zero/logs/${ZERO_LOG_ID}/extra`,
] as const;
const INTEGRATIONS_GITHUB_REWRITE_SOURCE = "/api/integrations/github";
const INTEGRATIONS_GITHUB_PATH = "/api/integrations/github";
const INTEGRATIONS_GITHUB_NEXT_NEGATIVE_PATHS = [
  "/api/integrations/github/extra",
  "/api/integrations",
] as const;
const BUILT_IN_GENERATIONS_FAL_WEBHOOK_REWRITE_SOURCE =
  "/api/webhooks/built-in-generations/fal/:generationId([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})";
const BUILT_IN_GENERATIONS_FAL_WEBHOOK_PATH =
  "/api/webhooks/built-in-generations/fal/550e8400-e29b-41d4-a716-446655440000";
const BUILT_IN_GENERATIONS_FAL_WEBHOOK_NEXT_NEGATIVE_PATHS = [
  "/api/webhooks/built-in-generations/fal/not-a-uuid",
  "/api/webhooks/built-in-generations/fal/550e8400-e29b-41d4-a716-446655440000/extra",
  "/api/webhooks/built-in-generations",
] as const;
const AGENT_CHECKPOINTS_PREPARE_HISTORY_REWRITE_SOURCE =
  "/api/webhooks/agent/checkpoints/prepare-history";
const AGENT_CHECKPOINTS_PREPARE_HISTORY_PATH =
  "/api/webhooks/agent/checkpoints/prepare-history";
const AGENT_CHECKPOINTS_PREPARE_HISTORY_NEXT_NEGATIVE_PATHS = [
  "/api/webhooks/agent/checkpoints/prepare-history/extra",
  "/api/webhooks/agent/checkpoints",
  "/api/webhooks/agent",
] as const;
const AGENT_COMPLETE_REWRITE_SOURCE = "/api/webhooks/agent/complete";
const AGENT_COMPLETE_PATH = "/api/webhooks/agent/complete";
const AGENT_COMPLETE_NEXT_NEGATIVE_PATHS = [
  "/api/webhooks/agent/complete/extra",
  "/api/webhooks/agent/checkpoints",
  "/api/webhooks/agent",
] as const;
const AGENT_EVENTS_REWRITE_SOURCE = "/api/webhooks/agent/events";
const AGENT_EVENTS_PATH = "/api/webhooks/agent/events";
const AGENT_EVENTS_NEXT_NEGATIVE_PATHS = [
  "/api/webhooks/agent/events/extra",
  "/api/webhooks/agent/checkpoints",
  "/api/webhooks/agent",
] as const;
const AGENT_FIREWALL_AUTH_REWRITE_SOURCE = "/api/webhooks/agent/firewall/auth";
const AGENT_FIREWALL_AUTH_PATH = "/api/webhooks/agent/firewall/auth";
const AGENT_FIREWALL_AUTH_NEXT_NEGATIVE_PATHS = [
  "/api/webhooks/agent/firewall/auth/extra",
  "/api/webhooks/agent/firewall",
  "/api/webhooks/agent",
] as const;
const AGENT_HEARTBEAT_REWRITE_SOURCE = "/api/webhooks/agent/heartbeat";
const AGENT_HEARTBEAT_PATH = "/api/webhooks/agent/heartbeat";
const AGENT_HEARTBEAT_NEXT_NEGATIVE_PATHS = [
  "/api/webhooks/agent/heartbeat/extra",
  "/api/webhooks/agent",
] as const;
const AGENT_TELEMETRY_REWRITE_SOURCE = "/api/webhooks/agent/telemetry";
const AGENT_TELEMETRY_PATH = "/api/webhooks/agent/telemetry";
const AGENT_TELEMETRY_NEXT_NEGATIVE_PATHS = [
  "/api/webhooks/agent/telemetry/extra",
  "/api/webhooks/agent",
] as const;
const AGENT_USAGE_EVENT_REWRITE_SOURCE = "/api/webhooks/agent/usage-event";
const AGENT_USAGE_EVENT_PATH = "/api/webhooks/agent/usage-event";
const AGENT_USAGE_EVENT_NEXT_NEGATIVE_PATHS = [
  "/api/webhooks/agent/usage-event/extra",
  "/api/webhooks/agent",
] as const;
const AGENT_STORAGES_COMMIT_REWRITE_SOURCE =
  "/api/webhooks/agent/storages/commit";
const AGENT_STORAGES_COMMIT_PATH = "/api/webhooks/agent/storages/commit";
const AGENT_STORAGES_COMMIT_NEXT_NEGATIVE_PATHS = [
  "/api/webhooks/agent/storages/commit/extra",
  "/api/webhooks/agent/storages/commitment",
  "/api/webhooks/agent/storages",
] as const;
const AGENT_STORAGES_PREPARE_REWRITE_SOURCE =
  "/api/webhooks/agent/storages/prepare";
const AGENT_STORAGES_PREPARE_PATH = "/api/webhooks/agent/storages/prepare";
const AGENT_STORAGES_PREPARE_NEXT_NEGATIVE_PATHS = [
  "/api/webhooks/agent/storages/prepare/extra",
  "/api/webhooks/agent/storages/prepared",
  "/api/webhooks/agent/storages",
] as const;
const AGENT_CHECKPOINTS_REWRITE_SOURCE = "/api/webhooks/agent/checkpoints";
const AGENT_CHECKPOINTS_PATH = "/api/webhooks/agent/checkpoints";
const AGENT_CHECKPOINTS_NEXT_NEGATIVE_PATHS = [
  "/api/webhooks/agent/checkpoints/prepare-history",
  "/api/webhooks/agent/checkpoints/extra",
  "/api/webhooks/agent",
] as const;
const CLERK_WEBHOOK_REWRITE_SOURCE = "/api/webhooks/clerk";
const CLERK_WEBHOOK_PATH = "/api/webhooks/clerk";
const CLERK_WEBHOOK_NEXT_NEGATIVE_PATHS = [
  "/api/webhooks/clerk/extra",
  "/api/webhooks",
] as const;
const GITHUB_WEBHOOK_REWRITE_SOURCE = "/api/webhooks/github";
const GITHUB_WEBHOOK_PATH = "/api/webhooks/github";
const GITHUB_WEBHOOK_NEXT_NEGATIVE_PATHS = [
  "/api/webhooks/github/extra",
  "/api/webhooks",
] as const;
const STRIPE_WEBHOOK_REWRITE_SOURCE = "/api/webhooks/stripe";
const STRIPE_WEBHOOK_PATH = "/api/webhooks/stripe";
const STRIPE_WEBHOOK_NEXT_NEGATIVE_PATHS = [
  "/api/webhooks/stripe/extra",
  "/api/webhooks",
] as const;
const STORAGES_COMMIT_REWRITE_SOURCE = "/api/storages/commit";
const STORAGES_COMMIT_PATH = "/api/storages/commit";
const STORAGES_COMMIT_NEXT_NEGATIVE_PATHS = [
  "/api/storages/commit/extra",
  "/api/storages",
  "/api/storages/commits",
] as const;
const STORAGES_DOWNLOAD_REWRITE_SOURCE = "/api/storages/download";
const STORAGES_DOWNLOAD_PATH = "/api/storages/download";
const STORAGES_DOWNLOAD_NEXT_NEGATIVE_PATHS = [
  "/api/storages/download/extra",
  "/api/storages",
  "/api/storages/downloads",
] as const;
const STORAGES_LIST_REWRITE_SOURCE = "/api/storages/list";
const STORAGES_LIST_PATH = "/api/storages/list";
const STORAGES_LIST_NEXT_NEGATIVE_PATHS = [
  "/api/storages/list/extra",
  "/api/storages",
  "/api/storages/lists",
] as const;
const STORAGES_PREPARE_REWRITE_SOURCE = "/api/storages/prepare";
const STORAGES_PREPARE_PATH = "/api/storages/prepare";
const STORAGES_PREPARE_NEXT_NEGATIVE_PATHS = [
  "/api/storages/prepare/extra",
  "/api/storages",
  "/api/storages/prepared",
] as const;
const USAGE_REWRITE_SOURCE = "/api/usage";
const USAGE_PATH = "/api/usage";
const USAGE_NEXT_NEGATIVE_PATHS = ["/api/usage/extra", "/api/usages"] as const;
const TEST_SLACK_DISPATCH_PROBE_REWRITE_SOURCE =
  "/api/test/slack-dispatch-probe";
const TEST_SLACK_DISPATCH_PROBE_PATH = "/api/test/slack-dispatch-probe";
const TEST_SLACK_DISPATCH_PROBE_NEXT_NEGATIVE_PATHS = [
  "/api/test/slack-dispatch-probe/extra",
  "/api/test/slack-dispatch",
] as const;
const TEST_SLACK_MOCK_ASSISTANT_STATUS_REWRITE_SOURCE =
  "/api/test/slack-mock/assistant.threads.setStatus";
const TEST_SLACK_MOCK_ASSISTANT_STATUS_PATH =
  "/api/test/slack-mock/assistant.threads.setStatus";
const TEST_SLACK_MOCK_ASSISTANT_STATUS_NEXT_NEGATIVE_PATHS = [
  "/api/test/slack-mock/assistant.threads.setStatus/extra",
  "/api/test/slack-mock",
] as const;
const TEST_SLACK_MOCK_CHAT_POST_EPHEMERAL_REWRITE_SOURCE =
  "/api/test/slack-mock/chat.postEphemeral";
const TEST_SLACK_MOCK_CHAT_POST_EPHEMERAL_PATH =
  "/api/test/slack-mock/chat.postEphemeral";
const TEST_SLACK_MOCK_CHAT_POST_EPHEMERAL_NEXT_NEGATIVE_PATHS = [
  "/api/test/slack-mock/chat.postEphemeral/extra",
  "/api/test/slack-mock",
  "/api/test/slack-mock/chat.postMessage",
] as const;
const TEST_SLACK_MOCK_CONVERSATIONS_OPEN_REWRITE_SOURCE =
  "/api/test/slack-mock/conversations.open";
const TEST_SLACK_MOCK_CONVERSATIONS_OPEN_PATH =
  "/api/test/slack-mock/conversations.open";
const TEST_SLACK_MOCK_CONVERSATIONS_OPEN_NEXT_NEGATIVE_PATHS = [
  "/api/test/slack-mock/conversations.open/extra",
  "/api/test/slack-mock/conversations",
  "/api/test/slack-mock/conversations.opens",
] as const;
const TEST_SLACK_STATE_REWRITE_SOURCE = "/api/test/slack-state";
const TEST_SLACK_STATE_PATH = "/api/test/slack-state";
const TEST_SLACK_STATE_NEXT_NEGATIVE_PATHS = [
  "/api/test/slack-state/extra",
  "/api/test/slack-states",
] as const;
const TEST_TELEGRAM_STATE_REWRITE_SOURCE = "/api/test/telegram-state";
const TEST_TELEGRAM_STATE_PATH = "/api/test/telegram-state";
const TEST_TELEGRAM_STATE_NEXT_NEGATIVE_PATHS = [
  "/api/test/telegram-state/extra",
  "/api/test/telegram-states",
] as const;
const TELEGRAM_REGISTER_REWRITE_SOURCE = "/api/telegram/register";
const TELEGRAM_REGISTER_PATH = "/api/telegram/register";
const TELEGRAM_REGISTER_NEXT_NEGATIVE_PATHS = [
  "/api/telegram/register/extra",
  "/api/telegram/registrations",
] as const;
const TELEGRAM_SETUP_STATUS_REWRITE_SOURCE = "/api/telegram/setup-status";
const TELEGRAM_SETUP_STATUS_PATH = "/api/telegram/setup-status";
const TELEGRAM_SETUP_STATUS_NEXT_NEGATIVE_PATHS = [
  "/api/telegram/setup-status/extra",
  "/api/telegram/setup",
] as const;
const TELEGRAM_WEBHOOK_REWRITE_SOURCE = "/api/telegram/webhook/:telegramBotId";
const TELEGRAM_WEBHOOK_PATH =
  "/api/telegram/webhook/123456789:telegram-bot-token";
const TELEGRAM_WEBHOOK_NEXT_NEGATIVE_PATHS = [
  "/api/telegram/webhook",
  "/api/telegram/webhook/123456789:telegram-bot-token/extra",
  "/api/telegram/webhooks/123456789:telegram-bot-token",
] as const;
const TELEGRAM_INTEGRATIONS_REWRITE_SOURCE = "/api/integrations/telegram";
const TELEGRAM_INTEGRATIONS_PATH = "/api/integrations/telegram";
const TELEGRAM_INTEGRATIONS_NEXT_NEGATIVE_PATHS = [
  "/api/integrations/telegram/extra",
  "/api/integrations/telegrams",
] as const;
const TELEGRAM_INTEGRATIONS_PROXY_NEGATIVE_PATHS = [
  "/api/integrations/telegrams",
] as const;
const TELEGRAM_LINK_REWRITE_SOURCE = "/api/integrations/telegram/link";
const TELEGRAM_LINK_PATH = "/api/integrations/telegram/link";
const TELEGRAM_LINK_NEXT_NEGATIVE_PATHS = [
  "/api/integrations/telegram/link/extra",
  "/api/integrations/telegram/links",
] as const;
const TELEGRAM_LINK_PROXY_NEGATIVE_PATHS = [
  "/api/integrations/telegram/link/extra",
] as const;
const TELEGRAM_BOT_REWRITE_SOURCE =
  "/api/integrations/telegram/:botId((?!link$|auth-callback$)[^/]+)";
const TELEGRAM_BOT_PATH = "/api/integrations/telegram/123456789";
const TELEGRAM_BOT_NEXT_NEGATIVE_PATHS = [
  "/api/integrations/telegram",
  "/api/integrations/telegram/123456789/avatar",
  "/api/integrations/telegram/123456789/extra",
  "/api/integrations/telegram/link",
  "/api/integrations/telegram/auth-callback",
] as const;
const TELEGRAM_BOT_PROXY_NEGATIVE_PATHS = [
  "/api/integrations/telegram/123456789/extra",
] as const;
const TELEGRAM_AVATAR_REWRITE_SOURCE =
  "/api/integrations/telegram/:botId/avatar";
const TELEGRAM_AVATAR_PATH = "/api/integrations/telegram/123456789/avatar";
const TELEGRAM_AVATAR_NEXT_NEGATIVE_PATHS = [
  "/api/integrations/telegram/123456789/avatar/extra",
  "/api/integrations/telegram/avatar",
  "/api/integrations/telegram/123456789/avatars",
] as const;
const TELEGRAM_AVATAR_PROXY_NEGATIVE_PATHS = [
  "/api/integrations/telegram/123456789/avatar/extra",
  "/api/integrations/telegram/123456789/avatars",
] as const;
const TELEGRAM_AUTH_CALLBACK_REWRITE_SOURCE =
  "/api/integrations/telegram/auth-callback";
const TELEGRAM_AUTH_CALLBACK_PATH = "/api/integrations/telegram/auth-callback";
const TELEGRAM_AUTH_CALLBACK_NEXT_NEGATIVE_PATHS = [
  "/api/integrations/telegram/auth-callback/extra",
  "/api/integrations/telegram/auth",
] as const;
const TELEGRAM_AUTH_CALLBACK_PROXY_NEGATIVE_PATHS = [
  "/api/integrations/telegram/auth-callback/extra",
] as const;
const USER_MODEL_PREFERENCE_REWRITE_SOURCE = "/api/zero/user-model-preference";
const USER_MODEL_PREFERENCE_PATH = "/api/zero/user-model-preference";
const USER_MODEL_PREFERENCE_NEXT_NEGATIVE_PATHS = [
  "/api/zero/user-model-preference/extra",
  "/api/zero/user-preferences",
] as const;
const ZERO_API_KEYS_REWRITE_SOURCE = "/api/zero/api-keys";
const ZERO_API_KEYS_PATH = "/api/zero/api-keys";
const ZERO_API_KEYS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/api-key",
  "/api/zero/api-keys/extra",
] as const;
const ZERO_BILLING_AUTO_RECHARGE_REWRITE_SOURCE =
  "/api/zero/billing/auto-recharge";
const ZERO_BILLING_AUTO_RECHARGE_PATH = "/api/zero/billing/auto-recharge";
const ZERO_BILLING_AUTO_RECHARGE_NEXT_NEGATIVE_PATHS = [
  "/api/zero/billing",
  "/api/zero/billing/auto-recharge/extra",
  "/api/zero/billing/auto-recharges",
] as const;
const ZERO_BILLING_CHECKOUT_REWRITE_SOURCE = "/api/zero/billing/checkout";
const ZERO_BILLING_CHECKOUT_PATH = "/api/zero/billing/checkout";
const ZERO_BILLING_CHECKOUT_NEXT_NEGATIVE_PATHS = [
  "/api/zero/billing",
  "/api/zero/billing/checkout/extra",
  "/api/zero/billing/checkout-session",
] as const;
const ZERO_BILLING_DOWNGRADE_REWRITE_SOURCE = "/api/zero/billing/downgrade";
const ZERO_BILLING_DOWNGRADE_PATH = "/api/zero/billing/downgrade";
const ZERO_BILLING_DOWNGRADE_NEXT_NEGATIVE_PATHS = [
  "/api/zero/billing",
  "/api/zero/billing/downgrade/extra",
  "/api/zero/billing/downgrades",
] as const;
const ZERO_BILLING_INVOICES_REWRITE_SOURCE = "/api/zero/billing/invoices";
const ZERO_BILLING_INVOICES_PATH = "/api/zero/billing/invoices";
const ZERO_BILLING_INVOICES_NEXT_NEGATIVE_PATHS = [
  "/api/zero/billing",
  "/api/zero/billing/invoices/extra",
  "/api/zero/billing/invoice",
] as const;
const ZERO_BILLING_PORTAL_REWRITE_SOURCE = "/api/zero/billing/portal";
const ZERO_BILLING_PORTAL_PATH = "/api/zero/billing/portal";
const ZERO_BILLING_PORTAL_NEXT_NEGATIVE_PATHS = [
  "/api/zero/billing",
  "/api/zero/billing/portal/extra",
  "/api/zero/billing/portals",
] as const;
const ZERO_BILLING_REDEEM_REWRITE_SOURCE = "/api/zero/billing/redeem/:campaign";
const ZERO_BILLING_REDEEM_PATH = "/api/zero/billing/redeem/ZERO100";
const ZERO_BILLING_REDEEM_NEXT_NEGATIVE_PATHS = [
  "/api/zero/billing",
  "/api/zero/billing/redeem",
  "/api/zero/billing/redeem/ZERO100/extra",
  "/api/zero/billing/redeems/ZERO100",
] as const;
const ZERO_BILLING_STATUS_REWRITE_SOURCE = "/api/zero/billing/status";
const ZERO_BILLING_STATUS_PATH = "/api/zero/billing/status";
const ZERO_BILLING_STATUS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/billing",
  "/api/zero/billing/status/extra",
] as const;
const ZERO_DEFAULT_AGENT_REWRITE_SOURCE = "/api/zero/default-agent";
const ZERO_DEFAULT_AGENT_PATH = "/api/zero/default-agent";
const ZERO_DEFAULT_AGENT_NEXT_NEGATIVE_PATHS = [
  "/api/zero/default-agent/extra",
  "/api/zero/default-agents",
  "/api/zero",
] as const;
const ZERO_DEVELOPER_SUPPORT_REWRITE_SOURCE = "/api/zero/developer-support";
const ZERO_DEVELOPER_SUPPORT_PATH = "/api/zero/developer-support";
const ZERO_DEVELOPER_SUPPORT_NEXT_NEGATIVE_PATHS = [
  "/api/zero/developer",
  "/api/zero/developer-support/extra",
] as const;
const ZERO_API_KEY_BY_ID_REWRITE_SOURCE =
  "/api/zero/api-keys/:id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})";
const ZERO_API_KEY_BY_ID_PATH = `/api/zero/api-keys/${ZERO_API_KEY_ID}`;
const ZERO_API_KEY_BY_ID_NEXT_NEGATIVE_PATHS = [
  "/api/zero/api-keys",
  "/api/zero/api-keys/not-a-uuid",
  `/api/zero/api-keys/${ZERO_API_KEY_ID}/extra`,
] as const;
const ZERO_API_KEY_BY_ID_PROXY_NEGATIVE_PATHS = [
  "/api/zero/api-keys/not-a-uuid",
  `/api/zero/api-keys/${ZERO_API_KEY_ID}/extra`,
] as const;
const ZERO_ME_MODEL_PROVIDERS_REWRITE_SOURCE = "/api/zero/me/model-providers";
const ZERO_ME_MODEL_PROVIDERS_PATH = "/api/zero/me/model-providers";
const ZERO_ME_MODEL_PROVIDERS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/me/model-provider",
  "/api/zero/me/model-providers/claude-code-oauth-token",
  "/api/zero/me/model-providers/claude-code-oauth-token/oauth/authorize",
] as const;
const ZERO_ME_MODEL_PROVIDER_TYPE_REWRITE_SOURCE =
  "/api/zero/me/model-providers/:type";
const ZERO_ME_MODEL_PROVIDER_TYPE_PATH =
  "/api/zero/me/model-providers/claude-code-oauth-token";
const ZERO_ME_MODEL_PROVIDER_TYPE_NEXT_NEGATIVE_PATHS = [
  "/api/zero/me/model-providers",
  "/api/zero/me/model-providers/claude-code-oauth-token/oauth/authorize",
  "/api/zero/me/model-providers/claude-code-oauth-token/oauth/callback",
  "/api/zero/me/model-providers/claude-code-oauth-token/extra",
] as const;
const ZERO_MODEL_PROVIDERS_REWRITE_SOURCE = "/api/zero/model-providers";
const ZERO_MODEL_PROVIDERS_PATH = "/api/zero/model-providers";
const ZERO_MODEL_PROVIDERS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/model-providers/anthropic-api-key/extra",
  "/api/zero/model-provider",
] as const;
const ONBOARDING_STATUS_REWRITE_SOURCE = "/api/zero/onboarding/status";
const ONBOARDING_STATUS_PATH = "/api/zero/onboarding/status";
const ONBOARDING_STATUS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/onboarding/status/extra",
  "/api/zero/onboarding",
] as const;
const ONBOARDING_SETUP_REWRITE_SOURCE = "/api/zero/onboarding/setup";
const ONBOARDING_SETUP_PATH = "/api/zero/onboarding/setup";
const ONBOARDING_SETUP_NEXT_NEGATIVE_PATHS = [
  "/api/zero/onboarding/setup/extra",
  "/api/zero/onboarding",
] as const;
const PERMISSION_POLICIES_REWRITE_SOURCE = "/api/zero/permission-policies";
const PERMISSION_POLICIES_PATH = "/api/zero/permission-policies";
const PERMISSION_POLICIES_NEXT_NEGATIVE_PATHS = [
  "/api/zero/permission-policies/extra",
  "/api/zero/permission-policy",
] as const;
const ZERO_MODEL_PROVIDER_TYPE_REWRITE_SOURCE =
  "/api/zero/model-providers/:type";
const ZERO_MODEL_PROVIDER_TYPE_PATH =
  "/api/zero/model-providers/anthropic-api-key";
const ZERO_MODEL_PROVIDER_TYPE_NEXT_NEGATIVE_PATHS = [
  "/api/zero/model-providers",
  "/api/zero/model-providers/anthropic-api-key/extra",
  "/api/zero/model-provider/anthropic-api-key",
] as const;
const ZERO_AGENTS_REWRITE_SOURCE = "/api/zero/agents";
const ZERO_AGENTS_PATH = "/api/zero/agents";
const ZERO_AGENTS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/agents/550e8400-e29b-41d4-a716-446655440000",
  "/api/zero/agent",
] as const;
const ZERO_AGENT_BY_ID_REWRITE_SOURCE = "/api/zero/agents/:id";
const ZERO_AGENT_BY_ID_PATH =
  "/api/zero/agents/550e8400-e29b-41d4-a716-446655440000";
const ZERO_AGENT_BY_ID_NEXT_NEGATIVE_PATHS = [
  "/api/zero/agents",
  "/api/zero/agents/550e8400-e29b-41d4-a716-446655440000/extra",
  "/api/zero/agent/550e8400-e29b-41d4-a716-446655440000",
] as const;
const ZERO_AGENT_CUSTOM_CONNECTORS_REWRITE_SOURCE =
  "/api/zero/agents/:id/custom-connectors";
const ZERO_AGENT_CUSTOM_CONNECTORS_PATH =
  "/api/zero/agents/550e8400-e29b-41d4-a716-446655440000/custom-connectors";
const ZERO_AGENT_CUSTOM_CONNECTORS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/agents/550e8400-e29b-41d4-a716-446655440000/custom-connectors/extra",
  "/api/zero/agents/custom-connectors",
  "/api/zero/agent/550e8400-e29b-41d4-a716-446655440000/custom-connectors",
] as const;
const ZERO_AGENT_USER_CONNECTORS_REWRITE_SOURCE =
  "/api/zero/agents/:id/user-connectors";
const ZERO_AGENT_USER_CONNECTORS_PATH =
  "/api/zero/agents/550e8400-e29b-41d4-a716-446655440000/user-connectors";
const ZERO_AGENT_USER_CONNECTORS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/agents/550e8400-e29b-41d4-a716-446655440000/user-connectors/extra",
  "/api/zero/agents/user-connectors",
  "/api/zero/agent/550e8400-e29b-41d4-a716-446655440000/user-connectors",
] as const;
const ZERO_CUSTOM_CONNECTORS_REWRITE_SOURCE = "/api/zero/custom-connectors";
const ZERO_CUSTOM_CONNECTORS_PATH = "/api/zero/custom-connectors";
const ZERO_CUSTOM_CONNECTORS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/custom-connectors/550e8400-e29b-41d4-a716-446655440000",
  "/api/zero/custom-connectors/550e8400-e29b-41d4-a716-446655440000/secret",
  "/api/zero/custom-connector",
] as const;
const ZERO_CUSTOM_CONNECTOR_BY_ID_REWRITE_SOURCE =
  "/api/zero/custom-connectors/:id";
const ZERO_CUSTOM_CONNECTOR_BY_ID_PATH =
  "/api/zero/custom-connectors/550e8400-e29b-41d4-a716-446655440000";
const ZERO_CUSTOM_CONNECTOR_BY_ID_NEXT_NEGATIVE_PATHS = [
  "/api/zero/custom-connectors",
  "/api/zero/custom-connectors/550e8400-e29b-41d4-a716-446655440000/extra",
  "/api/zero/custom-connector/550e8400-e29b-41d4-a716-446655440000",
] as const;
const ZERO_CUSTOM_CONNECTOR_SECRET_REWRITE_SOURCE =
  "/api/zero/custom-connectors/:id/secret";
const ZERO_CUSTOM_CONNECTOR_SECRET_PATH =
  "/api/zero/custom-connectors/550e8400-e29b-41d4-a716-446655440000/secret";
const ZERO_CUSTOM_CONNECTOR_SECRET_NEXT_NEGATIVE_PATHS = [
  "/api/zero/custom-connectors",
  "/api/zero/custom-connectors/550e8400-e29b-41d4-a716-446655440000",
  "/api/zero/custom-connectors/550e8400-e29b-41d4-a716-446655440000/secret/extra",
  "/api/zero/custom-connector/550e8400-e29b-41d4-a716-446655440000/secret",
] as const;
const ZERO_AGENT_INSTRUCTIONS_REWRITE_SOURCE =
  "/api/zero/agents/:id/instructions";
const ZERO_AGENT_INSTRUCTIONS_PATH =
  "/api/zero/agents/550e8400-e29b-41d4-a716-446655440000/instructions";
const ZERO_AGENT_INSTRUCTIONS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/agents/550e8400-e29b-41d4-a716-446655440000/instructions/extra",
  "/api/zero/agents/instructions",
  "/api/zero/agent/550e8400-e29b-41d4-a716-446655440000/instructions",
] as const;
const PUSH_SUBSCRIPTIONS_REWRITE_SOURCE = "/api/zero/push-subscriptions";
const PUSH_SUBSCRIPTIONS_PATH = "/api/zero/push-subscriptions";
const PUSH_SUBSCRIPTIONS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/push-subscriptions/extra",
  "/api/zero/push-subscription",
] as const;
const QUEUE_POSITION_REWRITE_SOURCE = "/api/zero/queue-position";
const QUEUE_POSITION_PATH = "/api/zero/queue-position";
const QUEUE_POSITION_NEXT_NEGATIVE_PATHS = [
  "/api/zero/queue-position/extra",
  "/api/zero/queue-positions",
] as const;
const ZERO_CHAT_SEARCH_REWRITE_SOURCE = "/api/zero/chat/search";
const ZERO_CHAT_SEARCH_PATH = "/api/zero/chat/search";
const ZERO_CHAT_SEARCH_NEXT_NEGATIVE_PATHS = [
  "/api/zero/chat/search/extra",
  "/api/zero/chat/searches",
] as const;
const ZERO_CHAT_MESSAGES_REWRITE_SOURCE = "/api/zero/chat/messages";
const ZERO_CHAT_MESSAGES_PATH = "/api/zero/chat/messages";
const ZERO_CHAT_MESSAGES_NEXT_NEGATIVE_PATHS = [
  "/api/zero/chat/messages/extra",
  "/api/zero/chat/message",
] as const;
const ZERO_COMPOSES_REWRITE_SOURCE = "/api/zero/composes";
const ZERO_COMPOSES_PATH = "/api/zero/composes";
const ZERO_COMPOSES_NEXT_NEGATIVE_PATHS = [
  "/api/zero/composes/list",
  "/api/zero/composes/extra",
  "/api/zero/compose",
] as const;
const ZERO_COMPOSES_PROXY_NEGATIVE_PATHS = ["/api/zero/compose"] as const;
const ZERO_COMPOSES_LIST_REWRITE_SOURCE = "/api/zero/composes/list";
const ZERO_COMPOSES_LIST_PATH = "/api/zero/composes/list";
const ZERO_COMPOSES_LIST_NEXT_NEGATIVE_PATHS = [
  "/api/zero/composes",
  "/api/zero/composes/list/extra",
  "/api/zero/composes/lists",
] as const;
const ZERO_COMPOSES_LIST_PROXY_NEGATIVE_PATHS = [
  "/api/zero/composes/list/extra",
] as const;
const ZERO_COMPOSES_BY_ID_REWRITE_SOURCE =
  "/api/zero/composes/:id((?!list$)[^/]+)";
const ZERO_COMPOSES_BY_ID_PATH =
  "/api/zero/composes/550e8400-e29b-41d4-a716-446655440000";
const ZERO_COMPOSES_BY_ID_NEXT_NEGATIVE_PATHS = [
  "/api/zero/composes",
  "/api/zero/composes/list",
  "/api/zero/composes/550e8400-e29b-41d4-a716-446655440000/metadata",
  "/api/zero/composes/550e8400-e29b-41d4-a716-446655440000/extra",
  "/api/zero/compose/550e8400-e29b-41d4-a716-446655440000",
] as const;
const ZERO_COMPOSES_BY_ID_PROXY_NEGATIVE_PATHS = [
  "/api/zero/composes/list/extra",
  "/api/zero/composes/550e8400-e29b-41d4-a716-446655440000/extra",
  "/api/zero/compose/550e8400-e29b-41d4-a716-446655440000",
] as const;
const ZERO_COMPOSES_METADATA_REWRITE_SOURCE = "/api/zero/composes/:id/metadata";
const ZERO_COMPOSES_METADATA_PATH =
  "/api/zero/composes/550e8400-e29b-41d4-a716-446655440000/metadata";
const ZERO_COMPOSES_METADATA_NEXT_NEGATIVE_PATHS = [
  "/api/zero/composes",
  "/api/zero/composes/list",
  "/api/zero/composes/550e8400-e29b-41d4-a716-446655440000",
  "/api/zero/composes/550e8400-e29b-41d4-a716-446655440000/metadata/extra",
  "/api/zero/compose/550e8400-e29b-41d4-a716-446655440000/metadata",
] as const;
const ZERO_COMPOSES_METADATA_PROXY_NEGATIVE_PATHS = [
  "/api/zero/composes/550e8400-e29b-41d4-a716-446655440000/metadata/extra",
  "/api/zero/compose/550e8400-e29b-41d4-a716-446655440000/metadata",
] as const;
const ZERO_COMPUTER_USE_HOST_REWRITE_SOURCE = "/api/zero/computer-use/host";
const ZERO_COMPUTER_USE_HOST_PATH = "/api/zero/computer-use/host";
const ZERO_COMPUTER_USE_HOST_NEXT_NEGATIVE_PATHS = [
  "/api/zero/computer-use/host/extra",
  "/api/zero/computer-use",
] as const;
const ZERO_COMPUTER_USE_REGISTER_REWRITE_SOURCE =
  "/api/zero/computer-use/register";
const ZERO_COMPUTER_USE_REGISTER_PATH = "/api/zero/computer-use/register";
const ZERO_COMPUTER_USE_REGISTER_NEXT_NEGATIVE_PATHS = [
  "/api/zero/computer-use/register/extra",
  "/api/zero/computer-use",
] as const;
const ZERO_COMPUTER_USE_UNREGISTER_REWRITE_SOURCE =
  "/api/zero/computer-use/unregister";
const ZERO_COMPUTER_USE_UNREGISTER_PATH = "/api/zero/computer-use/unregister";
const ZERO_COMPUTER_USE_UNREGISTER_NEXT_NEGATIVE_PATHS = [
  "/api/zero/computer-use/unregister/extra",
  "/api/zero/computer-use",
] as const;
const ZERO_INSIGHTS_RANGE_REWRITE_SOURCE = "/api/zero/insights/range";
const ZERO_INSIGHTS_RANGE_PATH = "/api/zero/insights/range";
const ZERO_INSIGHTS_RANGE_NEXT_NEGATIVE_PATHS = [
  "/api/zero/insights/range/extra",
  "/api/zero/insights",
] as const;
const ZERO_INSIGHTS_REWRITE_SOURCE = "/api/zero/insights";
const ZERO_INSIGHTS_PATH = "/api/zero/insights";
const ZERO_INSIGHTS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/insights/extra",
  "/api/zero/insights/range",
] as const;
const V1_CHAT_THREADS_MESSAGES_REWRITE_SOURCE = "/api/v1/chat-threads/messages";
const V1_CHAT_THREADS_MESSAGES_PATH = "/api/v1/chat-threads/messages";
const V1_CHAT_THREADS_MESSAGES_NEXT_NEGATIVE_PATHS = [
  "/api/v1/chat-threads/messages/extra",
  "/api/v1/chat-threads",
] as const;
const V1_CHAT_THREAD_DETAIL_REWRITE_SOURCE =
  "/api/v1/chat-threads/:threadId((?!messages$)[^/]+)";
const V1_CHAT_THREAD_DETAIL_PATH =
  "/api/v1/chat-threads/550e8400-e29b-41d4-a716-446655440000";
const V1_CHAT_THREAD_DETAIL_INVALID_UUID_PATH =
  "/api/v1/chat-threads/not-a-uuid";
const V1_CHAT_THREAD_DETAIL_NEXT_NEGATIVE_PATHS = [
  "/api/v1/chat-threads/messages",
  "/api/v1/chat-threads/550e8400-e29b-41d4-a716-446655440000/messages",
  "/api/v1/chat-threads",
] as const;
const V1_CHAT_THREAD_MESSAGES_REWRITE_SOURCE =
  "/api/v1/chat-threads/:threadId/messages";
const V1_CHAT_THREAD_MESSAGES_PATH =
  "/api/v1/chat-threads/550e8400-e29b-41d4-a716-446655440000/messages";
const V1_CHAT_THREAD_MESSAGES_INVALID_UUID_PATH =
  "/api/v1/chat-threads/not-a-uuid/messages";
const V1_CHAT_THREAD_MESSAGES_NEXT_NEGATIVE_PATHS = [
  "/api/v1/chat-threads/messages",
  "/api/v1/chat-threads/550e8400-e29b-41d4-a716-446655440000/messages/extra",
  "/api/v1/chat-threads",
] as const;
const ZERO_CHAT_THREADS_REWRITE_SOURCE = "/api/zero/chat-threads";
const ZERO_CHAT_THREADS_PATH = "/api/zero/chat-threads";
const ZERO_CHAT_THREADS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/chat-threads-extra",
  "/api/zero/chat-thread",
] as const;
const ZERO_CHAT_THREAD_ARTIFACTS_REWRITE_SOURCE =
  "/api/zero/chat-threads/:threadId/artifacts";
const ZERO_CHAT_THREAD_ARTIFACTS_PATH =
  "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000/artifacts";
const ZERO_CHAT_THREAD_ARTIFACTS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000/artifacts/extra",
  "/api/zero/chat-thread/550e8400-e29b-41d4-a716-446655440000/artifacts",
] as const;
const ZERO_CHAT_THREAD_MESSAGES_REWRITE_SOURCE =
  "/api/zero/chat-threads/:threadId/messages";
const ZERO_CHAT_THREAD_MESSAGES_PATH =
  "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000/messages";
const ZERO_CHAT_THREAD_MESSAGES_NEXT_NEGATIVE_PATHS = [
  "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000/messages/extra",
  "/api/zero/chat-threads/messages",
  "/api/zero/chat-thread/550e8400-e29b-41d4-a716-446655440000/messages",
] as const;
const ZERO_CHAT_THREAD_DETAIL_REWRITE_SOURCE = "/api/zero/chat-threads/:id";
const ZERO_CHAT_THREAD_DETAIL_PATH =
  "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000";
const ZERO_CHAT_THREAD_DETAIL_NEXT_NEGATIVE_PATHS = [
  "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000/extra",
  "/api/zero/chat-thread/550e8400-e29b-41d4-a716-446655440000",
] as const;
const ZERO_CHAT_THREAD_MARK_READ_REWRITE_SOURCE =
  "/api/zero/chat-threads/:id/mark-read";
const ZERO_CHAT_THREAD_MARK_READ_PATH =
  "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000/mark-read";
const ZERO_CHAT_THREAD_MARK_READ_NEXT_NEGATIVE_PATHS = [
  "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000/mark-read/extra",
  "/api/zero/chat-thread/550e8400-e29b-41d4-a716-446655440000/mark-read",
] as const;
const ZERO_CHAT_THREAD_PIN_REWRITE_SOURCE = "/api/zero/chat-threads/:id/pin";
const ZERO_CHAT_THREAD_PIN_PATH =
  "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000/pin";
const ZERO_CHAT_THREAD_PIN_NEXT_NEGATIVE_PATHS = [
  "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000/pin/extra",
  "/api/zero/chat-thread/550e8400-e29b-41d4-a716-446655440000/pin",
] as const;
const ZERO_CHAT_THREAD_RENAME_REWRITE_SOURCE =
  "/api/zero/chat-threads/:id/rename";
const ZERO_CHAT_THREAD_RENAME_PATH =
  "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000/rename";
const ZERO_CHAT_THREAD_RENAME_NEXT_NEGATIVE_PATHS = [
  "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000/rename/extra",
  "/api/zero/chat-thread/550e8400-e29b-41d4-a716-446655440000/rename",
] as const;
const ZERO_CHAT_THREAD_UNPIN_REWRITE_SOURCE =
  "/api/zero/chat-threads/:id/unpin";
const ZERO_CHAT_THREAD_UNPIN_PATH =
  "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000/unpin";
const ZERO_CHAT_THREAD_UNPIN_NEXT_NEGATIVE_PATHS = [
  "/api/zero/chat-threads/550e8400-e29b-41d4-a716-446655440000/unpin/extra",
  "/api/zero/chat-thread/550e8400-e29b-41d4-a716-446655440000/unpin",
] as const;
const ZERO_VARIABLES_REWRITE_SOURCE = "/api/zero/variables";
const ZERO_VARIABLES_PATH = "/api/zero/variables";
const ZERO_VARIABLES_NEXT_NEGATIVE_PATHS = ["/api/zero/variable"] as const;
const ZERO_VARIABLE_BY_NAME_REWRITE_SOURCE = "/api/zero/variables/:name";
const ZERO_VARIABLE_BY_NAME_PATH = "/api/zero/variables/USER_TOKEN";
const ZERO_VARIABLE_BY_NAME_NEXT_NEGATIVE_PATHS = [
  "/api/zero/variables/USER_TOKEN/extra",
  "/api/zero/variable/USER_TOKEN",
] as const;
const PERMISSION_ACCESS_REQUESTS_REWRITE_SOURCE =
  "/api/zero/permission-access-requests";
const PERMISSION_ACCESS_REQUESTS_PATH = "/api/zero/permission-access-requests";
const PERMISSION_ACCESS_REQUESTS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/permission-access-requests/extra",
  "/api/zero/permission-access-request",
] as const;
const ZERO_SECRETS_REWRITE_SOURCE = "/api/zero/secrets";
const ZERO_SECRETS_PATH = "/api/zero/secrets";
const ZERO_SECRETS_NEXT_NEGATIVE_PATHS = ["/api/zero/secret"] as const;
const ZERO_SECRETS_BY_NAME_REWRITE_SOURCE = "/api/zero/secrets/:name";
const ZERO_SECRETS_BY_NAME_PATH = "/api/zero/secrets/DELETE_ME";
const ZERO_SECRETS_BY_NAME_NEXT_NEGATIVE_PATHS = [
  "/api/zero/secrets/DELETE_ME/extra",
  "/api/zero/secret/DELETE_ME",
] as const;
const ZERO_RUNS_REWRITE_SOURCE = "/api/zero/runs";
const ZERO_RUNS_PATH = "/api/zero/runs";
const ZERO_RUNS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/run",
  "/api/zero/runs/queue",
  `/api/zero/runs/${ZERO_RUN_ID}`,
  "/api/zero/runs/extra",
] as const;
const ZERO_RUNS_PROXY_NEGATIVE_PATHS = [
  "/api/zero/run",
  "/api/zero/runs/not-a-uuid",
  "/api/zero/runs/extra",
] as const;
const ZERO_RUNS_QUEUE_REWRITE_SOURCE = "/api/zero/runs/queue";
const ZERO_RUNS_QUEUE_PATH = "/api/zero/runs/queue";
const ZERO_RUNS_QUEUE_NEXT_NEGATIVE_PATHS = [
  "/api/zero/runs",
  "/api/zero/run/queue",
  "/api/zero/runs/queues",
  "/api/zero/runs/queue/extra",
] as const;
const ZERO_RUNS_QUEUE_PROXY_NEGATIVE_PATHS = [
  "/api/zero/run/queue",
  "/api/zero/runs/queues",
  "/api/zero/runs/queue/extra",
] as const;
const ZERO_RUNS_BY_ID_REWRITE_SOURCE =
  "/api/zero/runs/:id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})";
const ZERO_RUNS_BY_ID_PATH = `/api/zero/runs/${ZERO_RUN_ID}`;
const ZERO_RUNS_BY_ID_NEXT_NEGATIVE_PATHS = [
  "/api/zero/runs",
  "/api/zero/runs/queue",
  "/api/zero/runs/not-a-uuid",
  `/api/zero/runs/${ZERO_RUN_ID}/cancel`,
  `/api/zero/runs/${ZERO_RUN_ID}/context`,
  `/api/zero/runs/${ZERO_RUN_ID}/network`,
  `/api/zero/runs/${ZERO_RUN_ID}/runner`,
  `/api/zero/runs/${ZERO_RUN_ID}/telemetry/agent`,
  `/api/zero/runs/${ZERO_RUN_ID}/extra`,
] as const;
const ZERO_RUNS_BY_ID_PROXY_NEGATIVE_PATHS = [
  "/api/zero/runs/not-a-uuid",
  "/api/zero/run",
  `/api/zero/runs/${ZERO_RUN_ID}/extra`,
] as const;
const ZERO_RUNS_CANCEL_REWRITE_SOURCE =
  "/api/zero/runs/:id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/cancel";
const ZERO_RUNS_CANCEL_PATH = `/api/zero/runs/${ZERO_RUN_ID}/cancel`;
const ZERO_RUNS_CANCEL_NEXT_NEGATIVE_PATHS = [
  "/api/zero/runs/queue/cancel",
  "/api/zero/runs/not-a-uuid/cancel",
  `/api/zero/runs/${ZERO_RUN_ID}`,
  `/api/zero/runs/${ZERO_RUN_ID}/cancel/extra`,
] as const;
const ZERO_RUNS_CANCEL_PROXY_NEGATIVE_PATHS = [
  "/api/zero/runs/queue/cancel",
  "/api/zero/runs/not-a-uuid/cancel",
  `/api/zero/runs/${ZERO_RUN_ID}/cancel/extra`,
] as const;
const ZERO_RUNS_CONTEXT_REWRITE_SOURCE =
  "/api/zero/runs/:id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/context";
const ZERO_RUNS_CONTEXT_PATH = `/api/zero/runs/${ZERO_RUN_ID}/context`;
const ZERO_RUNS_CONTEXT_NEXT_NEGATIVE_PATHS = [
  "/api/zero/runs/queue/context",
  "/api/zero/runs/not-a-uuid/context",
  `/api/zero/runs/${ZERO_RUN_ID}`,
  `/api/zero/runs/${ZERO_RUN_ID}/context/extra`,
] as const;
const ZERO_RUNS_CONTEXT_PROXY_NEGATIVE_PATHS = [
  "/api/zero/runs/queue/context",
  "/api/zero/runs/not-a-uuid/context",
  `/api/zero/runs/${ZERO_RUN_ID}/context/extra`,
] as const;
const ZERO_RUNS_NETWORK_REWRITE_SOURCE =
  "/api/zero/runs/:id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/network";
const ZERO_RUNS_NETWORK_PATH = `/api/zero/runs/${ZERO_RUN_ID}/network`;
const ZERO_RUNS_NETWORK_NEXT_NEGATIVE_PATHS = [
  "/api/zero/runs/queue/network",
  "/api/zero/runs/not-a-uuid/network",
  `/api/zero/runs/${ZERO_RUN_ID}`,
  `/api/zero/runs/${ZERO_RUN_ID}/network/extra`,
] as const;
const ZERO_RUNS_NETWORK_PROXY_NEGATIVE_PATHS = [
  "/api/zero/runs/queue/network",
  "/api/zero/runs/not-a-uuid/network",
  `/api/zero/runs/${ZERO_RUN_ID}/network/extra`,
] as const;
const ZERO_RUNS_RUNNER_REWRITE_SOURCE =
  "/api/zero/runs/:id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/runner";
const ZERO_RUNS_RUNNER_PATH = `/api/zero/runs/${ZERO_RUN_ID}/runner`;
const ZERO_RUNS_RUNNER_NEXT_NEGATIVE_PATHS = [
  "/api/zero/runs/queue/runner",
  "/api/zero/runs/not-a-uuid/runner",
  `/api/zero/runs/${ZERO_RUN_ID}`,
  `/api/zero/runs/${ZERO_RUN_ID}/runner/extra`,
] as const;
const ZERO_RUNS_RUNNER_PROXY_NEGATIVE_PATHS = [
  "/api/zero/runs/queue/runner",
  "/api/zero/runs/not-a-uuid/runner",
  `/api/zero/runs/${ZERO_RUN_ID}/runner/extra`,
] as const;
const ZERO_RUNS_AGENT_EVENTS_REWRITE_SOURCE =
  "/api/zero/runs/:id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/telemetry/agent";
const ZERO_RUNS_AGENT_EVENTS_PATH = `/api/zero/runs/${ZERO_RUN_ID}/telemetry/agent`;
const ZERO_RUNS_AGENT_EVENTS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/runs/queue/telemetry/agent",
  "/api/zero/runs/not-a-uuid/telemetry/agent",
  `/api/zero/runs/${ZERO_RUN_ID}`,
  `/api/zero/runs/${ZERO_RUN_ID}/telemetry`,
  `/api/zero/runs/${ZERO_RUN_ID}/telemetry/agent/extra`,
] as const;
const ZERO_RUNS_AGENT_EVENTS_PROXY_NEGATIVE_PATHS = [
  "/api/zero/runs/queue/telemetry/agent",
  "/api/zero/runs/not-a-uuid/telemetry/agent",
  `/api/zero/runs/${ZERO_RUN_ID}/telemetry`,
  `/api/zero/runs/${ZERO_RUN_ID}/telemetry/agent/extra`,
] as const;
const ZERO_SCHEDULES_REWRITE_SOURCE = "/api/zero/schedules";
const ZERO_SCHEDULES_PATH = "/api/zero/schedules";
const ZERO_SCHEDULES_NEXT_NEGATIVE_PATHS = [
  "/api/zero/schedule",
  "/api/zero/schedules/extra/path",
] as const;
const ZERO_SCHEDULES_RUN_REWRITE_SOURCE = "/api/zero/schedules/run";
const ZERO_SCHEDULES_RUN_PATH = "/api/zero/schedules/run";
const ZERO_SCHEDULES_RUN_NEXT_NEGATIVE_PATHS = [
  "/api/zero/schedule/run",
  "/api/zero/schedules/run/extra",
] as const;
const ZERO_SCHEDULES_BY_NAME_REWRITE_SOURCE = "/api/zero/schedules/:name";
const ZERO_SCHEDULES_BY_NAME_PATH = "/api/zero/schedules/nightly";
const ZERO_SCHEDULES_BY_NAME_NEXT_NEGATIVE_PATHS = [
  "/api/zero/schedules/nightly/extra",
  "/api/zero/schedule/nightly",
] as const;
const ZERO_SCHEDULES_DISABLE_REWRITE_SOURCE =
  "/api/zero/schedules/:name/disable";
const ZERO_SCHEDULES_DISABLE_PATH = "/api/zero/schedules/nightly/disable";
const ZERO_SCHEDULES_DISABLE_NEXT_NEGATIVE_PATHS = [
  "/api/zero/schedules/nightly/disable/extra",
  "/api/zero/schedule/nightly/disable",
] as const;
const ZERO_SCHEDULES_ENABLE_REWRITE_SOURCE = "/api/zero/schedules/:name/enable";
const ZERO_SCHEDULES_ENABLE_PATH = "/api/zero/schedules/nightly/enable";
const ZERO_SCHEDULES_ENABLE_NEXT_NEGATIVE_PATHS = [
  "/api/zero/schedules/nightly/enable/extra",
  "/api/zero/schedule/nightly/enable",
] as const;
const ZERO_ORG_REWRITE_SOURCE = "/api/zero/org";
const ZERO_ORG_PATH = "/api/zero/org";
const ZERO_ORG_NEXT_NEGATIVE_PATHS = [
  "/api/zero/org/extra",
  "/api/zero/orgs",
] as const;
const ZERO_ORG_LIST_REWRITE_SOURCE = "/api/zero/org/list";
const ZERO_ORG_LIST_PATH = "/api/zero/org/list";
const ZERO_ORG_LIST_NEXT_NEGATIVE_PATHS = [
  "/api/zero/org/list/extra",
  "/api/zero/org/lists",
] as const;
const ZERO_ORG_DOMAINS_REWRITE_SOURCE = "/api/zero/org/domains";
const ZERO_ORG_DOMAINS_PATH = "/api/zero/org/domains";
const ZERO_ORG_DOMAINS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/org/domains/extra",
  "/api/zero/org/domain",
] as const;
const ZERO_ORG_DELETE_REWRITE_SOURCE = "/api/zero/org/delete";
const ZERO_ORG_DELETE_PATH = "/api/zero/org/delete";
const ZERO_ORG_DELETE_NEXT_NEGATIVE_PATHS = [
  "/api/zero/org/delete/extra",
  "/api/zero/org/deleted",
] as const;
const ZERO_ORG_INVITE_REWRITE_SOURCE = "/api/zero/org/invite";
const ZERO_ORG_INVITE_PATH = "/api/zero/org/invite";
const ZERO_ORG_INVITE_NEXT_NEGATIVE_PATHS = [
  "/api/zero/org/invite/extra",
  "/api/zero/org/invites",
] as const;
const ZERO_ORG_LEAVE_REWRITE_SOURCE = "/api/zero/org/leave";
const ZERO_ORG_LEAVE_PATH = "/api/zero/org/leave";
const ZERO_ORG_LEAVE_NEXT_NEGATIVE_PATHS = [
  "/api/zero/org/leave/extra",
  "/api/zero/org/leaves",
] as const;
const ZERO_ORG_LOGO_REWRITE_SOURCE = "/api/zero/org/logo";
const ZERO_ORG_LOGO_PATH = "/api/zero/org/logo";
const ZERO_ORG_LOGO_NEXT_NEGATIVE_PATHS = [
  "/api/zero/org/logo/extra",
  "/api/zero/org/logos",
] as const;
const ZERO_ORG_MEMBERS_REWRITE_SOURCE = "/api/zero/org/members";
const ZERO_ORG_MEMBERS_PATH = "/api/zero/org/members";
const ZERO_ORG_MEMBERS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/org/members/extra",
  "/api/zero/org/member",
] as const;
const ZERO_MEMBER_CREDIT_CAP_REWRITE_SOURCE =
  "/api/zero/org/members/credit-cap";
const ZERO_MEMBER_CREDIT_CAP_PATH = "/api/zero/org/members/credit-cap";
const ZERO_MEMBER_CREDIT_CAP_NEXT_NEGATIVE_PATHS = [
  "/api/zero/org/members/credit-cap/extra",
  "/api/zero/org/members/credit-caps",
] as const;
const ZERO_ORG_MEMBERSHIP_REQUESTS_REWRITE_SOURCE =
  "/api/zero/org/membership-requests";
const ZERO_ORG_MEMBERSHIP_REQUESTS_PATH = "/api/zero/org/membership-requests";
const ZERO_ORG_MEMBERSHIP_REQUESTS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/org/membership-requests/extra",
  "/api/zero/org/membership-request",
] as const;
const REALTIME_TOKEN_REWRITE_SOURCE = "/api/zero/realtime/token";
const REALTIME_TOKEN_PATH = "/api/zero/realtime/token";
const REALTIME_TOKEN_NEXT_NEGATIVE_PATHS = [
  "/api/zero/realtime/token/extra",
  "/api/zero/realtime",
  "/api/zero/realtimes/token",
] as const;
const ZERO_SKILLS_REWRITE_SOURCE = "/api/zero/skills";
const ZERO_SKILLS_PATH = "/api/zero/skills";
const ZERO_SKILLS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/skills/extra/path",
  "/api/zero/skill",
] as const;
const ZERO_SKILLS_BY_NAME_REWRITE_SOURCE = "/api/zero/skills/:name";
const ZERO_SKILLS_BY_NAME_PATH = "/api/zero/skills/my-skill";
const ZERO_SKILLS_BY_NAME_NEXT_NEGATIVE_PATHS = [
  "/api/zero/skills/my-skill/extra",
  "/api/zero/skill/my-skill",
] as const;
const VOICE_IO_TTS_REWRITE_SOURCE = "/api/zero/voice-io/tts";
const VOICE_IO_TTS_PATH = "/api/zero/voice-io/tts";
const VOICE_IO_TTS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/voice-io/tts/extra",
  "/api/zero/voice-io/quota",
  "/api/zero/voice-io/speech",
  "/api/zero/voice-io/stt",
] as const;
const VOICE_CHAT_SESSION_REWRITE_SOURCE =
  "/api/zero/voice-chat/:id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})";
const VOICE_CHAT_TOKEN_REWRITE_SOURCE = "/api/zero/voice-chat/token";
const VOICE_CHAT_ITEM_APPEND_REWRITE_SOURCE = `${VOICE_CHAT_SESSION_REWRITE_SOURCE}/items`;
const VOICE_CHAT_TASKS_REWRITE_SOURCE = `${VOICE_CHAT_SESSION_REWRITE_SOURCE}/tasks`;
const VOICE_CHAT_TRIGGER_REASONING_REWRITE_SOURCE = `${VOICE_CHAT_SESSION_REWRITE_SOURCE}/trigger-reasoning`;
const VOICE_CHAT_SESSION_PATH = `/api/zero/voice-chat/${VOICE_CHAT_SESSION_ID}`;
const VOICE_CHAT_TOKEN_PATH = "/api/zero/voice-chat/token";
const VOICE_CHAT_ITEM_APPEND_PATH = `${VOICE_CHAT_SESSION_PATH}/items`;
const VOICE_CHAT_TASKS_PATH = `${VOICE_CHAT_SESSION_PATH}/tasks`;
const VOICE_CHAT_TRIGGER_REASONING_PATH = `${VOICE_CHAT_SESSION_PATH}/trigger-reasoning`;
const STRIPE_CLI_AUTH_SESSIONS_REWRITE_SOURCE =
  "/api/zero/connectors/stripe/cli-auth/sessions";
const STRIPE_CLI_AUTH_SESSIONS_PATH =
  "/api/zero/connectors/stripe/cli-auth/sessions";
const STRIPE_CLI_AUTH_SESSIONS_COMPLETE_PATH =
  "/api/zero/connectors/stripe/cli-auth/sessions/complete";
const ZERO_CONNECTORS_AUTHORIZE_REWRITE_SOURCE =
  "/api/zero/connectors/:type/authorize";
const ZERO_CONNECTORS_AUTHORIZE_PATH = "/api/zero/connectors/github/authorize";
const ZERO_CONNECTORS_AUTHORIZE_NEXT_NEGATIVE_PATHS = [
  "/api/zero/connectors/github/authorize/extra",
  "/api/zero/connectors/authorize",
  "/api/zero/connectors/github/callback",
] as const;
const ZERO_CONNECTORS_LIST_REWRITE_SOURCE = "/api/zero/connectors";
const ZERO_CONNECTORS_LIST_PATH = "/api/zero/connectors";
const ZERO_CONNECTORS_LIST_NEXT_NEGATIVE_PATHS = [
  "/api/zero/connectors/",
  "/api/zero/connectors/github",
  "/api/zero/connectors/search",
] as const;
const ZERO_CONNECTORS_SEARCH_REWRITE_SOURCE = "/api/zero/connectors/search";
const ZERO_CONNECTORS_SEARCH_PATH = "/api/zero/connectors/search";
const ZERO_CONNECTORS_SEARCH_NEXT_NEGATIVE_PATHS = [
  "/api/zero/connectors/search/extra",
  "/api/zero/connectors",
  "/api/zero/connectors/github",
] as const;
const ZERO_CONNECTORS_COMPUTER_REWRITE_SOURCE = "/api/zero/connectors/computer";
const ZERO_CONNECTORS_COMPUTER_PATH = "/api/zero/connectors/computer";
const ZERO_CONNECTORS_COMPUTER_NEXT_NEGATIVE_PATHS = [
  "/api/zero/connectors/computer/extra",
  "/api/zero/connectors/computers",
  "/api/zero/connectors",
] as const;
const ZERO_CONNECTORS_BY_TYPE_REWRITE_SOURCE =
  "/api/zero/connectors/:type((?!search$|computer$)[^/]+)";
const ZERO_CONNECTORS_BY_TYPE_PATH = "/api/zero/connectors/github";
const ZERO_CONNECTORS_BY_TYPE_NEXT_NEGATIVE_PATHS = [
  "/api/zero/connectors",
  "/api/zero/connectors/github/extra",
  "/api/zero/connectors/search",
  "/api/zero/connectors/computer",
] as const;
const ZERO_CONNECTORS_SCOPE_DIFF_REWRITE_SOURCE =
  "/api/zero/connectors/:type/scope-diff";
const ZERO_CONNECTORS_SCOPE_DIFF_PATH =
  "/api/zero/connectors/github/scope-diff";
const ZERO_CONNECTORS_SCOPE_DIFF_NEXT_NEGATIVE_PATHS = [
  "/api/zero/connectors/github/scope-diff/extra",
  "/api/zero/connectors/scope-diff",
  "/api/zero/connectors/github/scope",
] as const;
const ZERO_CONNECTORS_SESSIONS_REWRITE_SOURCE =
  "/api/zero/connectors/:type/sessions";
const ZERO_CONNECTORS_SESSIONS_PATH = "/api/zero/connectors/github/sessions";
const ZERO_CONNECTORS_SESSIONS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/connectors/github/sessions/00000000-0000-0000-0000-000000000000",
  "/api/zero/connectors/sessions",
  "/api/zero/connectors/github/session",
] as const;
const ZERO_CONNECTORS_SESSION_BY_ID_REWRITE_SOURCE =
  "/api/zero/connectors/:type/sessions/:sessionId([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})";
const ZERO_CONNECTORS_SESSION_BY_ID_PATH = `/api/zero/connectors/github/sessions/${ZERO_CONNECTOR_SESSION_ID}`;
const ZERO_CONNECTORS_SESSION_BY_ID_NEXT_NEGATIVE_PATHS = [
  "/api/zero/connectors/github/sessions/not-a-uuid",
  `/api/zero/connectors/github/sessions/${ZERO_CONNECTOR_SESSION_ID}/extra`,
  `/api/zero/connectors/sessions/${ZERO_CONNECTOR_SESSION_ID}`,
] as const;
const ZERO_SLACK_CHANNELS_REWRITE_SOURCE = "/api/zero/slack/channels";
const ZERO_SLACK_CHANNELS_PATH = "/api/zero/slack/channels";
const ZERO_SLACK_CHANNELS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/slack/channels/extra",
  "/api/zero/slack/channel",
  "/api/zero/slack/channels-list",
] as const;
const ZERO_SLACK_CONNECT_REWRITE_SOURCE = "/api/zero/slack/connect";
const ZERO_SLACK_CONNECT_PATH = "/api/zero/slack/connect";
const ZERO_SLACK_CONNECT_NEXT_NEGATIVE_PATHS = [
  "/api/zero/slack/connect/extra",
  "/api/zero/slack/connection",
  "/api/zero/slack/connect/oauth",
] as const;
const ZERO_SLACK_COMMANDS_REWRITE_SOURCE = "/api/zero/slack/commands";
const ZERO_SLACK_COMMANDS_PATH = "/api/zero/slack/commands";
const ZERO_SLACK_COMMANDS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/slack/commands/extra",
  "/api/zero/slack/command",
  "/api/zero/slack/commands/help",
] as const;
const ZERO_SLACK_EVENTS_REWRITE_SOURCE = "/api/zero/slack/events";
const ZERO_SLACK_EVENTS_PATH = "/api/zero/slack/events";
const ZERO_SLACK_EVENTS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/slack/events/extra",
  "/api/zero/slack/event",
  "/api/zero/slack/oauth/events",
] as const;
const ZERO_SLACK_INTERACTIVE_REWRITE_SOURCE = "/api/zero/slack/interactive";
const ZERO_SLACK_INTERACTIVE_PATH = "/api/zero/slack/interactive";
const ZERO_SLACK_INTERACTIVE_NEXT_NEGATIVE_PATHS = [
  "/api/zero/slack/interactive/extra",
  "/api/zero/slack/interactions",
  "/api/zero/slack/oauth/interactive",
] as const;
const VOICE_CHAT_ITEM_APPEND_NEXT_NEGATIVE_PATHS = [
  "/api/zero/voice-chat/token",
  "/api/zero/voice-chat/token/items",
  VOICE_CHAT_TASKS_PATH,
  VOICE_CHAT_TRIGGER_REASONING_PATH,
  "/api/zero/voice-chat/not-a-uuid/items",
] as const;
const VOICE_CHAT_TASKS_NEXT_NEGATIVE_PATHS = [
  "/api/zero/voice-chat/token",
  "/api/zero/voice-chat/token/tasks",
  VOICE_CHAT_ITEM_APPEND_PATH,
  VOICE_CHAT_TRIGGER_REASONING_PATH,
  "/api/zero/voice-chat/not-a-uuid/tasks",
] as const;
const VOICE_CHAT_TRIGGER_REASONING_NEXT_NEGATIVE_PATHS = [
  "/api/zero/voice-chat/token",
  "/api/zero/voice-chat/token/trigger-reasoning",
  "/api/zero/voice-chat/not-a-uuid/trigger-reasoning",
  VOICE_CHAT_ITEM_APPEND_PATH,
  VOICE_CHAT_TASKS_PATH,
] as const;
const VOICE_CHAT_SESSION_REWRITE_NEGATIVE_PATHS = [
  "/api/zero/voice-chat/not-a-uuid",
] as const;
const VOICE_CHAT_TOKEN_NEXT_NEGATIVE_PATHS = [
  "/api/zero/voice-chat/token/extra",
  "/api/zero/voice-chat/token/items",
  "/api/zero/voice-chat/token/tasks",
  "/api/zero/voice-chat/token/trigger-reasoning",
  VOICE_CHAT_SESSION_PATH,
  VOICE_CHAT_ITEM_APPEND_PATH,
  VOICE_CHAT_TASKS_PATH,
  VOICE_CHAT_TRIGGER_REASONING_PATH,
  "/api/zero/voice-chat/not-a-uuid",
] as const;
const VOICE_CHAT_TOKEN_REWRITE_NEGATIVE_PATHS = [
  "/api/zero/voice-chat/token/extra",
  "/api/zero/voice-chat/token/items",
  "/api/zero/voice-chat/token/tasks",
  "/api/zero/voice-chat/token/trigger-reasoning",
  "/api/zero/voice-chat/not-a-uuid",
] as const;
const VOICE_CHAT_ITEM_APPEND_REWRITE_NEGATIVE_PATHS = [
  "/api/zero/voice-chat/token/items",
  "/api/zero/voice-chat/not-a-uuid/items",
] as const;
const VOICE_CHAT_TASKS_REWRITE_NEGATIVE_PATHS = [
  "/api/zero/voice-chat/token/tasks",
  "/api/zero/voice-chat/not-a-uuid/tasks",
] as const;
const VOICE_CHAT_TRIGGER_REASONING_REWRITE_NEGATIVE_PATHS = [
  "/api/zero/voice-chat/token/trigger-reasoning",
  "/api/zero/voice-chat/not-a-uuid/trigger-reasoning",
] as const;

// Import the nextConfig to test headers() function
// next.config.js exports the Sentry-wrapped config, so we need to extract headers from the raw config
// We test the headers function by dynamically importing and extracting the config

async function getSecurityHeaders(): Promise<
  Array<{ key: string; value: string }>
> {
  // Dynamic import to get the module fresh
  const configModule = await import("../next.config.js");
  const config = configModule.default;

  // The exported config is wrapped by Sentry, but headers() is preserved
  // Next.js config headers() returns an array of { source, headers } objects
  if (!config.headers) {
    throw new Error("headers() function not found in Next.js config");
  }
  const headerEntries = await config.headers();
  const catchAllEntry = headerEntries.find((entry: { source: string }) => {
    return entry.source === "/(.*)";
  });
  return catchAllEntry?.headers ?? [];
}

interface RewriteEntry {
  readonly source: string;
  readonly destination: string;
}

async function getBeforeFileRewrites(): Promise<RewriteEntry[]> {
  const configModule = await import("../next.config.js");
  const config = configModule.default;

  if (!config.rewrites) {
    throw new Error("rewrites() function not found in Next.js config");
  }

  const rewrites = await config.rewrites();
  if (Array.isArray(rewrites)) {
    return rewrites;
  }
  return rewrites.beforeFiles ?? [];
}

function findHeader(
  headers: Array<{ key: string; value: string }>,
  name: string,
): string | undefined {
  return headers.find((h) => {
    return h.key === name;
  })?.value;
}

describe("Security Response Headers", () => {
  it("should include all 5 ASVS-required security headers", async () => {
    const headers = await getSecurityHeaders();
    const headerNames = headers.map((h) => {
      return h.key;
    });

    expect(headerNames).toContain("X-Frame-Options");
    expect(headerNames).toContain("X-Content-Type-Options");
    expect(headerNames).toContain("Referrer-Policy");
    expect(headerNames).toContain("Strict-Transport-Security");
    expect(headerNames).toContain("Content-Security-Policy");
  });

  it("should set X-Frame-Options to DENY", async () => {
    const headers = await getSecurityHeaders();
    expect(findHeader(headers, "X-Frame-Options")).toBe("DENY");
  });

  it("should set X-Content-Type-Options to nosniff", async () => {
    const headers = await getSecurityHeaders();
    expect(findHeader(headers, "X-Content-Type-Options")).toBe("nosniff");
  });

  it("should set Referrer-Policy to strict-origin-when-cross-origin", async () => {
    const headers = await getSecurityHeaders();
    expect(findHeader(headers, "Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
  });

  it("should set HSTS with max-age of 1 year and includeSubDomains", async () => {
    const headers = await getSecurityHeaders();
    const hsts = findHeader(headers, "Strict-Transport-Security");
    expect(hsts).toBe("max-age=31536000; includeSubDomains");
  });

  describe("Content-Security-Policy", () => {
    it("should use permissive script-src with unsafe-inline for phase 1", async () => {
      const headers = await getSecurityHeaders();
      const csp = findHeader(headers, "Content-Security-Policy");

      expect(csp).toContain("script-src");
      expect(csp).toContain("'unsafe-inline'");
    });

    it("should allow inline styles via style-src", async () => {
      const headers = await getSecurityHeaders();
      const csp = findHeader(headers, "Content-Security-Policy");

      expect(csp).toContain("style-src");
      expect(csp).toContain("'unsafe-inline'");
    });

    it("should allow unsafe-eval for Termly embed-policy.min.js", async () => {
      const headers = await getSecurityHeaders();
      const csp = findHeader(headers, "Content-Security-Policy");

      expect(csp).toContain("'unsafe-eval'");
    });

    it("should deny frame-ancestors", async () => {
      const headers = await getSecurityHeaders();
      const csp = findHeader(headers, "Content-Security-Policy");

      expect(csp).toContain("frame-ancestors 'none'");
    });

    it("should use permissive default-src for phase 1", async () => {
      const headers = await getSecurityHeaders();
      const csp = findHeader(headers, "Content-Security-Policy");

      expect(csp).toContain("default-src *");
    });

    it("should restrict worker-src to self and blob: only", async () => {
      const headers = await getSecurityHeaders();
      const csp = findHeader(headers, "Content-Security-Policy");

      expect(csp).toContain("worker-src 'self' blob:");
    });
  });
});

describe("API backend rewrites", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("should proxy migrated API backend routes to apps/api", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();

    expect(rewrites).toEqual(
      expect.arrayContaining([
        {
          source: AGENT_CHECKPOINT_REWRITE_SOURCE,
          destination: "https://api.example.test/api/agent/checkpoints/:id",
        },
        {
          source: AGENT_COMPOSES_REWRITE_SOURCE,
          destination: "https://api.example.test/api/agent/composes",
        },
        {
          source: AGENT_COMPOSES_LIST_REWRITE_SOURCE,
          destination: "https://api.example.test/api/agent/composes/list",
        },
        {
          source: AGENT_COMPOSES_VERSIONS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/agent/composes/versions",
        },
        {
          source: AGENT_RUNS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/agent/runs",
        },
        {
          source: AGENT_RUNS_QUEUE_REWRITE_SOURCE,
          destination: "https://api.example.test/api/agent/runs/queue",
        },
        {
          source: AGENT_RUN_CANCEL_REWRITE_SOURCE,
          destination: "https://api.example.test/api/agent/runs/:id/cancel",
        },
        {
          source: AGENT_RUN_EVENTS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/agent/runs/:id/events",
        },
        {
          source: AGENT_RUN_BY_ID_REWRITE_SOURCE,
          destination: "https://api.example.test/api/agent/runs/:id",
        },
        {
          source: AGENT_RUN_TELEMETRY_REWRITE_SOURCE,
          destination: "https://api.example.test/api/agent/runs/:id/telemetry",
        },
        {
          source: AGENT_RUN_TELEMETRY_AGENT_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/agent/runs/:id/telemetry/agent",
        },
        {
          source: AGENT_RUN_TELEMETRY_METRICS_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/agent/runs/:id/telemetry/metrics",
        },
        {
          source: AGENT_RUN_TELEMETRY_NETWORK_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/agent/runs/:id/telemetry/network",
        },
        {
          source: AGENT_RUN_TELEMETRY_SYSTEM_LOG_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/agent/runs/:id/telemetry/system-log",
        },
        {
          source: AUTH_ME_REWRITE_SOURCE,
          destination: "https://api.example.test/api/auth/me",
        },
        {
          source: CLI_AUTH_DEVICE_REWRITE_SOURCE,
          destination: "https://api.example.test/api/cli/auth/device",
        },
        {
          source: CLI_AUTH_ORG_REWRITE_SOURCE,
          destination: "https://api.example.test/api/cli/auth/org",
        },
        {
          source: CLI_AUTH_TOKEN_REWRITE_SOURCE,
          destination: "https://api.example.test/api/cli/auth/token",
        },
        {
          source: CLI_AUTH_TEST_APPROVE_REWRITE_SOURCE,
          destination: "https://api.example.test/api/cli/auth/test-approve",
        },
        {
          source: CLI_AUTH_TEST_CODEX_OAUTH_REWRITE_SOURCE,
          destination: "https://api.example.test/api/cli/auth/test-codex-oauth",
        },
        {
          source: CLI_AUTH_TEST_CONNECTOR_REWRITE_SOURCE,
          destination: "https://api.example.test/api/cli/auth/test-connector",
        },
        {
          source: CLI_AUTH_TEST_ENABLE_CONNECTOR_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/cli/auth/test-enable-connector",
        },
        {
          source: CLI_AUTH_TEST_TOKEN_REWRITE_SOURCE,
          destination: "https://api.example.test/api/cli/auth/test-token",
        },
        {
          source: TEST_OAUTH_PROVIDER_AUTHORIZE_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/test/oauth-provider/authorize",
        },
        {
          source: TEST_OAUTH_PROVIDER_ECHO_REWRITE_SOURCE,
          destination: "https://api.example.test/api/test/oauth-provider/echo",
        },
        {
          source: TEST_OAUTH_PROVIDER_TOKEN_REWRITE_SOURCE,
          destination: "https://api.example.test/api/test/oauth-provider/token",
        },
        {
          source: TEST_OAUTH_PROVIDER_USERINFO_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/test/oauth-provider/userinfo",
        },
        {
          source: TEST_SLACK_MOCK_AUTH_TEST_REWRITE_SOURCE,
          destination: "https://api.example.test/api/test/slack-mock/auth.test",
        },
        {
          source: TEST_SLACK_MOCK_CHAT_POST_MESSAGE_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/test/slack-mock/chat.postMessage",
        },
        {
          source: TEST_SLACK_MOCK_CONVERSATIONS_HISTORY_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/test/slack-mock/conversations.history",
        },
        {
          source: TEST_SLACK_MOCK_CONVERSATIONS_REPLIES_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/test/slack-mock/conversations.replies",
        },
        {
          source: TEST_SLACK_MOCK_USERS_INFO_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/test/slack-mock/users.info",
        },
        {
          source: TEST_TELEGRAM_MOCK_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/test/telegram-mock/:botToken/:method",
        },
        {
          source: CRON_AGGREGATE_INSIGHTS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/cron/aggregate-insights",
        },
        {
          source: CRON_AGGREGATE_USAGE_REWRITE_SOURCE,
          destination: "https://api.example.test/api/cron/aggregate-usage",
        },
        {
          source: CRON_CLEANUP_SANDBOXES_REWRITE_SOURCE,
          destination: "https://api.example.test/api/cron/cleanup-sandboxes",
        },
        {
          source: CRON_DRAIN_EMAIL_OUTBOX_REWRITE_SOURCE,
          destination: "https://api.example.test/api/cron/drain-email-outbox",
        },
        {
          source: CRON_EXECUTE_SCHEDULES_REWRITE_SOURCE,
          destination: "https://api.example.test/api/cron/execute-schedules",
        },
        {
          source: CRON_PROCESS_USAGE_EVENTS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/cron/process-usage-events",
        },
        {
          source: CRON_RECONCILE_BILLING_ENTITLEMENTS_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/cron/reconcile-billing-entitlements",
        },
        {
          source: CRON_TELEGRAM_CLEANUP_REWRITE_SOURCE,
          destination: "https://api.example.test/api/cron/telegram-cleanup",
        },
        {
          source: CRON_VOICE_CHAT_CLEANUP_REWRITE_SOURCE,
          destination: "https://api.example.test/api/cron/voice-chat-cleanup",
        },
        {
          source: CONNECTORS_AUTHORIZE_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/connectors/:type/authorize",
        },
        {
          source: CONNECTORS_CALLBACK_REWRITE_SOURCE,
          destination: "https://api.example.test/api/connectors/:type/callback",
        },
        {
          source: RUNNERS_HEARTBEAT_REWRITE_SOURCE,
          destination: "https://api.example.test/api/runners/heartbeat",
        },
        {
          source: RUNNERS_JOB_CLAIM_REWRITE_SOURCE,
          destination: "https://api.example.test/api/runners/jobs/:id/claim",
        },
        {
          source: RUNNERS_POLL_REWRITE_SOURCE,
          destination: "https://api.example.test/api/runners/poll",
        },
        {
          source: RUNNERS_REALTIME_TOKEN_REWRITE_SOURCE,
          destination: "https://api.example.test/api/runners/realtime/token",
        },
        {
          source: "/api/device-token",
          destination: "https://api.example.test/api/device-token",
        },
        {
          source: "/api/device-token/poll",
          destination: "https://api.example.test/api/device-token/poll",
        },
        {
          source: EMAIL_UNSUBSCRIBE_REWRITE_SOURCE,
          destination: "https://api.example.test/api/email/unsubscribe",
        },
        {
          source: ZERO_EMAIL_INBOUND_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/email/inbound",
        },
        {
          source: ZERO_EMAIL_REPLY_CALLBACK_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/email/callbacks/reply",
        },
        {
          source: ZERO_EMAIL_TRIGGER_CALLBACK_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/email/callbacks/trigger",
        },
        {
          source: GENERATE_IMAGE_REWRITE_SOURCE,
          destination: "https://api.example.test/api/generate-image",
        },
        {
          source: GITHUB_OAUTH_CALLBACK_REWRITE_SOURCE,
          destination: "https://api.example.test/api/github/oauth/callback",
        },
        {
          source: GITHUB_OAUTH_INSTALL_REWRITE_SOURCE,
          destination: "https://api.example.test/api/github/oauth/install",
        },
        {
          source: LOGS_SEARCH_REWRITE_SOURCE,
          destination: "https://api.example.test/api/logs/search",
        },
        {
          source: ZERO_LOGS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/logs",
        },
        {
          source: ZERO_LOGS_BY_ID_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/logs/:id",
        },
        {
          source: ZERO_LOGS_SEARCH_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/logs/search",
        },
        {
          source: INTEGRATIONS_GITHUB_REWRITE_SOURCE,
          destination: "https://api.example.test/api/integrations/github",
        },
        {
          source: TELEGRAM_INTEGRATIONS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/integrations/telegram",
        },
        {
          source: TELEGRAM_LINK_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/integrations/telegram/link",
        },
        {
          source: TELEGRAM_BOT_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/integrations/telegram/:botId",
        },
        {
          source: TELEGRAM_AVATAR_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/integrations/telegram/:botId/avatar",
        },
        {
          source: BUILT_IN_GENERATIONS_FAL_WEBHOOK_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/webhooks/built-in-generations/fal/:generationId",
        },
        {
          source: AGENT_COMPLETE_REWRITE_SOURCE,
          destination: "https://api.example.test/api/webhooks/agent/complete",
        },
        {
          source: AGENT_EVENTS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/webhooks/agent/events",
        },
        {
          source: AGENT_FIREWALL_AUTH_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/webhooks/agent/firewall/auth",
        },
        {
          source: AGENT_HEARTBEAT_REWRITE_SOURCE,
          destination: "https://api.example.test/api/webhooks/agent/heartbeat",
        },
        {
          source: AGENT_TELEMETRY_REWRITE_SOURCE,
          destination: "https://api.example.test/api/webhooks/agent/telemetry",
        },
        {
          source: AGENT_USAGE_EVENT_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/webhooks/agent/usage-event",
        },
        {
          source: AGENT_STORAGES_COMMIT_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/webhooks/agent/storages/commit",
        },
        {
          source: AGENT_STORAGES_PREPARE_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/webhooks/agent/storages/prepare",
        },
        {
          source: AGENT_CHECKPOINTS_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/webhooks/agent/checkpoints",
        },
        {
          source: AGENT_CHECKPOINTS_PREPARE_HISTORY_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/webhooks/agent/checkpoints/prepare-history",
        },
        {
          source: CLERK_WEBHOOK_REWRITE_SOURCE,
          destination: "https://api.example.test/api/webhooks/clerk",
        },
        {
          source: GITHUB_WEBHOOK_REWRITE_SOURCE,
          destination: "https://api.example.test/api/webhooks/github",
        },
        {
          source: STRIPE_WEBHOOK_REWRITE_SOURCE,
          destination: "https://api.example.test/api/webhooks/stripe",
        },
        {
          source: STORAGES_COMMIT_REWRITE_SOURCE,
          destination: "https://api.example.test/api/storages/commit",
        },
        {
          source: STORAGES_DOWNLOAD_REWRITE_SOURCE,
          destination: "https://api.example.test/api/storages/download",
        },
        {
          source: STORAGES_LIST_REWRITE_SOURCE,
          destination: "https://api.example.test/api/storages/list",
        },
        {
          source: STORAGES_PREPARE_REWRITE_SOURCE,
          destination: "https://api.example.test/api/storages/prepare",
        },
        {
          source: USAGE_REWRITE_SOURCE,
          destination: "https://api.example.test/api/usage",
        },
        {
          source: TEST_SLACK_DISPATCH_PROBE_REWRITE_SOURCE,
          destination: "https://api.example.test/api/test/slack-dispatch-probe",
        },
        {
          source: TEST_SLACK_MOCK_ASSISTANT_STATUS_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/test/slack-mock/assistant.threads.setStatus",
        },
        {
          source: TEST_SLACK_MOCK_CHAT_POST_EPHEMERAL_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/test/slack-mock/chat.postEphemeral",
        },
        {
          source: TEST_SLACK_MOCK_CONVERSATIONS_OPEN_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/test/slack-mock/conversations.open",
        },
        {
          source: TEST_SLACK_MOCK_OAUTH_ACCESS_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/test/slack-mock/oauth.v2.access",
        },
        {
          source: TEST_SLACK_MOCK_VIEWS_PUBLISH_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/test/slack-mock/views.publish",
        },
        {
          source: TEST_SLACK_STATE_REWRITE_SOURCE,
          destination: "https://api.example.test/api/test/slack-state",
        },
        {
          source: TEST_TELEGRAM_STATE_REWRITE_SOURCE,
          destination: "https://api.example.test/api/test/telegram-state",
        },
        {
          source: AGENTPHONE_CONNECT_REWRITE_SOURCE,
          destination: "https://api.example.test/api/agentphone/connect",
        },
        {
          source: AGENTPHONE_WEBHOOK_REWRITE_SOURCE,
          destination: "https://api.example.test/api/agentphone/webhook",
        },
        {
          source: INTERNAL_CALLBACKS_AGENT_REWRITE_SOURCE,
          destination: "https://api.example.test/api/internal/callbacks/agent",
        },
        {
          source: INTERNAL_CALLBACKS_CHAT_REWRITE_SOURCE,
          destination: "https://api.example.test/api/internal/callbacks/chat",
        },
        {
          source: INTERNAL_CALLBACKS_GITHUB_ISSUES_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/internal/callbacks/github/issues",
        },
        {
          source: INTERNAL_CALLBACKS_SCHEDULE_CRON_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/internal/callbacks/schedule/cron",
        },
        {
          source: INTERNAL_CALLBACKS_SCHEDULE_LOOP_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/internal/callbacks/schedule/loop",
        },
        {
          source: INTERNAL_CALLBACKS_SLACK_ORG_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/internal/callbacks/slack/org",
        },
        {
          source: INTERNAL_CALLBACKS_TELEGRAM_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/internal/callbacks/telegram",
        },
        {
          source: INTERNAL_CALLBACKS_VOICE_CHAT_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/internal/callbacks/voice-chat",
        },
        {
          source: "/api/internal/callbacks/agentphone",
          destination:
            "https://api.example.test/api/internal/callbacks/agentphone",
        },
        {
          source: "/api/internal/event-consumers/agentphone-typing",
          destination:
            "https://api.example.test/api/internal/event-consumers/agentphone-typing",
        },
        {
          source: "/api/internal/event-consumers/axiom",
          destination:
            "https://api.example.test/api/internal/event-consumers/axiom",
        },
        {
          source: "/api/internal/event-consumers/chat-assistant",
          destination:
            "https://api.example.test/api/internal/event-consumers/chat-assistant",
        },
        {
          source: "/api/internal/event-consumers/telegram-typing",
          destination:
            "https://api.example.test/api/internal/event-consumers/telegram-typing",
        },
        {
          source: "/api/internal/event-consumers/voice-chat",
          destination:
            "https://api.example.test/api/internal/event-consumers/voice-chat",
        },
        {
          source: "/api/user/export",
          destination: "https://api.example.test/api/user/export",
        },
        {
          source: STRIPE_CLI_AUTH_SESSIONS_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/connectors/stripe/cli-auth/sessions",
        },
        {
          source: ZERO_API_KEYS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/api-keys",
        },
        {
          source: ZERO_API_KEY_BY_ID_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/api-keys/:id",
        },
        {
          source: ZERO_BILLING_AUTO_RECHARGE_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/billing/auto-recharge",
        },
        {
          source: ZERO_BILLING_CHECKOUT_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/billing/checkout",
        },
        {
          source: ZERO_BILLING_DOWNGRADE_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/billing/downgrade",
        },
        {
          source: ZERO_BILLING_INVOICES_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/billing/invoices",
        },
        {
          source: ZERO_BILLING_PORTAL_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/billing/portal",
        },
        {
          source: ZERO_BILLING_REDEEM_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/billing/redeem/:campaign",
        },
        {
          source: ZERO_BILLING_STATUS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/billing/status",
        },
        {
          source: ZERO_DEFAULT_AGENT_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/default-agent",
        },
        {
          source: ZERO_CONNECTORS_LIST_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/connectors",
        },
        {
          source: ZERO_DEVELOPER_SUPPORT_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/developer-support",
        },
        {
          source: ZERO_CONNECTORS_SEARCH_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/connectors/search",
        },
        {
          source: ZERO_CONNECTORS_COMPUTER_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/connectors/computer",
        },
        {
          source: ZERO_CONNECTORS_BY_TYPE_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/connectors/:type",
        },
        {
          source: ZERO_CONNECTORS_AUTHORIZE_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/connectors/:type/authorize",
        },
        {
          source: ZERO_SLACK_CHANNELS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/slack/channels",
        },
        {
          source: ZERO_SLACK_CONNECT_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/slack/connect",
        },
        {
          source: ZERO_SLACK_COMMANDS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/slack/commands",
        },
        {
          source: ZERO_SLACK_EVENTS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/slack/events",
        },
        {
          source: ZERO_SLACK_INTERACTIVE_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/slack/interactive",
        },
        {
          source: "/api/zero/devices/bb0/confirm",
          destination: "https://api.example.test/api/zero/devices/bb0/confirm",
        },
        {
          source: "/api/zero/built-in-generations/:path*",
          destination:
            "https://api.example.test/api/zero/built-in-generations/:path*",
        },
        {
          source: "/api/zero/image-io/generate",
          destination: "https://api.example.test/api/zero/image-io/generate",
        },
        {
          source: "/api/zero/maps/:path*",
          destination: "https://api.example.test/api/zero/maps/:path*",
        },
        {
          source: ONBOARDING_SETUP_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/onboarding/setup",
        },
        {
          source: ONBOARDING_STATUS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/onboarding/status",
        },
        {
          source: "/api/zero/presentation-io/generate",
          destination:
            "https://api.example.test/api/zero/presentation-io/generate",
        },
        {
          source: "/api/zero/local-agent/:path*",
          destination: "https://api.example.test/api/zero/local-agent/:path*",
        },
        {
          source: "/api/zero/usage/insight",
          destination: "https://api.example.test/api/zero/usage/insight",
        },
        {
          source: "/api/zero/usage/members",
          destination: "https://api.example.test/api/zero/usage/members",
        },
        {
          source: "/api/zero/usage/runs",
          destination: "https://api.example.test/api/zero/usage/runs",
        },
        {
          source: "/api/zero/video-io/generate",
          destination: "https://api.example.test/api/zero/video-io/generate",
        },
        {
          source: "/api/zero/integrations/phone/:path*",
          destination:
            "https://api.example.test/api/zero/integrations/phone/:path*",
        },
        {
          source: "/api/zero/integrations/chat/message",
          destination:
            "https://api.example.test/api/zero/integrations/chat/message",
        },
        {
          source: "/api/zero/integrations/slack",
          destination: "https://api.example.test/api/zero/integrations/slack",
        },
        {
          source: "/api/zero/integrations/slack/message",
          destination:
            "https://api.example.test/api/zero/integrations/slack/message",
        },
        {
          source: "/api/zero/integrations/slack/connect",
          destination:
            "https://api.example.test/api/zero/integrations/slack/connect",
        },
        {
          source: "/api/zero/integrations/slack/download-file",
          destination:
            "https://api.example.test/api/zero/integrations/slack/download-file",
        },
        {
          source: "/api/zero/integrations/telegram/bots",
          destination:
            "https://api.example.test/api/zero/integrations/telegram/bots",
        },
        {
          source: "/api/zero/integrations/telegram/download-file",
          destination:
            "https://api.example.test/api/zero/integrations/telegram/download-file",
        },
        {
          source: "/api/zero/integrations/telegram/message",
          destination:
            "https://api.example.test/api/zero/integrations/telegram/message",
        },
        {
          source: "/api/zero/integrations/telegram/upload-file/complete",
          destination:
            "https://api.example.test/api/zero/integrations/telegram/upload-file/complete",
        },
        {
          source: "/api/zero/integrations/telegram/upload-file/init",
          destination:
            "https://api.example.test/api/zero/integrations/telegram/upload-file/init",
        },
        {
          source: "/api/zero/uploads/complete",
          destination: "https://api.example.test/api/zero/uploads/complete",
        },
        {
          source: "/api/zero/uploads/prepare",
          destination: "https://api.example.test/api/zero/uploads/prepare",
        },
        {
          source: PERMISSION_POLICIES_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/permission-policies",
        },
        {
          source: PUSH_SUBSCRIPTIONS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/push-subscriptions",
        },
        {
          source: QUEUE_POSITION_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/queue-position",
        },
        {
          source: PERMISSION_ACCESS_REQUESTS_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/permission-access-requests",
        },
        {
          source: ZERO_SECRETS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/secrets",
        },
        {
          source: REALTIME_TOKEN_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/realtime/token",
        },
        {
          source: ZERO_SECRETS_BY_NAME_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/secrets/:name",
        },
        {
          source: ZERO_RUNS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/runs",
        },
        {
          source: ZERO_RUNS_QUEUE_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/runs/queue",
        },
        {
          source: ZERO_RUNS_BY_ID_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/runs/:id",
        },
        {
          source: ZERO_RUNS_CANCEL_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/runs/:id/cancel",
        },
        {
          source: ZERO_RUNS_CONTEXT_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/runs/:id/context",
        },
        {
          source: ZERO_RUNS_NETWORK_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/runs/:id/network",
        },
        {
          source: ZERO_RUNS_RUNNER_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/runs/:id/runner",
        },
        {
          source: ZERO_RUNS_AGENT_EVENTS_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/runs/:id/telemetry/agent",
        },
        {
          source: ZERO_SCHEDULES_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/schedules",
        },
        {
          source: ZERO_SCHEDULES_RUN_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/schedules/run",
        },
        {
          source: ZERO_SCHEDULES_BY_NAME_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/schedules/:name",
        },
        {
          source: ZERO_SCHEDULES_DISABLE_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/schedules/:name/disable",
        },
        {
          source: ZERO_SCHEDULES_ENABLE_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/schedules/:name/enable",
        },
        {
          source: ZERO_SKILLS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/skills",
        },
        {
          source: ZERO_SKILLS_BY_NAME_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/skills/:name",
        },
        {
          source: USER_MODEL_PREFERENCE_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/user-model-preference",
        },
        {
          source: ZERO_ME_MODEL_PROVIDERS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/me/model-providers",
        },
        {
          source: ZERO_ME_MODEL_PROVIDER_TYPE_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/me/model-providers/:type",
        },
        {
          source: ZERO_MODEL_PROVIDERS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/model-providers",
        },
        {
          source: ZERO_MODEL_PROVIDER_TYPE_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/model-providers/:type",
        },
        {
          source: ZERO_AGENTS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/agents",
        },
        {
          source: ZERO_AGENT_BY_ID_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/agents/:id",
        },
        {
          source: ZERO_AGENT_CUSTOM_CONNECTORS_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/agents/:id/custom-connectors",
        },
        {
          source: ZERO_AGENT_USER_CONNECTORS_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/agents/:id/user-connectors",
        },
        {
          source: ZERO_CUSTOM_CONNECTORS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/custom-connectors",
        },
        {
          source: ZERO_CUSTOM_CONNECTOR_BY_ID_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/custom-connectors/:id",
        },
        {
          source: ZERO_CUSTOM_CONNECTOR_SECRET_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/custom-connectors/:id/secret",
        },
        {
          source: ZERO_CHAT_SEARCH_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/chat/search",
        },
        {
          source: ZERO_CHAT_MESSAGES_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/chat/messages",
        },
        {
          source: ZERO_COMPOSES_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/composes",
        },
        {
          source: ZERO_COMPOSES_LIST_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/composes/list",
        },
        {
          source: ZERO_COMPOSES_BY_ID_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/composes/:id",
        },
        {
          source: ZERO_COMPOSES_METADATA_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/composes/:id/metadata",
        },
        {
          source: ZERO_COMPUTER_USE_HOST_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/computer-use/host",
        },
        {
          source: ZERO_COMPUTER_USE_REGISTER_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/computer-use/register",
        },
        {
          source: ZERO_COMPUTER_USE_UNREGISTER_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/computer-use/unregister",
        },
        {
          source: ZERO_INSIGHTS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/insights",
        },
        {
          source: ZERO_INSIGHTS_RANGE_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/insights/range",
        },
        {
          source: V1_CHAT_THREAD_DETAIL_REWRITE_SOURCE,
          destination: "https://api.example.test/api/v1/chat-threads/:threadId",
        },
        {
          source: ZERO_CHAT_THREADS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/chat-threads",
        },
        {
          source: ZERO_CHAT_THREAD_ARTIFACTS_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/chat-threads/:threadId/artifacts",
        },
        {
          source: ZERO_CHAT_THREAD_MESSAGES_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/chat-threads/:threadId/messages",
        },
        {
          source: ZERO_CHAT_THREAD_DETAIL_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/chat-threads/:id",
        },
        {
          source: ZERO_AGENT_INSTRUCTIONS_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/agents/:id/instructions",
        },
        {
          source: ZERO_CHAT_THREAD_MARK_READ_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/chat-threads/:id/mark-read",
        },
        {
          source: ZERO_CHAT_THREAD_PIN_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/chat-threads/:id/pin",
        },
        {
          source: ZERO_CHAT_THREAD_RENAME_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/chat-threads/:id/rename",
        },
        {
          source: ZERO_CHAT_THREAD_UNPIN_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/chat-threads/:id/unpin",
        },
        {
          source: "/api/zero/user-preferences",
          destination: "https://api.example.test/api/zero/user-preferences",
        },
        {
          source: ZERO_ORG_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/org",
        },
        {
          source: ZERO_ORG_LIST_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/org/list",
        },
        {
          source: ZERO_ORG_DOMAINS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/org/domains",
        },
        {
          source: ZERO_ORG_DELETE_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/org/delete",
        },
        {
          source: ZERO_ORG_INVITE_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/org/invite",
        },
        {
          source: ZERO_ORG_LOGO_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/org/logo",
        },
        {
          source: ZERO_ORG_MEMBERS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/org/members",
        },
        {
          source: ZERO_MEMBER_CREDIT_CAP_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/org/members/credit-cap",
        },
        {
          source: ZERO_ORG_MEMBERSHIP_REQUESTS_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/org/membership-requests",
        },
        {
          source: ZERO_VARIABLES_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/variables",
        },
        {
          source: ZERO_VARIABLE_BY_NAME_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/variables/:name",
        },
        {
          source: "/api/zero/voice-io/speech",
          destination: "https://api.example.test/api/zero/voice-io/speech",
        },
        {
          source: "/api/zero/voice-io/stt",
          destination: "https://api.example.test/api/zero/voice-io/stt",
        },
        {
          source: VOICE_IO_TTS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/voice-io/tts",
        },
        {
          source: "/api/zero/voice-chat",
          destination: "https://api.example.test/api/zero/voice-chat",
        },
        {
          source: VOICE_CHAT_TOKEN_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/voice-chat/token",
        },
        {
          source: VOICE_CHAT_SESSION_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/voice-chat/:id",
        },
        {
          source: VOICE_CHAT_ITEM_APPEND_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/voice-chat/:id/items",
        },
        {
          source: VOICE_CHAT_TASKS_REWRITE_SOURCE,
          destination: "https://api.example.test/api/zero/voice-chat/:id/tasks",
        },
        {
          source: VOICE_CHAT_TRIGGER_REASONING_REWRITE_SOURCE,
          destination:
            "https://api.example.test/api/zero/voice-chat/:id/trigger-reasoning",
        },
        {
          source: "/api/zero/web/download-file",
          destination: "https://api.example.test/api/zero/web/download-file",
        },
      ]),
    );
  });

  it("should match only one segment for agent checkpoint rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENT_CHECKPOINT_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENT_CHECKPOINT_REWRITE_SOURCE,
      destination: "https://api.example.test/api/agent/checkpoints/:id",
    });

    const matcher = getPathMatch(AGENT_CHECKPOINT_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(AGENT_CHECKPOINT_PATH)).toStrictEqual({
      id: "checkpoint_123",
    });
    for (const pathname of AGENT_CHECKPOINT_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact agent composes versions rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENT_COMPOSES_VERSIONS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENT_COMPOSES_VERSIONS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/agent/composes/versions",
    });

    const matcher = getPathMatch(AGENT_COMPOSES_VERSIONS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(AGENT_COMPOSES_VERSIONS_PATH)).toStrictEqual({});
    for (const pathname of AGENT_COMPOSES_VERSIONS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact agent composes collection rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENT_COMPOSES_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENT_COMPOSES_REWRITE_SOURCE,
      destination: "https://api.example.test/api/agent/composes",
    });

    const matcher = getPathMatch(AGENT_COMPOSES_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(AGENT_COMPOSES_PATH)).toStrictEqual({});
    for (const pathname of AGENT_COMPOSES_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact agent composes list rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENT_COMPOSES_LIST_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENT_COMPOSES_LIST_REWRITE_SOURCE,
      destination: "https://api.example.test/api/agent/composes/list",
    });

    const matcher = getPathMatch(AGENT_COMPOSES_LIST_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(AGENT_COMPOSES_LIST_PATH)).toStrictEqual({});
    for (const pathname of AGENT_COMPOSES_LIST_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only UUID-shaped agent compose by-id rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENT_COMPOSES_BY_ID_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENT_COMPOSES_BY_ID_REWRITE_SOURCE,
      destination: "https://api.example.test/api/agent/composes/:id",
    });

    const matcher = getPathMatch(AGENT_COMPOSES_BY_ID_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(AGENT_COMPOSES_BY_ID_PATH)).toStrictEqual({
      id: AGENT_COMPOSE_ID,
    });
    for (const pathname of AGENT_COMPOSES_BY_ID_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only UUID-shaped agent composes metadata rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENT_COMPOSES_METADATA_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENT_COMPOSES_METADATA_REWRITE_SOURCE,
      destination: "https://api.example.test/api/agent/composes/:id/metadata",
    });

    const matcher = getPathMatch(AGENT_COMPOSES_METADATA_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(AGENT_COMPOSES_METADATA_PATH)).toStrictEqual({
      id: AGENT_COMPOSE_ID,
    });
    for (const pathname of AGENT_COMPOSES_METADATA_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only UUID-shaped agent composes instructions rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENT_COMPOSES_INSTRUCTIONS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENT_COMPOSES_INSTRUCTIONS_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/agent/composes/:id/instructions",
    });

    const matcher = getPathMatch(AGENT_COMPOSES_INSTRUCTIONS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(AGENT_COMPOSES_INSTRUCTIONS_PATH)).toStrictEqual({
      id: AGENT_COMPOSE_ID,
    });
    for (const pathname of AGENT_COMPOSES_INSTRUCTIONS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact agent runs collection rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENT_RUNS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENT_RUNS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/agent/runs",
    });

    const matcher = getPathMatch(AGENT_RUNS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(AGENT_RUNS_PATH)).toStrictEqual({});
    for (const pathname of AGENT_RUNS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact agent runs queue rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENT_RUNS_QUEUE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENT_RUNS_QUEUE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/agent/runs/queue",
    });

    const matcher = getPathMatch(AGENT_RUNS_QUEUE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(AGENT_RUNS_QUEUE_PATH)).toStrictEqual({});
    for (const pathname of AGENT_RUNS_QUEUE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only UUID-shaped agent run cancel rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENT_RUN_CANCEL_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENT_RUN_CANCEL_REWRITE_SOURCE,
      destination: "https://api.example.test/api/agent/runs/:id/cancel",
    });

    const matcher = getPathMatch(AGENT_RUN_CANCEL_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(AGENT_RUN_CANCEL_PATH)).toStrictEqual({
      id: AGENT_RUN_ID,
    });
    for (const pathname of AGENT_RUN_CANCEL_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only UUID-shaped agent run events rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENT_RUN_EVENTS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENT_RUN_EVENTS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/agent/runs/:id/events",
    });

    const matcher = getPathMatch(AGENT_RUN_EVENTS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(AGENT_RUN_EVENTS_PATH)).toStrictEqual({
      id: AGENT_RUN_ID,
    });
    for (const pathname of AGENT_RUN_EVENTS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only UUID-shaped agent run detail rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENT_RUN_BY_ID_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENT_RUN_BY_ID_REWRITE_SOURCE,
      destination: "https://api.example.test/api/agent/runs/:id",
    });

    const matcher = getPathMatch(AGENT_RUN_BY_ID_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(AGENT_RUN_BY_ID_PATH)).toStrictEqual({
      id: AGENT_RUN_ID,
    });
    for (const pathname of AGENT_RUN_BY_ID_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only UUID-shaped agent run telemetry rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENT_RUN_TELEMETRY_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENT_RUN_TELEMETRY_REWRITE_SOURCE,
      destination: "https://api.example.test/api/agent/runs/:id/telemetry",
    });

    const matcher = getPathMatch(AGENT_RUN_TELEMETRY_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(AGENT_RUN_TELEMETRY_PATH)).toStrictEqual({
      id: AGENT_RUN_ID,
    });
    for (const pathname of AGENT_RUN_TELEMETRY_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only UUID-shaped agent run agent telemetry rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENT_RUN_TELEMETRY_AGENT_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENT_RUN_TELEMETRY_AGENT_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/agent/runs/:id/telemetry/agent",
    });

    const matcher = getPathMatch(AGENT_RUN_TELEMETRY_AGENT_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(AGENT_RUN_TELEMETRY_AGENT_PATH)).toStrictEqual({
      id: AGENT_RUN_ID,
    });
    for (const pathname of AGENT_RUN_TELEMETRY_AGENT_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only UUID-shaped agent run metrics telemetry rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENT_RUN_TELEMETRY_METRICS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENT_RUN_TELEMETRY_METRICS_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/agent/runs/:id/telemetry/metrics",
    });

    const matcher = getPathMatch(AGENT_RUN_TELEMETRY_METRICS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(AGENT_RUN_TELEMETRY_METRICS_PATH)).toStrictEqual({
      id: AGENT_RUN_ID,
    });
    for (const pathname of AGENT_RUN_TELEMETRY_METRICS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only UUID-shaped agent run network telemetry rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENT_RUN_TELEMETRY_NETWORK_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENT_RUN_TELEMETRY_NETWORK_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/agent/runs/:id/telemetry/network",
    });

    const matcher = getPathMatch(AGENT_RUN_TELEMETRY_NETWORK_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(AGENT_RUN_TELEMETRY_NETWORK_PATH)).toStrictEqual({
      id: AGENT_RUN_ID,
    });
    for (const pathname of AGENT_RUN_TELEMETRY_NETWORK_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only UUID-shaped agent run system log telemetry rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENT_RUN_TELEMETRY_SYSTEM_LOG_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENT_RUN_TELEMETRY_SYSTEM_LOG_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/agent/runs/:id/telemetry/system-log",
    });

    const matcher = getPathMatch(
      AGENT_RUN_TELEMETRY_SYSTEM_LOG_REWRITE_SOURCE,
      {
        removeUnnamedParams: true,
        strict: true,
      },
    );

    expect(matcher(AGENT_RUN_TELEMETRY_SYSTEM_LOG_PATH)).toStrictEqual({
      id: AGENT_RUN_ID,
    });
    for (const pathname of AGENT_RUN_TELEMETRY_SYSTEM_LOG_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact auth me rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AUTH_ME_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AUTH_ME_REWRITE_SOURCE,
      destination: "https://api.example.test/api/auth/me",
    });

    const matcher = getPathMatch(AUTH_ME_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(AUTH_ME_PATH)).toStrictEqual({});
    for (const pathname of AUTH_ME_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact CLI auth device rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === CLI_AUTH_DEVICE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: CLI_AUTH_DEVICE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/cli/auth/device",
    });

    const matcher = getPathMatch(CLI_AUTH_DEVICE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(CLI_AUTH_DEVICE_PATH)).toStrictEqual({});
    for (const pathname of CLI_AUTH_DEVICE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact CLI auth org rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === CLI_AUTH_ORG_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: CLI_AUTH_ORG_REWRITE_SOURCE,
      destination: "https://api.example.test/api/cli/auth/org",
    });

    const matcher = getPathMatch(CLI_AUTH_ORG_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(CLI_AUTH_ORG_PATH)).toStrictEqual({});
    for (const pathname of CLI_AUTH_ORG_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact CLI auth test approve rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === CLI_AUTH_TEST_APPROVE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: CLI_AUTH_TEST_APPROVE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/cli/auth/test-approve",
    });

    const matcher = getPathMatch(CLI_AUTH_TEST_APPROVE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(CLI_AUTH_TEST_APPROVE_PATH)).toStrictEqual({});
    for (const pathname of CLI_AUTH_TEST_APPROVE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact CLI auth token rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === CLI_AUTH_TOKEN_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: CLI_AUTH_TOKEN_REWRITE_SOURCE,
      destination: "https://api.example.test/api/cli/auth/token",
    });

    const matcher = getPathMatch(CLI_AUTH_TOKEN_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(CLI_AUTH_TOKEN_PATH)).toStrictEqual({});
    for (const pathname of CLI_AUTH_TOKEN_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact CLI auth test Codex OAuth rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === CLI_AUTH_TEST_CODEX_OAUTH_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: CLI_AUTH_TEST_CODEX_OAUTH_REWRITE_SOURCE,
      destination: "https://api.example.test/api/cli/auth/test-codex-oauth",
    });

    const matcher = getPathMatch(CLI_AUTH_TEST_CODEX_OAUTH_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(CLI_AUTH_TEST_CODEX_OAUTH_PATH)).toStrictEqual({});
    for (const pathname of CLI_AUTH_TEST_CODEX_OAUTH_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact CLI auth test connector rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === CLI_AUTH_TEST_CONNECTOR_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: CLI_AUTH_TEST_CONNECTOR_REWRITE_SOURCE,
      destination: "https://api.example.test/api/cli/auth/test-connector",
    });

    const matcher = getPathMatch(CLI_AUTH_TEST_CONNECTOR_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(CLI_AUTH_TEST_CONNECTOR_PATH)).toStrictEqual({});
    for (const pathname of CLI_AUTH_TEST_CONNECTOR_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact CLI auth test enable connector rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === CLI_AUTH_TEST_ENABLE_CONNECTOR_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: CLI_AUTH_TEST_ENABLE_CONNECTOR_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/cli/auth/test-enable-connector",
    });

    const matcher = getPathMatch(
      CLI_AUTH_TEST_ENABLE_CONNECTOR_REWRITE_SOURCE,
      {
        removeUnnamedParams: true,
        strict: true,
      },
    );

    expect(matcher(CLI_AUTH_TEST_ENABLE_CONNECTOR_PATH)).toStrictEqual({});
    for (const pathname of CLI_AUTH_TEST_ENABLE_CONNECTOR_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact CLI auth test token rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === CLI_AUTH_TEST_TOKEN_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: CLI_AUTH_TEST_TOKEN_REWRITE_SOURCE,
      destination: "https://api.example.test/api/cli/auth/test-token",
    });

    const matcher = getPathMatch(CLI_AUTH_TEST_TOKEN_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(CLI_AUTH_TEST_TOKEN_PATH)).toStrictEqual({});
    for (const pathname of CLI_AUTH_TEST_TOKEN_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact cron aggregate insights rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === CRON_AGGREGATE_INSIGHTS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: CRON_AGGREGATE_INSIGHTS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/cron/aggregate-insights",
    });

    const matcher = getPathMatch(CRON_AGGREGATE_INSIGHTS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(CRON_AGGREGATE_INSIGHTS_PATH)).toStrictEqual({});
    for (const pathname of CRON_AGGREGATE_INSIGHTS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact cron aggregate usage rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === CRON_AGGREGATE_USAGE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: CRON_AGGREGATE_USAGE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/cron/aggregate-usage",
    });

    const matcher = getPathMatch(CRON_AGGREGATE_USAGE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(CRON_AGGREGATE_USAGE_PATH)).toStrictEqual({});
    for (const pathname of CRON_AGGREGATE_USAGE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact cron cleanup sandboxes rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === CRON_CLEANUP_SANDBOXES_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: CRON_CLEANUP_SANDBOXES_REWRITE_SOURCE,
      destination: "https://api.example.test/api/cron/cleanup-sandboxes",
    });

    const matcher = getPathMatch(CRON_CLEANUP_SANDBOXES_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(CRON_CLEANUP_SANDBOXES_PATH)).toStrictEqual({});
    for (const pathname of CRON_CLEANUP_SANDBOXES_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact cron drain email outbox rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === CRON_DRAIN_EMAIL_OUTBOX_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: CRON_DRAIN_EMAIL_OUTBOX_REWRITE_SOURCE,
      destination: "https://api.example.test/api/cron/drain-email-outbox",
    });

    const matcher = getPathMatch(CRON_DRAIN_EMAIL_OUTBOX_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(CRON_DRAIN_EMAIL_OUTBOX_PATH)).toStrictEqual({});
    for (const pathname of CRON_DRAIN_EMAIL_OUTBOX_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact cron execute schedules rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === CRON_EXECUTE_SCHEDULES_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: CRON_EXECUTE_SCHEDULES_REWRITE_SOURCE,
      destination: "https://api.example.test/api/cron/execute-schedules",
    });

    const matcher = getPathMatch(CRON_EXECUTE_SCHEDULES_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(CRON_EXECUTE_SCHEDULES_PATH)).toStrictEqual({});
    for (const pathname of CRON_EXECUTE_SCHEDULES_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact cron process usage events rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === CRON_PROCESS_USAGE_EVENTS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: CRON_PROCESS_USAGE_EVENTS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/cron/process-usage-events",
    });

    const matcher = getPathMatch(CRON_PROCESS_USAGE_EVENTS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(CRON_PROCESS_USAGE_EVENTS_PATH)).toStrictEqual({});
    for (const pathname of CRON_PROCESS_USAGE_EVENTS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact cron reconcile billing entitlements rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return (
        entry.source === CRON_RECONCILE_BILLING_ENTITLEMENTS_REWRITE_SOURCE
      );
    });
    expect(rewrite).toStrictEqual({
      source: CRON_RECONCILE_BILLING_ENTITLEMENTS_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/cron/reconcile-billing-entitlements",
    });

    const matcher = getPathMatch(
      CRON_RECONCILE_BILLING_ENTITLEMENTS_REWRITE_SOURCE,
      {
        removeUnnamedParams: true,
        strict: true,
      },
    );

    expect(matcher(CRON_RECONCILE_BILLING_ENTITLEMENTS_PATH)).toStrictEqual({});
    for (const pathname of CRON_RECONCILE_BILLING_ENTITLEMENTS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact cron sync skills rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === CRON_SYNC_SKILLS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: CRON_SYNC_SKILLS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/cron/sync-skills",
    });

    const matcher = getPathMatch(CRON_SYNC_SKILLS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(CRON_SYNC_SKILLS_PATH)).toStrictEqual({});
    for (const pathname of CRON_SYNC_SKILLS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact cron telegram cleanup rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === CRON_TELEGRAM_CLEANUP_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: CRON_TELEGRAM_CLEANUP_REWRITE_SOURCE,
      destination: "https://api.example.test/api/cron/telegram-cleanup",
    });

    const matcher = getPathMatch(CRON_TELEGRAM_CLEANUP_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(CRON_TELEGRAM_CLEANUP_PATH)).toStrictEqual({});
    for (const pathname of CRON_TELEGRAM_CLEANUP_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact cron voice chat cleanup rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === CRON_VOICE_CHAT_CLEANUP_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: CRON_VOICE_CHAT_CLEANUP_REWRITE_SOURCE,
      destination: "https://api.example.test/api/cron/voice-chat-cleanup",
    });

    const matcher = getPathMatch(CRON_VOICE_CHAT_CLEANUP_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(CRON_VOICE_CHAT_CLEANUP_PATH)).toStrictEqual({});
    for (const pathname of CRON_VOICE_CHAT_CLEANUP_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the connector authorize rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === CONNECTORS_AUTHORIZE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: CONNECTORS_AUTHORIZE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/connectors/:type/authorize",
    });

    const matcher = getPathMatch(CONNECTORS_AUTHORIZE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(CONNECTORS_AUTHORIZE_PATH)).toStrictEqual({
      type: "github",
    });
    for (const pathname of CONNECTORS_AUTHORIZE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the connector callback rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === CONNECTORS_CALLBACK_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: CONNECTORS_CALLBACK_REWRITE_SOURCE,
      destination: "https://api.example.test/api/connectors/:type/callback",
    });

    const matcher = getPathMatch(CONNECTORS_CALLBACK_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(CONNECTORS_CALLBACK_PATH)).toStrictEqual({
      type: "github",
    });
    for (const pathname of CONNECTORS_CALLBACK_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact runners heartbeat rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === RUNNERS_HEARTBEAT_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: RUNNERS_HEARTBEAT_REWRITE_SOURCE,
      destination: "https://api.example.test/api/runners/heartbeat",
    });

    const matcher = getPathMatch(RUNNERS_HEARTBEAT_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(RUNNERS_HEARTBEAT_PATH)).toStrictEqual({});
    expect(matcher(RUNNERS_POLL_PATH)).toBe(false);
    expect(matcher(RUNNERS_REALTIME_TOKEN_PATH)).toBe(false);
    for (const pathname of RUNNERS_HEARTBEAT_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the single-segment runners job claim rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === RUNNERS_JOB_CLAIM_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: RUNNERS_JOB_CLAIM_REWRITE_SOURCE,
      destination: "https://api.example.test/api/runners/jobs/:id/claim",
    });

    const matcher = getPathMatch(RUNNERS_JOB_CLAIM_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(RUNNERS_JOB_CLAIM_PATH)).toStrictEqual({
      id: "11111111-1111-4111-8111-111111111111",
    });
    expect(matcher(RUNNERS_HEARTBEAT_PATH)).toBe(false);
    expect(matcher(RUNNERS_POLL_PATH)).toBe(false);
    expect(matcher(RUNNERS_REALTIME_TOKEN_PATH)).toBe(false);
    for (const pathname of RUNNERS_JOB_CLAIM_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact runners poll rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === RUNNERS_POLL_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: RUNNERS_POLL_REWRITE_SOURCE,
      destination: "https://api.example.test/api/runners/poll",
    });

    const matcher = getPathMatch(RUNNERS_POLL_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(RUNNERS_POLL_PATH)).toStrictEqual({});
    expect(matcher(RUNNERS_HEARTBEAT_PATH)).toBe(false);
    expect(matcher(RUNNERS_REALTIME_TOKEN_PATH)).toBe(false);
    for (const pathname of RUNNERS_POLL_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact runners realtime token rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === RUNNERS_REALTIME_TOKEN_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: RUNNERS_REALTIME_TOKEN_REWRITE_SOURCE,
      destination: "https://api.example.test/api/runners/realtime/token",
    });

    const matcher = getPathMatch(RUNNERS_REALTIME_TOKEN_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(RUNNERS_REALTIME_TOKEN_PATH)).toStrictEqual({});
    expect(matcher(RUNNERS_HEARTBEAT_PATH)).toBe(false);
    expect(matcher(RUNNERS_POLL_PATH)).toBe(false);
    for (const pathname of RUNNERS_REALTIME_TOKEN_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact AgentPhone connect rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENTPHONE_CONNECT_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENTPHONE_CONNECT_REWRITE_SOURCE,
      destination: "https://api.example.test/api/agentphone/connect",
    });

    const matcher = getPathMatch(AGENTPHONE_CONNECT_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(AGENTPHONE_CONNECT_PATH)).toStrictEqual({});
    for (const pathname of AGENTPHONE_CONNECT_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact AgentPhone webhook rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENTPHONE_WEBHOOK_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENTPHONE_WEBHOOK_REWRITE_SOURCE,
      destination: "https://api.example.test/api/agentphone/webhook",
    });

    const matcher = getPathMatch(AGENTPHONE_WEBHOOK_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(AGENTPHONE_WEBHOOK_PATH)).toStrictEqual({});
    for (const pathname of AGENTPHONE_WEBHOOK_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact internal agent callback rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === INTERNAL_CALLBACKS_AGENT_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: INTERNAL_CALLBACKS_AGENT_REWRITE_SOURCE,
      destination: "https://api.example.test/api/internal/callbacks/agent",
    });

    const matcher = getPathMatch(INTERNAL_CALLBACKS_AGENT_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(INTERNAL_CALLBACKS_AGENT_PATH)).toStrictEqual({});
    for (const pathname of INTERNAL_CALLBACKS_AGENT_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact internal chat callback rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === INTERNAL_CALLBACKS_CHAT_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: INTERNAL_CALLBACKS_CHAT_REWRITE_SOURCE,
      destination: "https://api.example.test/api/internal/callbacks/chat",
    });

    const matcher = getPathMatch(INTERNAL_CALLBACKS_CHAT_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(INTERNAL_CALLBACKS_CHAT_PATH)).toStrictEqual({});
    for (const pathname of INTERNAL_CALLBACKS_CHAT_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact internal GitHub issues callback rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === INTERNAL_CALLBACKS_GITHUB_ISSUES_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: INTERNAL_CALLBACKS_GITHUB_ISSUES_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/internal/callbacks/github/issues",
    });

    const matcher = getPathMatch(
      INTERNAL_CALLBACKS_GITHUB_ISSUES_REWRITE_SOURCE,
      {
        removeUnnamedParams: true,
        strict: true,
      },
    );

    expect(matcher(INTERNAL_CALLBACKS_GITHUB_ISSUES_PATH)).toStrictEqual({});
    for (const pathname of INTERNAL_CALLBACKS_GITHUB_ISSUES_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact internal cron schedule callback rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === INTERNAL_CALLBACKS_SCHEDULE_CRON_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: INTERNAL_CALLBACKS_SCHEDULE_CRON_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/internal/callbacks/schedule/cron",
    });

    const matcher = getPathMatch(
      INTERNAL_CALLBACKS_SCHEDULE_CRON_REWRITE_SOURCE,
      {
        removeUnnamedParams: true,
        strict: true,
      },
    );

    expect(matcher(INTERNAL_CALLBACKS_SCHEDULE_CRON_PATH)).toStrictEqual({});
    for (const pathname of INTERNAL_CALLBACKS_SCHEDULE_CRON_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact internal loop schedule callback rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === INTERNAL_CALLBACKS_SCHEDULE_LOOP_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: INTERNAL_CALLBACKS_SCHEDULE_LOOP_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/internal/callbacks/schedule/loop",
    });

    const matcher = getPathMatch(
      INTERNAL_CALLBACKS_SCHEDULE_LOOP_REWRITE_SOURCE,
      {
        removeUnnamedParams: true,
        strict: true,
      },
    );

    expect(matcher(INTERNAL_CALLBACKS_SCHEDULE_LOOP_PATH)).toStrictEqual({});
    for (const pathname of INTERNAL_CALLBACKS_SCHEDULE_LOOP_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact internal Slack org callback rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === INTERNAL_CALLBACKS_SLACK_ORG_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: INTERNAL_CALLBACKS_SLACK_ORG_REWRITE_SOURCE,
      destination: "https://api.example.test/api/internal/callbacks/slack/org",
    });

    const matcher = getPathMatch(INTERNAL_CALLBACKS_SLACK_ORG_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(INTERNAL_CALLBACKS_SLACK_ORG_PATH)).toStrictEqual({});
    for (const pathname of INTERNAL_CALLBACKS_SLACK_ORG_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact internal Telegram callback rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === INTERNAL_CALLBACKS_TELEGRAM_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: INTERNAL_CALLBACKS_TELEGRAM_REWRITE_SOURCE,
      destination: "https://api.example.test/api/internal/callbacks/telegram",
    });

    const matcher = getPathMatch(INTERNAL_CALLBACKS_TELEGRAM_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(INTERNAL_CALLBACKS_TELEGRAM_PATH)).toStrictEqual({});
    for (const pathname of INTERNAL_CALLBACKS_TELEGRAM_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact internal voice-chat callback rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === INTERNAL_CALLBACKS_VOICE_CHAT_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: INTERNAL_CALLBACKS_VOICE_CHAT_REWRITE_SOURCE,
      destination: "https://api.example.test/api/internal/callbacks/voice-chat",
    });

    const matcher = getPathMatch(INTERNAL_CALLBACKS_VOICE_CHAT_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(INTERNAL_CALLBACKS_VOICE_CHAT_PATH)).toStrictEqual({});
    for (const pathname of INTERNAL_CALLBACKS_VOICE_CHAT_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact Stripe CLI auth sessions rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === STRIPE_CLI_AUTH_SESSIONS_REWRITE_SOURCE;
    });
    const exactIndex = rewrites.findIndex((entry) => {
      return entry.source === STRIPE_CLI_AUTH_SESSIONS_REWRITE_SOURCE;
    });
    const childIndex = rewrites.findIndex((entry) => {
      return (
        entry.source === `${STRIPE_CLI_AUTH_SESSIONS_REWRITE_SOURCE}/:path*`
      );
    });
    expect(rewrite).toStrictEqual({
      source: STRIPE_CLI_AUTH_SESSIONS_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/zero/connectors/stripe/cli-auth/sessions",
    });
    expect(exactIndex).toBeGreaterThanOrEqual(0);
    expect(childIndex).toBeGreaterThan(exactIndex);

    const matcher = getPathMatch(STRIPE_CLI_AUTH_SESSIONS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(STRIPE_CLI_AUTH_SESSIONS_PATH)).toStrictEqual({});
    expect(matcher(STRIPE_CLI_AUTH_SESSIONS_COMPLETE_PATH)).toBe(false);
  });

  it("should match only the zero connectors list rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_CONNECTORS_LIST_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_CONNECTORS_LIST_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/connectors",
    });

    const matcher = getPathMatch(ZERO_CONNECTORS_LIST_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_CONNECTORS_LIST_PATH)).toStrictEqual({});
    for (const pathname of ZERO_CONNECTORS_LIST_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the zero connectors search rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_CONNECTORS_SEARCH_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_CONNECTORS_SEARCH_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/connectors/search",
    });

    const matcher = getPathMatch(ZERO_CONNECTORS_SEARCH_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_CONNECTORS_SEARCH_PATH)).toStrictEqual({});
    for (const pathname of ZERO_CONNECTORS_SEARCH_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the zero connectors computer rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_CONNECTORS_COMPUTER_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_CONNECTORS_COMPUTER_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/connectors/computer",
    });

    const matcher = getPathMatch(ZERO_CONNECTORS_COMPUTER_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_CONNECTORS_COMPUTER_PATH)).toStrictEqual({});
    for (const pathname of ZERO_CONNECTORS_COMPUTER_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the zero connector by-type rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_CONNECTORS_BY_TYPE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_CONNECTORS_BY_TYPE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/connectors/:type",
    });

    const matcher = getPathMatch(ZERO_CONNECTORS_BY_TYPE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_CONNECTORS_BY_TYPE_PATH)).toStrictEqual({
      type: "github",
    });
    for (const pathname of ZERO_CONNECTORS_BY_TYPE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the zero connectors scope diff rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_CONNECTORS_SCOPE_DIFF_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_CONNECTORS_SCOPE_DIFF_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/zero/connectors/:type/scope-diff",
    });

    const matcher = getPathMatch(ZERO_CONNECTORS_SCOPE_DIFF_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_CONNECTORS_SCOPE_DIFF_PATH)).toStrictEqual({
      type: "github",
    });
    for (const pathname of ZERO_CONNECTORS_SCOPE_DIFF_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the zero connector sessions rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_CONNECTORS_SESSIONS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_CONNECTORS_SESSIONS_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/zero/connectors/:type/sessions",
    });

    const matcher = getPathMatch(ZERO_CONNECTORS_SESSIONS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_CONNECTORS_SESSIONS_PATH)).toStrictEqual({
      type: "github",
    });
    for (const pathname of ZERO_CONNECTORS_SESSIONS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only UUID-shaped zero connector session polling rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_CONNECTORS_SESSION_BY_ID_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_CONNECTORS_SESSION_BY_ID_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/zero/connectors/:type/sessions/:sessionId",
    });

    const matcher = getPathMatch(ZERO_CONNECTORS_SESSION_BY_ID_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_CONNECTORS_SESSION_BY_ID_PATH)).toStrictEqual({
      type: "github",
      sessionId: ZERO_CONNECTOR_SESSION_ID,
    });
    for (const pathname of ZERO_CONNECTORS_SESSION_BY_ID_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero Slack channels rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_SLACK_CHANNELS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_SLACK_CHANNELS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/slack/channels",
    });

    const matcher = getPathMatch(ZERO_SLACK_CHANNELS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_SLACK_CHANNELS_PATH)).toStrictEqual({});
    for (const pathname of ZERO_SLACK_CHANNELS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero Slack browser connect rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_SLACK_CONNECT_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_SLACK_CONNECT_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/slack/connect",
    });

    const matcher = getPathMatch(ZERO_SLACK_CONNECT_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_SLACK_CONNECT_PATH)).toStrictEqual({});
    for (const pathname of ZERO_SLACK_CONNECT_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero Slack commands rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_SLACK_COMMANDS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_SLACK_COMMANDS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/slack/commands",
    });

    const matcher = getPathMatch(ZERO_SLACK_COMMANDS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_SLACK_COMMANDS_PATH)).toStrictEqual({});
    for (const pathname of ZERO_SLACK_COMMANDS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero Slack events rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_SLACK_EVENTS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_SLACK_EVENTS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/slack/events",
    });

    const matcher = getPathMatch(ZERO_SLACK_EVENTS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_SLACK_EVENTS_PATH)).toStrictEqual({});
    for (const pathname of ZERO_SLACK_EVENTS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero Slack interactive rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_SLACK_INTERACTIVE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_SLACK_INTERACTIVE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/slack/interactive",
    });

    const matcher = getPathMatch(ZERO_SLACK_INTERACTIVE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_SLACK_INTERACTIVE_PATH)).toStrictEqual({});
    for (const pathname of ZERO_SLACK_INTERACTIVE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the zero connector authorize rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_CONNECTORS_AUTHORIZE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_CONNECTORS_AUTHORIZE_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/zero/connectors/:type/authorize",
    });

    const matcher = getPathMatch(ZERO_CONNECTORS_AUTHORIZE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_CONNECTORS_AUTHORIZE_PATH)).toStrictEqual({
      type: "github",
    });
    for (const pathname of ZERO_CONNECTORS_AUTHORIZE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact email unsubscribe rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === EMAIL_UNSUBSCRIBE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: EMAIL_UNSUBSCRIBE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/email/unsubscribe",
    });

    const matcher = getPathMatch(EMAIL_UNSUBSCRIBE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(EMAIL_UNSUBSCRIBE_PATH)).toStrictEqual({});
    for (const pathname of EMAIL_UNSUBSCRIBE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact inbound email provider webhook rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_EMAIL_INBOUND_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_EMAIL_INBOUND_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/email/inbound",
    });

    const matcher = getPathMatch(ZERO_EMAIL_INBOUND_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_EMAIL_INBOUND_PATH)).toStrictEqual({});
    for (const pathname of ZERO_EMAIL_INBOUND_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact email reply callback rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_EMAIL_REPLY_CALLBACK_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_EMAIL_REPLY_CALLBACK_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/email/callbacks/reply",
    });

    const matcher = getPathMatch(ZERO_EMAIL_REPLY_CALLBACK_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_EMAIL_REPLY_CALLBACK_PATH)).toStrictEqual({});
    for (const pathname of ZERO_EMAIL_REPLY_CALLBACK_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact email trigger callback rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_EMAIL_TRIGGER_CALLBACK_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_EMAIL_TRIGGER_CALLBACK_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/email/callbacks/trigger",
    });

    const matcher = getPathMatch(ZERO_EMAIL_TRIGGER_CALLBACK_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_EMAIL_TRIGGER_CALLBACK_PATH)).toStrictEqual({});
    for (const pathname of ZERO_EMAIL_TRIGGER_CALLBACK_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact generate image rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === GENERATE_IMAGE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: GENERATE_IMAGE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/generate-image",
    });

    const matcher = getPathMatch(GENERATE_IMAGE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(GENERATE_IMAGE_PATH)).toStrictEqual({});
    for (const pathname of GENERATE_IMAGE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact GitHub OAuth install rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === GITHUB_OAUTH_INSTALL_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: GITHUB_OAUTH_INSTALL_REWRITE_SOURCE,
      destination: "https://api.example.test/api/github/oauth/install",
    });

    const matcher = getPathMatch(GITHUB_OAUTH_INSTALL_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(GITHUB_OAUTH_INSTALL_PATH)).toStrictEqual({});
    for (const pathname of GITHUB_OAUTH_INSTALL_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact GitHub OAuth callback rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === GITHUB_OAUTH_CALLBACK_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: GITHUB_OAUTH_CALLBACK_REWRITE_SOURCE,
      destination: "https://api.example.test/api/github/oauth/callback",
    });

    const matcher = getPathMatch(GITHUB_OAUTH_CALLBACK_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(GITHUB_OAUTH_CALLBACK_PATH)).toStrictEqual({});
    for (const pathname of GITHUB_OAUTH_CALLBACK_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact logs search rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === LOGS_SEARCH_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: LOGS_SEARCH_REWRITE_SOURCE,
      destination: "https://api.example.test/api/logs/search",
    });

    const matcher = getPathMatch(LOGS_SEARCH_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(LOGS_SEARCH_PATH)).toStrictEqual({});
    for (const pathname of LOGS_SEARCH_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero logs list rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_LOGS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_LOGS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/logs",
    });

    const matcher = getPathMatch(ZERO_LOGS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_LOGS_PATH)).toStrictEqual({});
    for (const pathname of ZERO_LOGS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero logs search rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_LOGS_SEARCH_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_LOGS_SEARCH_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/logs/search",
    });

    const matcher = getPathMatch(ZERO_LOGS_SEARCH_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_LOGS_SEARCH_PATH)).toStrictEqual({});
    for (const pathname of ZERO_LOGS_SEARCH_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only UUID-shaped zero logs by-id rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_LOGS_BY_ID_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_LOGS_BY_ID_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/logs/:id",
    });

    const matcher = getPathMatch(ZERO_LOGS_BY_ID_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_LOGS_BY_ID_PATH)).toStrictEqual({
      id: ZERO_LOG_ID,
    });
    for (const pathname of ZERO_LOGS_BY_ID_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact GitHub integration rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === INTEGRATIONS_GITHUB_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: INTEGRATIONS_GITHUB_REWRITE_SOURCE,
      destination: "https://api.example.test/api/integrations/github",
    });

    const matcher = getPathMatch(INTEGRATIONS_GITHUB_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(INTEGRATIONS_GITHUB_PATH)).toStrictEqual({});
    for (const pathname of INTEGRATIONS_GITHUB_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact GitHub webhook rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === GITHUB_WEBHOOK_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: GITHUB_WEBHOOK_REWRITE_SOURCE,
      destination: "https://api.example.test/api/webhooks/github",
    });

    const matcher = getPathMatch(GITHUB_WEBHOOK_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(GITHUB_WEBHOOK_PATH)).toStrictEqual({});
    for (const pathname of GITHUB_WEBHOOK_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact FAL built-in generation webhook rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === BUILT_IN_GENERATIONS_FAL_WEBHOOK_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: BUILT_IN_GENERATIONS_FAL_WEBHOOK_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/webhooks/built-in-generations/fal/:generationId",
    });

    const matcher = getPathMatch(
      BUILT_IN_GENERATIONS_FAL_WEBHOOK_REWRITE_SOURCE,
      {
        removeUnnamedParams: true,
        strict: true,
      },
    );

    expect(matcher(BUILT_IN_GENERATIONS_FAL_WEBHOOK_PATH)).toStrictEqual({
      generationId: "550e8400-e29b-41d4-a716-446655440000",
    });
    for (const pathname of BUILT_IN_GENERATIONS_FAL_WEBHOOK_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact agent checkpoint prepare-history webhook rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENT_CHECKPOINTS_PREPARE_HISTORY_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENT_CHECKPOINTS_PREPARE_HISTORY_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/webhooks/agent/checkpoints/prepare-history",
    });

    const matcher = getPathMatch(
      AGENT_CHECKPOINTS_PREPARE_HISTORY_REWRITE_SOURCE,
      {
        removeUnnamedParams: true,
        strict: true,
      },
    );

    expect(matcher(AGENT_CHECKPOINTS_PREPARE_HISTORY_PATH)).toStrictEqual({});
    for (const pathname of AGENT_CHECKPOINTS_PREPARE_HISTORY_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact agent complete webhook rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENT_COMPLETE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENT_COMPLETE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/webhooks/agent/complete",
    });

    const matcher = getPathMatch(AGENT_COMPLETE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(AGENT_COMPLETE_PATH)).toStrictEqual({});
    for (const pathname of AGENT_COMPLETE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact agent events webhook rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENT_EVENTS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENT_EVENTS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/webhooks/agent/events",
    });

    const matcher = getPathMatch(AGENT_EVENTS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(AGENT_EVENTS_PATH)).toStrictEqual({});
    for (const pathname of AGENT_EVENTS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact agent firewall auth webhook rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENT_FIREWALL_AUTH_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENT_FIREWALL_AUTH_REWRITE_SOURCE,
      destination: "https://api.example.test/api/webhooks/agent/firewall/auth",
    });

    const matcher = getPathMatch(AGENT_FIREWALL_AUTH_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(AGENT_FIREWALL_AUTH_PATH)).toStrictEqual({});
    for (const pathname of AGENT_FIREWALL_AUTH_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact agent heartbeat webhook rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENT_HEARTBEAT_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENT_HEARTBEAT_REWRITE_SOURCE,
      destination: "https://api.example.test/api/webhooks/agent/heartbeat",
    });

    const matcher = getPathMatch(AGENT_HEARTBEAT_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(AGENT_HEARTBEAT_PATH)).toStrictEqual({});
    for (const pathname of AGENT_HEARTBEAT_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact agent telemetry webhook rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENT_TELEMETRY_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENT_TELEMETRY_REWRITE_SOURCE,
      destination: "https://api.example.test/api/webhooks/agent/telemetry",
    });

    const matcher = getPathMatch(AGENT_TELEMETRY_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(AGENT_TELEMETRY_PATH)).toStrictEqual({});
    for (const pathname of AGENT_TELEMETRY_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact agent usage-event webhook rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENT_USAGE_EVENT_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENT_USAGE_EVENT_REWRITE_SOURCE,
      destination: "https://api.example.test/api/webhooks/agent/usage-event",
    });

    const matcher = getPathMatch(AGENT_USAGE_EVENT_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(AGENT_USAGE_EVENT_PATH)).toStrictEqual({});
    for (const pathname of AGENT_USAGE_EVENT_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact agent storages commit webhook rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENT_STORAGES_COMMIT_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENT_STORAGES_COMMIT_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/webhooks/agent/storages/commit",
    });

    const matcher = getPathMatch(AGENT_STORAGES_COMMIT_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(AGENT_STORAGES_COMMIT_PATH)).toStrictEqual({});
    for (const pathname of AGENT_STORAGES_COMMIT_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact agent storages prepare webhook rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENT_STORAGES_PREPARE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENT_STORAGES_PREPARE_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/webhooks/agent/storages/prepare",
    });

    const matcher = getPathMatch(AGENT_STORAGES_PREPARE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(AGENT_STORAGES_PREPARE_PATH)).toStrictEqual({});
    for (const pathname of AGENT_STORAGES_PREPARE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact agent checkpoints webhook rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === AGENT_CHECKPOINTS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: AGENT_CHECKPOINTS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/webhooks/agent/checkpoints",
    });

    const matcher = getPathMatch(AGENT_CHECKPOINTS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(AGENT_CHECKPOINTS_PATH)).toStrictEqual({});
    for (const pathname of AGENT_CHECKPOINTS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact Clerk webhook rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === CLERK_WEBHOOK_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: CLERK_WEBHOOK_REWRITE_SOURCE,
      destination: "https://api.example.test/api/webhooks/clerk",
    });

    const matcher = getPathMatch(CLERK_WEBHOOK_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(CLERK_WEBHOOK_PATH)).toStrictEqual({});
    for (const pathname of CLERK_WEBHOOK_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact Stripe webhook rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === STRIPE_WEBHOOK_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: STRIPE_WEBHOOK_REWRITE_SOURCE,
      destination: "https://api.example.test/api/webhooks/stripe",
    });

    const matcher = getPathMatch(STRIPE_WEBHOOK_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(STRIPE_WEBHOOK_PATH)).toStrictEqual({});
    for (const pathname of STRIPE_WEBHOOK_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact storages list rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === STORAGES_LIST_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: STORAGES_LIST_REWRITE_SOURCE,
      destination: "https://api.example.test/api/storages/list",
    });

    const matcher = getPathMatch(STORAGES_LIST_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(STORAGES_LIST_PATH)).toStrictEqual({});
    for (const pathname of STORAGES_LIST_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact storages commit rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === STORAGES_COMMIT_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: STORAGES_COMMIT_REWRITE_SOURCE,
      destination: "https://api.example.test/api/storages/commit",
    });

    const matcher = getPathMatch(STORAGES_COMMIT_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(STORAGES_COMMIT_PATH)).toStrictEqual({});
    for (const pathname of STORAGES_COMMIT_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact storages download rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === STORAGES_DOWNLOAD_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: STORAGES_DOWNLOAD_REWRITE_SOURCE,
      destination: "https://api.example.test/api/storages/download",
    });

    const matcher = getPathMatch(STORAGES_DOWNLOAD_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(STORAGES_DOWNLOAD_PATH)).toStrictEqual({});
    for (const pathname of STORAGES_DOWNLOAD_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact storages prepare rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === STORAGES_PREPARE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: STORAGES_PREPARE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/storages/prepare",
    });

    const matcher = getPathMatch(STORAGES_PREPARE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(STORAGES_PREPARE_PATH)).toStrictEqual({});
    for (const pathname of STORAGES_PREPARE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact usage rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === USAGE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: USAGE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/usage",
    });

    const matcher = getPathMatch(USAGE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(USAGE_PATH)).toStrictEqual({});
    for (const pathname of USAGE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact test slack dispatch probe rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === TEST_SLACK_DISPATCH_PROBE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: TEST_SLACK_DISPATCH_PROBE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/test/slack-dispatch-probe",
    });

    const matcher = getPathMatch(TEST_SLACK_DISPATCH_PROBE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(TEST_SLACK_DISPATCH_PROBE_PATH)).toStrictEqual({});
    for (const pathname of TEST_SLACK_DISPATCH_PROBE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact test slack mock assistant status rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === TEST_SLACK_MOCK_ASSISTANT_STATUS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: TEST_SLACK_MOCK_ASSISTANT_STATUS_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/test/slack-mock/assistant.threads.setStatus",
    });

    const matcher = getPathMatch(
      TEST_SLACK_MOCK_ASSISTANT_STATUS_REWRITE_SOURCE,
      {
        removeUnnamedParams: true,
        strict: true,
      },
    );

    expect(matcher(TEST_SLACK_MOCK_ASSISTANT_STATUS_PATH)).toStrictEqual({});
    for (const pathname of TEST_SLACK_MOCK_ASSISTANT_STATUS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact test slack mock chat.postEphemeral rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return (
        entry.source === TEST_SLACK_MOCK_CHAT_POST_EPHEMERAL_REWRITE_SOURCE
      );
    });
    expect(rewrite).toStrictEqual({
      source: TEST_SLACK_MOCK_CHAT_POST_EPHEMERAL_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/test/slack-mock/chat.postEphemeral",
    });

    const matcher = getPathMatch(
      TEST_SLACK_MOCK_CHAT_POST_EPHEMERAL_REWRITE_SOURCE,
      {
        removeUnnamedParams: true,
        strict: true,
      },
    );

    expect(matcher(TEST_SLACK_MOCK_CHAT_POST_EPHEMERAL_PATH)).toStrictEqual({});
    for (const pathname of TEST_SLACK_MOCK_CHAT_POST_EPHEMERAL_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact test slack state rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === TEST_SLACK_STATE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: TEST_SLACK_STATE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/test/slack-state",
    });

    const matcher = getPathMatch(TEST_SLACK_STATE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(TEST_SLACK_STATE_PATH)).toStrictEqual({});
    for (const pathname of TEST_SLACK_STATE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact test telegram state rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === TEST_TELEGRAM_STATE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: TEST_TELEGRAM_STATE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/test/telegram-state",
    });

    const matcher = getPathMatch(TEST_TELEGRAM_STATE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(TEST_TELEGRAM_STATE_PATH)).toStrictEqual({});
    for (const pathname of TEST_TELEGRAM_STATE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match one bot token and one method for the test Telegram mock rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === TEST_TELEGRAM_MOCK_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: TEST_TELEGRAM_MOCK_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/test/telegram-mock/:botToken/:method",
    });

    const matcher = getPathMatch(TEST_TELEGRAM_MOCK_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(TEST_TELEGRAM_MOCK_PATH)).toStrictEqual({
      botToken: "bot123",
      method: "sendMessage",
    });
    for (const pathname of TEST_TELEGRAM_MOCK_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact test slack mock conversations.open rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === TEST_SLACK_MOCK_CONVERSATIONS_OPEN_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: TEST_SLACK_MOCK_CONVERSATIONS_OPEN_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/test/slack-mock/conversations.open",
    });

    const matcher = getPathMatch(
      TEST_SLACK_MOCK_CONVERSATIONS_OPEN_REWRITE_SOURCE,
      {
        removeUnnamedParams: true,
        strict: true,
      },
    );

    expect(matcher(TEST_SLACK_MOCK_CONVERSATIONS_OPEN_PATH)).toStrictEqual({});
    for (const pathname of TEST_SLACK_MOCK_CONVERSATIONS_OPEN_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact test slack mock oauth.v2.access rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === TEST_SLACK_MOCK_OAUTH_ACCESS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: TEST_SLACK_MOCK_OAUTH_ACCESS_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/test/slack-mock/oauth.v2.access",
    });

    const matcher = getPathMatch(TEST_SLACK_MOCK_OAUTH_ACCESS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(TEST_SLACK_MOCK_OAUTH_ACCESS_PATH)).toStrictEqual({});
    for (const pathname of TEST_SLACK_MOCK_OAUTH_ACCESS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact test slack mock views.publish rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === TEST_SLACK_MOCK_VIEWS_PUBLISH_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: TEST_SLACK_MOCK_VIEWS_PUBLISH_REWRITE_SOURCE,
      destination: "https://api.example.test/api/test/slack-mock/views.publish",
    });

    const matcher = getPathMatch(TEST_SLACK_MOCK_VIEWS_PUBLISH_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(TEST_SLACK_MOCK_VIEWS_PUBLISH_PATH)).toStrictEqual({});
    for (const pathname of TEST_SLACK_MOCK_VIEWS_PUBLISH_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact test Slack auth mock rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === TEST_SLACK_MOCK_AUTH_TEST_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: TEST_SLACK_MOCK_AUTH_TEST_REWRITE_SOURCE,
      destination: "https://api.example.test/api/test/slack-mock/auth.test",
    });

    const matcher = getPathMatch(TEST_SLACK_MOCK_AUTH_TEST_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(TEST_SLACK_MOCK_AUTH_TEST_PATH)).toStrictEqual({});
    for (const pathname of TEST_SLACK_MOCK_AUTH_TEST_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact test Slack chat.postMessage mock rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === TEST_SLACK_MOCK_CHAT_POST_MESSAGE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: TEST_SLACK_MOCK_CHAT_POST_MESSAGE_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/test/slack-mock/chat.postMessage",
    });

    const matcher = getPathMatch(
      TEST_SLACK_MOCK_CHAT_POST_MESSAGE_REWRITE_SOURCE,
      {
        removeUnnamedParams: true,
        strict: true,
      },
    );

    expect(matcher(TEST_SLACK_MOCK_CHAT_POST_MESSAGE_PATH)).toStrictEqual({});
    for (const pathname of TEST_SLACK_MOCK_CHAT_POST_MESSAGE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact test Slack conversations.history mock rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return (
        entry.source === TEST_SLACK_MOCK_CONVERSATIONS_HISTORY_REWRITE_SOURCE
      );
    });
    expect(rewrite).toStrictEqual({
      source: TEST_SLACK_MOCK_CONVERSATIONS_HISTORY_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/test/slack-mock/conversations.history",
    });

    const matcher = getPathMatch(
      TEST_SLACK_MOCK_CONVERSATIONS_HISTORY_REWRITE_SOURCE,
      {
        removeUnnamedParams: true,
        strict: true,
      },
    );

    expect(matcher(TEST_SLACK_MOCK_CONVERSATIONS_HISTORY_PATH)).toStrictEqual(
      {},
    );
    for (const pathname of TEST_SLACK_MOCK_CONVERSATIONS_HISTORY_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact test Slack conversations.replies mock rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return (
        entry.source === TEST_SLACK_MOCK_CONVERSATIONS_REPLIES_REWRITE_SOURCE
      );
    });
    expect(rewrite).toStrictEqual({
      source: TEST_SLACK_MOCK_CONVERSATIONS_REPLIES_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/test/slack-mock/conversations.replies",
    });

    const matcher = getPathMatch(
      TEST_SLACK_MOCK_CONVERSATIONS_REPLIES_REWRITE_SOURCE,
      {
        removeUnnamedParams: true,
        strict: true,
      },
    );

    expect(matcher(TEST_SLACK_MOCK_CONVERSATIONS_REPLIES_PATH)).toStrictEqual(
      {},
    );
    for (const pathname of TEST_SLACK_MOCK_CONVERSATIONS_REPLIES_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact test Slack users.info mock rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === TEST_SLACK_MOCK_USERS_INFO_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: TEST_SLACK_MOCK_USERS_INFO_REWRITE_SOURCE,
      destination: "https://api.example.test/api/test/slack-mock/users.info",
    });

    const matcher = getPathMatch(TEST_SLACK_MOCK_USERS_INFO_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(TEST_SLACK_MOCK_USERS_INFO_PATH)).toStrictEqual({});
    for (const pathname of TEST_SLACK_MOCK_USERS_INFO_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact push subscriptions rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === PUSH_SUBSCRIPTIONS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: PUSH_SUBSCRIPTIONS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/push-subscriptions",
    });

    const matcher = getPathMatch(PUSH_SUBSCRIPTIONS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(PUSH_SUBSCRIPTIONS_PATH)).toStrictEqual({});
    for (const pathname of PUSH_SUBSCRIPTIONS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact queue position rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === QUEUE_POSITION_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: QUEUE_POSITION_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/queue-position",
    });

    const matcher = getPathMatch(QUEUE_POSITION_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(QUEUE_POSITION_PATH)).toStrictEqual({});
    for (const pathname of QUEUE_POSITION_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact permission access requests rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === PERMISSION_ACCESS_REQUESTS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: PERMISSION_ACCESS_REQUESTS_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/zero/permission-access-requests",
    });

    const matcher = getPathMatch(PERMISSION_ACCESS_REQUESTS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(PERMISSION_ACCESS_REQUESTS_PATH)).toStrictEqual({});
    for (const pathname of PERMISSION_ACCESS_REQUESTS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact user model preference rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === USER_MODEL_PREFERENCE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: USER_MODEL_PREFERENCE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/user-model-preference",
    });

    const matcher = getPathMatch(USER_MODEL_PREFERENCE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(USER_MODEL_PREFERENCE_PATH)).toStrictEqual({});
    for (const pathname of USER_MODEL_PREFERENCE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero chat search rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_CHAT_SEARCH_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_CHAT_SEARCH_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/chat/search",
    });

    const matcher = getPathMatch(ZERO_CHAT_SEARCH_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_CHAT_SEARCH_PATH)).toStrictEqual({});
    for (const pathname of ZERO_CHAT_SEARCH_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero chat messages rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_CHAT_MESSAGES_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_CHAT_MESSAGES_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/chat/messages",
    });

    const matcher = getPathMatch(ZERO_CHAT_MESSAGES_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_CHAT_MESSAGES_PATH)).toStrictEqual({});
    for (const pathname of ZERO_CHAT_MESSAGES_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero composes rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_COMPOSES_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_COMPOSES_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/composes",
    });

    const matcher = getPathMatch(ZERO_COMPOSES_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_COMPOSES_PATH)).toStrictEqual({});
    for (const pathname of ZERO_COMPOSES_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero composes list rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_COMPOSES_LIST_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_COMPOSES_LIST_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/composes/list",
    });

    const matcher = getPathMatch(ZERO_COMPOSES_LIST_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_COMPOSES_LIST_PATH)).toStrictEqual({});
    for (const pathname of ZERO_COMPOSES_LIST_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only zero composes by-id rewrite paths", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_COMPOSES_BY_ID_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_COMPOSES_BY_ID_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/composes/:id",
    });

    const matcher = getPathMatch(ZERO_COMPOSES_BY_ID_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_COMPOSES_BY_ID_PATH)).toStrictEqual({
      id: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(matcher("/api/zero/composes/not-a-uuid")).toStrictEqual({
      id: "not-a-uuid",
    });
    expect(matcher("/api/zero/composes/metadata")).toStrictEqual({
      id: "metadata",
    });
    for (const pathname of ZERO_COMPOSES_BY_ID_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only zero composes metadata rewrite paths", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_COMPOSES_METADATA_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_COMPOSES_METADATA_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/composes/:id/metadata",
    });

    const matcher = getPathMatch(ZERO_COMPOSES_METADATA_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_COMPOSES_METADATA_PATH)).toStrictEqual({
      id: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(matcher("/api/zero/composes/not-a-uuid/metadata")).toStrictEqual({
      id: "not-a-uuid",
    });
    for (const pathname of ZERO_COMPOSES_METADATA_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero computer-use host rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_COMPUTER_USE_HOST_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_COMPUTER_USE_HOST_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/computer-use/host",
    });

    const matcher = getPathMatch(ZERO_COMPUTER_USE_HOST_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_COMPUTER_USE_HOST_PATH)).toStrictEqual({});
    for (const pathname of ZERO_COMPUTER_USE_HOST_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero computer-use register rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_COMPUTER_USE_REGISTER_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_COMPUTER_USE_REGISTER_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/computer-use/register",
    });

    const matcher = getPathMatch(ZERO_COMPUTER_USE_REGISTER_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_COMPUTER_USE_REGISTER_PATH)).toStrictEqual({});
    for (const pathname of ZERO_COMPUTER_USE_REGISTER_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero computer-use unregister rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_COMPUTER_USE_UNREGISTER_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_COMPUTER_USE_UNREGISTER_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/computer-use/unregister",
    });

    const matcher = getPathMatch(ZERO_COMPUTER_USE_UNREGISTER_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_COMPUTER_USE_UNREGISTER_PATH)).toStrictEqual({});
    for (const pathname of ZERO_COMPUTER_USE_UNREGISTER_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero insights range rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_INSIGHTS_RANGE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_INSIGHTS_RANGE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/insights/range",
    });

    const matcher = getPathMatch(ZERO_INSIGHTS_RANGE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_INSIGHTS_RANGE_PATH)).toStrictEqual({});
    for (const pathname of ZERO_INSIGHTS_RANGE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero insights rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_INSIGHTS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_INSIGHTS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/insights",
    });

    const matcher = getPathMatch(ZERO_INSIGHTS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_INSIGHTS_PATH)).toStrictEqual({});
    for (const pathname of ZERO_INSIGHTS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact v1 chat thread send rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === V1_CHAT_THREADS_MESSAGES_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: V1_CHAT_THREADS_MESSAGES_REWRITE_SOURCE,
      destination: "https://api.example.test/api/v1/chat-threads/messages",
    });

    const matcher = getPathMatch(V1_CHAT_THREADS_MESSAGES_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(V1_CHAT_THREADS_MESSAGES_PATH)).toStrictEqual({});
    for (const pathname of V1_CHAT_THREADS_MESSAGES_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match the v1 chat thread detail rewrite without shadowing sibling routes", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === V1_CHAT_THREAD_DETAIL_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: V1_CHAT_THREAD_DETAIL_REWRITE_SOURCE,
      destination: "https://api.example.test/api/v1/chat-threads/:threadId",
    });

    const matcher = getPathMatch(V1_CHAT_THREAD_DETAIL_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(V1_CHAT_THREAD_DETAIL_PATH)).toStrictEqual({
      threadId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(matcher(V1_CHAT_THREAD_DETAIL_INVALID_UUID_PATH)).toStrictEqual({
      threadId: "not-a-uuid",
    });
    for (const pathname of V1_CHAT_THREAD_DETAIL_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match the v1 chat thread messages rewrite without shadowing sibling routes", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === V1_CHAT_THREAD_MESSAGES_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: V1_CHAT_THREAD_MESSAGES_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/v1/chat-threads/:threadId/messages",
    });

    const matcher = getPathMatch(V1_CHAT_THREAD_MESSAGES_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(V1_CHAT_THREAD_MESSAGES_PATH)).toStrictEqual({
      threadId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(matcher(V1_CHAT_THREAD_MESSAGES_INVALID_UUID_PATH)).toStrictEqual({
      threadId: "not-a-uuid",
    });
    for (const pathname of V1_CHAT_THREAD_MESSAGES_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero chat threads collection rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_CHAT_THREADS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_CHAT_THREADS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/chat-threads",
    });

    const matcher = getPathMatch(ZERO_CHAT_THREADS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_CHAT_THREADS_PATH)).toStrictEqual({});
    for (const pathname of ZERO_CHAT_THREADS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only one segment for the zero chat thread artifacts rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_CHAT_THREAD_ARTIFACTS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_CHAT_THREAD_ARTIFACTS_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/zero/chat-threads/:threadId/artifacts",
    });

    const matcher = getPathMatch(ZERO_CHAT_THREAD_ARTIFACTS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_CHAT_THREAD_ARTIFACTS_PATH)).toStrictEqual({
      threadId: "550e8400-e29b-41d4-a716-446655440000",
    });
    for (const pathname of ZERO_CHAT_THREAD_ARTIFACTS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only one segment for the zero chat thread messages rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_CHAT_THREAD_MESSAGES_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_CHAT_THREAD_MESSAGES_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/zero/chat-threads/:threadId/messages",
    });

    const matcher = getPathMatch(ZERO_CHAT_THREAD_MESSAGES_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_CHAT_THREAD_MESSAGES_PATH)).toStrictEqual({
      threadId: "550e8400-e29b-41d4-a716-446655440000",
    });
    for (const pathname of ZERO_CHAT_THREAD_MESSAGES_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only one segment for the zero chat thread detail rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_CHAT_THREAD_DETAIL_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_CHAT_THREAD_DETAIL_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/chat-threads/:id",
    });

    const matcher = getPathMatch(ZERO_CHAT_THREAD_DETAIL_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_CHAT_THREAD_DETAIL_PATH)).toStrictEqual({
      id: "550e8400-e29b-41d4-a716-446655440000",
    });
    for (const pathname of ZERO_CHAT_THREAD_DETAIL_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only one segment for the zero chat thread mark-read rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_CHAT_THREAD_MARK_READ_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_CHAT_THREAD_MARK_READ_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/zero/chat-threads/:id/mark-read",
    });

    const matcher = getPathMatch(ZERO_CHAT_THREAD_MARK_READ_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_CHAT_THREAD_MARK_READ_PATH)).toStrictEqual({
      id: "550e8400-e29b-41d4-a716-446655440000",
    });
    for (const pathname of ZERO_CHAT_THREAD_MARK_READ_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only one segment for the zero chat thread pin rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_CHAT_THREAD_PIN_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_CHAT_THREAD_PIN_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/chat-threads/:id/pin",
    });

    const matcher = getPathMatch(ZERO_CHAT_THREAD_PIN_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_CHAT_THREAD_PIN_PATH)).toStrictEqual({
      id: "550e8400-e29b-41d4-a716-446655440000",
    });
    for (const pathname of ZERO_CHAT_THREAD_PIN_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only one segment for the zero chat thread rename rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_CHAT_THREAD_RENAME_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_CHAT_THREAD_RENAME_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/chat-threads/:id/rename",
    });

    const matcher = getPathMatch(ZERO_CHAT_THREAD_RENAME_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_CHAT_THREAD_RENAME_PATH)).toStrictEqual({
      id: "550e8400-e29b-41d4-a716-446655440000",
    });
    for (const pathname of ZERO_CHAT_THREAD_RENAME_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only one segment for the zero chat thread unpin rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_CHAT_THREAD_UNPIN_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_CHAT_THREAD_UNPIN_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/chat-threads/:id/unpin",
    });

    const matcher = getPathMatch(ZERO_CHAT_THREAD_UNPIN_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_CHAT_THREAD_UNPIN_PATH)).toStrictEqual({
      id: "550e8400-e29b-41d4-a716-446655440000",
    });
    for (const pathname of ZERO_CHAT_THREAD_UNPIN_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero org rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_ORG_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_ORG_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/org",
    });

    const matcher = getPathMatch(ZERO_ORG_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_ORG_PATH)).toStrictEqual({});
    for (const pathname of ZERO_ORG_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero org list rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_ORG_LIST_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_ORG_LIST_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/org/list",
    });

    const matcher = getPathMatch(ZERO_ORG_LIST_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_ORG_LIST_PATH)).toStrictEqual({});
    for (const pathname of ZERO_ORG_LIST_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero org domains rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_ORG_DOMAINS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_ORG_DOMAINS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/org/domains",
    });

    const matcher = getPathMatch(ZERO_ORG_DOMAINS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_ORG_DOMAINS_PATH)).toStrictEqual({});
    for (const pathname of ZERO_ORG_DOMAINS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero me model-providers root rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_ME_MODEL_PROVIDERS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_ME_MODEL_PROVIDERS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/me/model-providers",
    });

    const matcher = getPathMatch(ZERO_ME_MODEL_PROVIDERS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_ME_MODEL_PROVIDERS_PATH)).toStrictEqual({});
    for (const pathname of ZERO_ME_MODEL_PROVIDERS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only one segment for zero me model-provider type rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_ME_MODEL_PROVIDER_TYPE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_ME_MODEL_PROVIDER_TYPE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/me/model-providers/:type",
    });

    const matcher = getPathMatch(ZERO_ME_MODEL_PROVIDER_TYPE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_ME_MODEL_PROVIDER_TYPE_PATH)).toStrictEqual({
      type: "claude-code-oauth-token",
    });
    for (const pathname of ZERO_ME_MODEL_PROVIDER_TYPE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only one segment for zero variable by-name rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_VARIABLE_BY_NAME_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_VARIABLE_BY_NAME_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/variables/:name",
    });

    const matcher = getPathMatch(ZERO_VARIABLE_BY_NAME_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_VARIABLE_BY_NAME_PATH)).toStrictEqual({
      name: "USER_TOKEN",
    });
    for (const pathname of ZERO_VARIABLE_BY_NAME_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero model providers rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_MODEL_PROVIDERS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_MODEL_PROVIDERS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/model-providers",
    });

    const matcher = getPathMatch(ZERO_MODEL_PROVIDERS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_MODEL_PROVIDERS_PATH)).toStrictEqual({});
    for (const pathname of ZERO_MODEL_PROVIDERS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero api keys rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_API_KEYS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_API_KEYS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/api-keys",
    });

    const matcher = getPathMatch(ZERO_API_KEYS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_API_KEYS_PATH)).toStrictEqual({});
    for (const pathname of ZERO_API_KEYS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only UUID-shaped zero api key by-id rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_API_KEY_BY_ID_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_API_KEY_BY_ID_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/api-keys/:id",
    });

    const matcher = getPathMatch(ZERO_API_KEY_BY_ID_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_API_KEY_BY_ID_PATH)).toStrictEqual({
      id: ZERO_API_KEY_ID,
    });
    for (const pathname of ZERO_API_KEY_BY_ID_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero billing status rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_BILLING_STATUS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_BILLING_STATUS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/billing/status",
    });

    const matcher = getPathMatch(ZERO_BILLING_STATUS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_BILLING_STATUS_PATH)).toStrictEqual({});
    for (const pathname of ZERO_BILLING_STATUS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero developer-support rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_DEVELOPER_SUPPORT_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_DEVELOPER_SUPPORT_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/developer-support",
    });

    const matcher = getPathMatch(ZERO_DEVELOPER_SUPPORT_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_DEVELOPER_SUPPORT_PATH)).toStrictEqual({});
    for (const pathname of ZERO_DEVELOPER_SUPPORT_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero billing auto-recharge rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_BILLING_AUTO_RECHARGE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_BILLING_AUTO_RECHARGE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/billing/auto-recharge",
    });

    const matcher = getPathMatch(ZERO_BILLING_AUTO_RECHARGE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_BILLING_AUTO_RECHARGE_PATH)).toStrictEqual({});
    for (const pathname of ZERO_BILLING_AUTO_RECHARGE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero billing checkout rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_BILLING_CHECKOUT_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_BILLING_CHECKOUT_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/billing/checkout",
    });

    const matcher = getPathMatch(ZERO_BILLING_CHECKOUT_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_BILLING_CHECKOUT_PATH)).toStrictEqual({});
    for (const pathname of ZERO_BILLING_CHECKOUT_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero billing downgrade rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_BILLING_DOWNGRADE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_BILLING_DOWNGRADE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/billing/downgrade",
    });

    const matcher = getPathMatch(ZERO_BILLING_DOWNGRADE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_BILLING_DOWNGRADE_PATH)).toStrictEqual({});
    for (const pathname of ZERO_BILLING_DOWNGRADE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero billing invoices rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_BILLING_INVOICES_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_BILLING_INVOICES_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/billing/invoices",
    });

    const matcher = getPathMatch(ZERO_BILLING_INVOICES_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_BILLING_INVOICES_PATH)).toStrictEqual({});
    for (const pathname of ZERO_BILLING_INVOICES_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero billing portal rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_BILLING_PORTAL_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_BILLING_PORTAL_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/billing/portal",
    });

    const matcher = getPathMatch(ZERO_BILLING_PORTAL_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_BILLING_PORTAL_PATH)).toStrictEqual({});
    for (const pathname of ZERO_BILLING_PORTAL_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the single-segment zero billing redeem rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_BILLING_REDEEM_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_BILLING_REDEEM_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/billing/redeem/:campaign",
    });

    const matcher = getPathMatch(ZERO_BILLING_REDEEM_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_BILLING_REDEEM_PATH)).toStrictEqual({
      campaign: "ZERO100",
    });
    for (const pathname of ZERO_BILLING_REDEEM_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero default-agent rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_DEFAULT_AGENT_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_DEFAULT_AGENT_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/default-agent",
    });

    const matcher = getPathMatch(ZERO_DEFAULT_AGENT_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_DEFAULT_AGENT_PATH)).toStrictEqual({});
    for (const pathname of ZERO_DEFAULT_AGENT_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact permission policies rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === PERMISSION_POLICIES_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: PERMISSION_POLICIES_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/permission-policies",
    });

    const matcher = getPathMatch(PERMISSION_POLICIES_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(PERMISSION_POLICIES_PATH)).toStrictEqual({});
    for (const pathname of PERMISSION_POLICIES_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero member credit cap rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_MEMBER_CREDIT_CAP_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_MEMBER_CREDIT_CAP_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/org/members/credit-cap",
    });

    const matcher = getPathMatch(ZERO_MEMBER_CREDIT_CAP_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_MEMBER_CREDIT_CAP_PATH)).toStrictEqual({});
    for (const pathname of ZERO_MEMBER_CREDIT_CAP_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero org members rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_ORG_MEMBERS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_ORG_MEMBERS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/org/members",
    });

    const matcher = getPathMatch(ZERO_ORG_MEMBERS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_ORG_MEMBERS_PATH)).toStrictEqual({});
    for (const pathname of ZERO_ORG_MEMBERS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero org delete rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_ORG_DELETE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_ORG_DELETE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/org/delete",
    });

    const matcher = getPathMatch(ZERO_ORG_DELETE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_ORG_DELETE_PATH)).toStrictEqual({});
    for (const pathname of ZERO_ORG_DELETE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero secrets root rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_SECRETS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_SECRETS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/secrets",
    });

    const matcher = getPathMatch(ZERO_SECRETS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_SECRETS_PATH)).toStrictEqual({});
    for (const pathname of ZERO_SECRETS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the single-segment zero secrets by-name rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_SECRETS_BY_NAME_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_SECRETS_BY_NAME_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/secrets/:name",
    });

    const matcher = getPathMatch(ZERO_SECRETS_BY_NAME_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_SECRETS_BY_NAME_PATH)).toStrictEqual({
      name: "DELETE_ME",
    });
    for (const pathname of ZERO_SECRETS_BY_NAME_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the single-segment zero schedules disable rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_SCHEDULES_DISABLE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_SCHEDULES_DISABLE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/schedules/:name/disable",
    });

    const matcher = getPathMatch(ZERO_SCHEDULES_DISABLE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_SCHEDULES_DISABLE_PATH)).toStrictEqual({
      name: "nightly",
    });
    for (const pathname of ZERO_SCHEDULES_DISABLE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero schedules rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_SCHEDULES_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_SCHEDULES_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/schedules",
    });

    const matcher = getPathMatch(ZERO_SCHEDULES_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_SCHEDULES_PATH)).toStrictEqual({});
    for (const pathname of ZERO_SCHEDULES_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero runs rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_RUNS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_RUNS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/runs",
    });

    const matcher = getPathMatch(ZERO_RUNS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_RUNS_PATH)).toStrictEqual({});
    for (const pathname of ZERO_RUNS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero runs queue rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_RUNS_QUEUE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_RUNS_QUEUE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/runs/queue",
    });

    const matcher = getPathMatch(ZERO_RUNS_QUEUE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_RUNS_QUEUE_PATH)).toStrictEqual({});
    for (const pathname of ZERO_RUNS_QUEUE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only UUID-shaped zero runs by-id rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_RUNS_BY_ID_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_RUNS_BY_ID_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/runs/:id",
    });

    const matcher = getPathMatch(ZERO_RUNS_BY_ID_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_RUNS_BY_ID_PATH)).toStrictEqual({
      id: ZERO_RUN_ID,
    });
    for (const pathname of ZERO_RUNS_BY_ID_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only UUID-shaped zero runs cancel rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_RUNS_CANCEL_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_RUNS_CANCEL_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/runs/:id/cancel",
    });

    const matcher = getPathMatch(ZERO_RUNS_CANCEL_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_RUNS_CANCEL_PATH)).toStrictEqual({
      id: ZERO_RUN_ID,
    });
    for (const pathname of ZERO_RUNS_CANCEL_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only UUID-shaped zero runs context rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_RUNS_CONTEXT_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_RUNS_CONTEXT_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/runs/:id/context",
    });

    const matcher = getPathMatch(ZERO_RUNS_CONTEXT_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_RUNS_CONTEXT_PATH)).toStrictEqual({
      id: ZERO_RUN_ID,
    });
    for (const pathname of ZERO_RUNS_CONTEXT_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only UUID-shaped zero runs network rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_RUNS_NETWORK_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_RUNS_NETWORK_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/runs/:id/network",
    });

    const matcher = getPathMatch(ZERO_RUNS_NETWORK_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_RUNS_NETWORK_PATH)).toStrictEqual({
      id: ZERO_RUN_ID,
    });
    for (const pathname of ZERO_RUNS_NETWORK_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only UUID-shaped zero runs runner rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_RUNS_RUNNER_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_RUNS_RUNNER_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/runs/:id/runner",
    });

    const matcher = getPathMatch(ZERO_RUNS_RUNNER_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_RUNS_RUNNER_PATH)).toStrictEqual({
      id: ZERO_RUN_ID,
    });
    for (const pathname of ZERO_RUNS_RUNNER_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only UUID-shaped zero runs agent events rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_RUNS_AGENT_EVENTS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_RUNS_AGENT_EVENTS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/runs/:id/telemetry/agent",
    });

    const matcher = getPathMatch(ZERO_RUNS_AGENT_EVENTS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_RUNS_AGENT_EVENTS_PATH)).toStrictEqual({
      id: ZERO_RUN_ID,
    });
    for (const pathname of ZERO_RUNS_AGENT_EVENTS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero schedules run rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_SCHEDULES_RUN_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_SCHEDULES_RUN_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/schedules/run",
    });

    const matcher = getPathMatch(ZERO_SCHEDULES_RUN_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_SCHEDULES_RUN_PATH)).toStrictEqual({});
    for (const pathname of ZERO_SCHEDULES_RUN_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should place the exact zero schedules run rewrite before the by-name rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const runIndex = rewrites.findIndex((entry) => {
      return entry.source === ZERO_SCHEDULES_RUN_REWRITE_SOURCE;
    });
    const byNameIndex = rewrites.findIndex((entry) => {
      return entry.source === ZERO_SCHEDULES_BY_NAME_REWRITE_SOURCE;
    });

    expect(runIndex).toBeGreaterThanOrEqual(0);
    expect(byNameIndex).toBeGreaterThanOrEqual(0);
    expect(runIndex).toBeLessThan(byNameIndex);
  });

  it("should match only the single-segment zero schedules by-name rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_SCHEDULES_BY_NAME_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_SCHEDULES_BY_NAME_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/schedules/:name",
    });

    const matcher = getPathMatch(ZERO_SCHEDULES_BY_NAME_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_SCHEDULES_BY_NAME_PATH)).toStrictEqual({
      name: "nightly",
    });
    expect(matcher(ZERO_SCHEDULES_PATH)).toBe(false);
    for (const pathname of ZERO_SCHEDULES_BY_NAME_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the single-segment zero schedules enable rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_SCHEDULES_ENABLE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_SCHEDULES_ENABLE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/schedules/:name/enable",
    });

    const matcher = getPathMatch(ZERO_SCHEDULES_ENABLE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_SCHEDULES_ENABLE_PATH)).toStrictEqual({
      name: "nightly",
    });
    for (const pathname of ZERO_SCHEDULES_ENABLE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero org membership requests rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_ORG_MEMBERSHIP_REQUESTS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_ORG_MEMBERSHIP_REQUESTS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/org/membership-requests",
    });

    const matcher = getPathMatch(ZERO_ORG_MEMBERSHIP_REQUESTS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_ORG_MEMBERSHIP_REQUESTS_PATH)).toStrictEqual({});
    for (const pathname of ZERO_ORG_MEMBERSHIP_REQUESTS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero org invite rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_ORG_INVITE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_ORG_INVITE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/org/invite",
    });

    const matcher = getPathMatch(ZERO_ORG_INVITE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_ORG_INVITE_PATH)).toStrictEqual({});
    for (const pathname of ZERO_ORG_INVITE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero org leave rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_ORG_LEAVE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_ORG_LEAVE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/org/leave",
    });

    const matcher = getPathMatch(ZERO_ORG_LEAVE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_ORG_LEAVE_PATH)).toStrictEqual({});
    for (const pathname of ZERO_ORG_LEAVE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only one segment for zero model provider type rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_MODEL_PROVIDER_TYPE_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_MODEL_PROVIDER_TYPE_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/model-providers/:type",
    });

    const matcher = getPathMatch(ZERO_MODEL_PROVIDER_TYPE_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_MODEL_PROVIDER_TYPE_PATH)).toStrictEqual({
      type: "anthropic-api-key",
    });
    for (const pathname of ZERO_MODEL_PROVIDER_TYPE_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only one segment for zero agent by-id rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_AGENT_BY_ID_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_AGENT_BY_ID_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/agents/:id",
    });

    const matcher = getPathMatch(ZERO_AGENT_BY_ID_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_AGENT_BY_ID_PATH)).toStrictEqual({
      id: "550e8400-e29b-41d4-a716-446655440000",
    });
    for (const pathname of ZERO_AGENT_BY_ID_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match the zero agents collection rewrite path exactly", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_AGENTS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_AGENTS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/agents",
    });

    const matcher = getPathMatch(ZERO_AGENTS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_AGENTS_PATH)).toStrictEqual({});
    for (const pathname of ZERO_AGENTS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only one segment for zero agent custom connector rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_AGENT_CUSTOM_CONNECTORS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_AGENT_CUSTOM_CONNECTORS_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/zero/agents/:id/custom-connectors",
    });

    const matcher = getPathMatch(ZERO_AGENT_CUSTOM_CONNECTORS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_AGENT_CUSTOM_CONNECTORS_PATH)).toStrictEqual({
      id: "550e8400-e29b-41d4-a716-446655440000",
    });
    for (const pathname of ZERO_AGENT_CUSTOM_CONNECTORS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only one segment for zero agent user connector rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_AGENT_USER_CONNECTORS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_AGENT_USER_CONNECTORS_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/zero/agents/:id/user-connectors",
    });

    const matcher = getPathMatch(ZERO_AGENT_USER_CONNECTORS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_AGENT_USER_CONNECTORS_PATH)).toStrictEqual({
      id: "550e8400-e29b-41d4-a716-446655440000",
    });
    for (const pathname of ZERO_AGENT_USER_CONNECTORS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match zero custom connectors root rewrites exactly", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_CUSTOM_CONNECTORS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_CUSTOM_CONNECTORS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/custom-connectors",
    });

    const matcher = getPathMatch(ZERO_CUSTOM_CONNECTORS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_CUSTOM_CONNECTORS_PATH)).toStrictEqual({});
    for (const pathname of ZERO_CUSTOM_CONNECTORS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only one segment for zero custom connector by-id rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_CUSTOM_CONNECTOR_BY_ID_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_CUSTOM_CONNECTOR_BY_ID_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/custom-connectors/:id",
    });

    const matcher = getPathMatch(ZERO_CUSTOM_CONNECTOR_BY_ID_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_CUSTOM_CONNECTOR_BY_ID_PATH)).toStrictEqual({
      id: "550e8400-e29b-41d4-a716-446655440000",
    });
    for (const pathname of ZERO_CUSTOM_CONNECTOR_BY_ID_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match zero custom connector secret rewrites exactly", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_CUSTOM_CONNECTOR_SECRET_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_CUSTOM_CONNECTOR_SECRET_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/zero/custom-connectors/:id/secret",
    });

    const matcher = getPathMatch(ZERO_CUSTOM_CONNECTOR_SECRET_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_CUSTOM_CONNECTOR_SECRET_PATH)).toStrictEqual({
      id: "550e8400-e29b-41d4-a716-446655440000",
    });
    for (const pathname of ZERO_CUSTOM_CONNECTOR_SECRET_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only one segment for zero agent instructions rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_AGENT_INSTRUCTIONS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_AGENT_INSTRUCTIONS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/agents/:id/instructions",
    });

    const matcher = getPathMatch(ZERO_AGENT_INSTRUCTIONS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_AGENT_INSTRUCTIONS_PATH)).toStrictEqual({
      id: "550e8400-e29b-41d4-a716-446655440000",
    });
    for (const pathname of ZERO_AGENT_INSTRUCTIONS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero org logo rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_ORG_LOGO_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_ORG_LOGO_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/org/logo",
    });

    const matcher = getPathMatch(ZERO_ORG_LOGO_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_ORG_LOGO_PATH)).toStrictEqual({});
    for (const pathname of ZERO_ORG_LOGO_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact voice-io tts rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === VOICE_IO_TTS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: VOICE_IO_TTS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/voice-io/tts",
    });

    const matcher = getPathMatch(VOICE_IO_TTS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(VOICE_IO_TTS_PATH)).toStrictEqual({});
    for (const pathname of VOICE_IO_TTS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only UUID-shaped voice-chat session detail rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === VOICE_CHAT_SESSION_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: VOICE_CHAT_SESSION_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/voice-chat/:id",
    });

    const matcher = getPathMatch(VOICE_CHAT_SESSION_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(VOICE_CHAT_SESSION_PATH)).toStrictEqual({
      id: VOICE_CHAT_SESSION_ID,
    });
    expect(matcher("/api/zero/voice-chat/token")).toBe(false);
    expect(matcher(`${VOICE_CHAT_SESSION_PATH}/tasks`)).toBe(false);
    expect(matcher(VOICE_CHAT_ITEM_APPEND_PATH)).toBe(false);
    expect(matcher(VOICE_CHAT_TRIGGER_REASONING_PATH)).toBe(false);
    expect(matcher("/api/zero/voice-chat/not-a-uuid")).toBe(false);
  });

  it("should match only the exact voice-chat token rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === VOICE_CHAT_TOKEN_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: VOICE_CHAT_TOKEN_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/voice-chat/token",
    });

    const matcher = getPathMatch(VOICE_CHAT_TOKEN_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(VOICE_CHAT_TOKEN_PATH)).toStrictEqual({});
    for (const pathname of VOICE_CHAT_TOKEN_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero realtime token rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === REALTIME_TOKEN_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: REALTIME_TOKEN_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/realtime/token",
    });

    const matcher = getPathMatch(REALTIME_TOKEN_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(REALTIME_TOKEN_PATH)).toStrictEqual({});
    for (const pathname of REALTIME_TOKEN_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact zero skills collection rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_SKILLS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_SKILLS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/skills",
    });

    const matcher = getPathMatch(ZERO_SKILLS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_SKILLS_PATH)).toStrictEqual({});
    for (const pathname of ZERO_SKILLS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the single-segment zero skills by-name rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ZERO_SKILLS_BY_NAME_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ZERO_SKILLS_BY_NAME_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/skills/:name",
    });

    const matcher = getPathMatch(ZERO_SKILLS_BY_NAME_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(ZERO_SKILLS_BY_NAME_PATH)).toStrictEqual({
      name: "my-skill",
    });
    for (const pathname of ZERO_SKILLS_BY_NAME_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only UUID-shaped voice-chat item append rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === VOICE_CHAT_ITEM_APPEND_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: VOICE_CHAT_ITEM_APPEND_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/voice-chat/:id/items",
    });

    const matcher = getPathMatch(VOICE_CHAT_ITEM_APPEND_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(VOICE_CHAT_ITEM_APPEND_PATH)).toStrictEqual({
      id: VOICE_CHAT_SESSION_ID,
    });
    for (const pathname of VOICE_CHAT_ITEM_APPEND_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only UUID-shaped voice-chat trigger-reasoning rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === VOICE_CHAT_TRIGGER_REASONING_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: VOICE_CHAT_TRIGGER_REASONING_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/zero/voice-chat/:id/trigger-reasoning",
    });

    const matcher = getPathMatch(VOICE_CHAT_TRIGGER_REASONING_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(VOICE_CHAT_TRIGGER_REASONING_PATH)).toStrictEqual({
      id: VOICE_CHAT_SESSION_ID,
    });
    for (const pathname of VOICE_CHAT_TRIGGER_REASONING_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for UUID-shaped voice-chat session detail paths", () => {
    expect(matchesApiBackendRewritePath(VOICE_CHAT_SESSION_PATH)).toBe(true);
    for (const pathname of VOICE_CHAT_SESSION_REWRITE_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact voice-chat token path", () => {
    expect(matchesApiBackendRewritePath(VOICE_CHAT_TOKEN_PATH)).toBe(true);
    for (const pathname of VOICE_CHAT_TOKEN_REWRITE_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for UUID-shaped voice-chat item append paths", () => {
    expect(matchesApiBackendRewritePath(VOICE_CHAT_ITEM_APPEND_PATH)).toBe(
      true,
    );
    for (const pathname of VOICE_CHAT_ITEM_APPEND_REWRITE_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match only UUID-shaped voice-chat task rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === VOICE_CHAT_TASKS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: VOICE_CHAT_TASKS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/voice-chat/:id/tasks",
    });

    const matcher = getPathMatch(VOICE_CHAT_TASKS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });

    expect(matcher(VOICE_CHAT_TASKS_PATH)).toStrictEqual({
      id: VOICE_CHAT_SESSION_ID,
    });
    for (const pathname of VOICE_CHAT_TASKS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for UUID-shaped voice-chat task paths", () => {
    expect(matchesApiBackendRewritePath(VOICE_CHAT_TASKS_PATH)).toBe(true);
    for (const pathname of VOICE_CHAT_TASKS_REWRITE_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for UUID-shaped voice-chat trigger-reasoning paths", () => {
    expect(
      matchesApiBackendRewritePath(VOICE_CHAT_TRIGGER_REASONING_PATH),
    ).toBe(true);
    for (const pathname of VOICE_CHAT_TRIGGER_REASONING_REWRITE_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact zero realtime token path", () => {
    expect(matchesApiBackendRewritePath(REALTIME_TOKEN_PATH)).toBe(true);
    for (const pathname of REALTIME_TOKEN_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match only the exact onboarding status rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ONBOARDING_STATUS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ONBOARDING_STATUS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/onboarding/status",
    });

    const matcher = getPathMatch(ONBOARDING_STATUS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });
    expect(matcher(ONBOARDING_STATUS_PATH)).toStrictEqual({});
    for (const pathname of ONBOARDING_STATUS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact onboarding status path", () => {
    expect(matchesApiBackendRewritePath(ONBOARDING_STATUS_PATH)).toBe(true);
    for (const pathname of ONBOARDING_STATUS_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match only the exact onboarding setup rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === ONBOARDING_SETUP_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: ONBOARDING_SETUP_REWRITE_SOURCE,
      destination: "https://api.example.test/api/zero/onboarding/setup",
    });

    const matcher = getPathMatch(ONBOARDING_SETUP_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });
    expect(matcher(ONBOARDING_SETUP_PATH)).toStrictEqual({});
    for (const pathname of ONBOARDING_SETUP_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact onboarding setup path", () => {
    expect(matchesApiBackendRewritePath(ONBOARDING_SETUP_PATH)).toBe(true);
    for (const pathname of ONBOARDING_SETUP_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for agent checkpoint detail paths", () => {
    expect(matchesApiBackendRewritePath(AGENT_CHECKPOINT_PATH)).toBe(true);
    for (const pathname of AGENT_CHECKPOINT_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact agent runs collection path", () => {
    expect(matchesApiBackendRewritePath(AGENT_RUNS_PATH)).toBe(true);
    for (const pathname of AGENT_RUNS_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact agent runs queue path", () => {
    expect(matchesApiBackendRewritePath(AGENT_RUNS_QUEUE_PATH)).toBe(true);
    for (const pathname of AGENT_RUNS_QUEUE_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for UUID-shaped agent run cancel paths", () => {
    expect(matchesApiBackendRewritePath(AGENT_RUN_CANCEL_PATH)).toBe(true);
    for (const pathname of AGENT_RUN_CANCEL_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for UUID-shaped agent run events paths", () => {
    expect(matchesApiBackendRewritePath(AGENT_RUN_EVENTS_PATH)).toBe(true);
    for (const pathname of AGENT_RUN_EVENTS_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact test OAuth provider echo path", () => {
    expect(matchesApiBackendRewritePath(TEST_OAUTH_PROVIDER_ECHO_PATH)).toBe(
      true,
    );
    for (const pathname of TEST_OAUTH_PROVIDER_ECHO_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact test OAuth provider authorize path", () => {
    expect(
      matchesApiBackendRewritePath(TEST_OAUTH_PROVIDER_AUTHORIZE_PATH),
    ).toBe(true);
    for (const pathname of TEST_OAUTH_PROVIDER_AUTHORIZE_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact test OAuth provider token path", () => {
    expect(matchesApiBackendRewritePath(TEST_OAUTH_PROVIDER_TOKEN_PATH)).toBe(
      true,
    );
    for (const pathname of TEST_OAUTH_PROVIDER_TOKEN_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact test OAuth provider userinfo path", () => {
    expect(
      matchesApiBackendRewritePath(TEST_OAUTH_PROVIDER_USERINFO_PATH),
    ).toBe(true);
    for (const pathname of TEST_OAUTH_PROVIDER_USERINFO_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for UUID-shaped agent run detail paths", () => {
    expect(matchesApiBackendRewritePath(AGENT_RUN_BY_ID_PATH)).toBe(true);
    for (const pathname of AGENT_RUN_BY_ID_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for UUID-shaped agent run telemetry paths", () => {
    expect(matchesApiBackendRewritePath(AGENT_RUN_TELEMETRY_PATH)).toBe(true);
    for (const pathname of AGENT_RUN_TELEMETRY_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for UUID-shaped agent run agent telemetry paths", () => {
    expect(matchesApiBackendRewritePath(AGENT_RUN_TELEMETRY_AGENT_PATH)).toBe(
      true,
    );
    for (const pathname of AGENT_RUN_TELEMETRY_AGENT_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for UUID-shaped agent run metrics telemetry paths", () => {
    expect(matchesApiBackendRewritePath(AGENT_RUN_TELEMETRY_METRICS_PATH)).toBe(
      true,
    );
    for (const pathname of AGENT_RUN_TELEMETRY_METRICS_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for UUID-shaped agent run network telemetry paths", () => {
    expect(matchesApiBackendRewritePath(AGENT_RUN_TELEMETRY_NETWORK_PATH)).toBe(
      true,
    );
    for (const pathname of AGENT_RUN_TELEMETRY_NETWORK_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for UUID-shaped agent run system log telemetry paths", () => {
    expect(
      matchesApiBackendRewritePath(AGENT_RUN_TELEMETRY_SYSTEM_LOG_PATH),
    ).toBe(true);
    for (const pathname of AGENT_RUN_TELEMETRY_SYSTEM_LOG_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact agent composes collection path", () => {
    expect(matchesApiBackendRewritePath(AGENT_COMPOSES_PATH)).toBe(true);
    for (const pathname of AGENT_COMPOSES_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for UUID-shaped agent composes instructions paths", () => {
    expect(matchesApiBackendRewritePath(AGENT_COMPOSES_INSTRUCTIONS_PATH)).toBe(
      true,
    );
    for (const pathname of AGENT_COMPOSES_INSTRUCTIONS_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for UUID-shaped agent compose by-id paths", () => {
    expect(matchesApiBackendRewritePath(AGENT_COMPOSES_BY_ID_PATH)).toBe(true);
    for (const pathname of AGENT_COMPOSES_BY_ID_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should not add a broad /api catch-all rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();

    expect(
      rewrites.some((rewrite) => {
        return rewrite.source === "/api/:path*";
      }),
    ).toBe(false);
  });

  it("should match only the exact telegram setup-status rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === TELEGRAM_SETUP_STATUS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: TELEGRAM_SETUP_STATUS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/telegram/setup-status",
    });

    const matcher = getPathMatch(TELEGRAM_SETUP_STATUS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });
    expect(matcher(TELEGRAM_SETUP_STATUS_PATH)).toStrictEqual({});
    for (const pathname of TELEGRAM_SETUP_STATUS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact telegram register rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === TELEGRAM_REGISTER_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: TELEGRAM_REGISTER_REWRITE_SOURCE,
      destination: "https://api.example.test/api/telegram/register",
    });

    const matcher = getPathMatch(TELEGRAM_REGISTER_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });
    expect(matcher(TELEGRAM_REGISTER_PATH)).toStrictEqual({});
    for (const pathname of TELEGRAM_REGISTER_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only single-segment telegram webhook rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === TELEGRAM_WEBHOOK_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: TELEGRAM_WEBHOOK_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/telegram/webhook/:telegramBotId",
    });

    const matcher = getPathMatch(TELEGRAM_WEBHOOK_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });
    expect(matcher(TELEGRAM_WEBHOOK_PATH)).toStrictEqual({
      telegramBotId: "123456789:telegram-bot-token",
    });
    for (const pathname of TELEGRAM_WEBHOOK_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact telegram integrations rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === TELEGRAM_INTEGRATIONS_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: TELEGRAM_INTEGRATIONS_REWRITE_SOURCE,
      destination: "https://api.example.test/api/integrations/telegram",
    });

    const matcher = getPathMatch(TELEGRAM_INTEGRATIONS_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });
    expect(matcher(TELEGRAM_INTEGRATIONS_PATH)).toStrictEqual({});
    for (const pathname of TELEGRAM_INTEGRATIONS_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact telegram link rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === TELEGRAM_LINK_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: TELEGRAM_LINK_REWRITE_SOURCE,
      destination: "https://api.example.test/api/integrations/telegram/link",
    });

    const matcher = getPathMatch(TELEGRAM_LINK_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });
    expect(matcher(TELEGRAM_LINK_PATH)).toStrictEqual({});
    for (const pathname of TELEGRAM_LINK_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only single-segment telegram bot rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === TELEGRAM_BOT_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: TELEGRAM_BOT_REWRITE_SOURCE,
      destination: "https://api.example.test/api/integrations/telegram/:botId",
    });

    const matcher = getPathMatch(TELEGRAM_BOT_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });
    expect(matcher(TELEGRAM_BOT_PATH)).toStrictEqual({
      botId: "123456789",
    });
    for (const pathname of TELEGRAM_BOT_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only single-segment telegram avatar rewrites", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === TELEGRAM_AVATAR_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: TELEGRAM_AVATAR_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/integrations/telegram/:botId/avatar",
    });

    const matcher = getPathMatch(TELEGRAM_AVATAR_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });
    expect(matcher(TELEGRAM_AVATAR_PATH)).toStrictEqual({
      botId: "123456789",
    });
    for (const pathname of TELEGRAM_AVATAR_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should match only the exact telegram auth callback rewrite", async () => {
    vi.stubEnv("VM0_API_BACKEND_URL", "https://api.example.test");

    const rewrites = await getBeforeFileRewrites();
    const rewrite = rewrites.find((entry) => {
      return entry.source === TELEGRAM_AUTH_CALLBACK_REWRITE_SOURCE;
    });
    expect(rewrite).toStrictEqual({
      source: TELEGRAM_AUTH_CALLBACK_REWRITE_SOURCE,
      destination:
        "https://api.example.test/api/integrations/telegram/auth-callback",
    });

    const matcher = getPathMatch(TELEGRAM_AUTH_CALLBACK_REWRITE_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });
    expect(matcher(TELEGRAM_AUTH_CALLBACK_PATH)).toStrictEqual({});
    for (const pathname of TELEGRAM_AUTH_CALLBACK_NEXT_NEGATIVE_PATHS) {
      expect(matcher(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact telegram register path", () => {
    expect(matchesApiBackendRewritePath(TELEGRAM_REGISTER_PATH)).toBe(true);
    for (const pathname of TELEGRAM_REGISTER_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact telegram setup-status path", () => {
    expect(matchesApiBackendRewritePath(TELEGRAM_SETUP_STATUS_PATH)).toBe(true);
    for (const pathname of TELEGRAM_SETUP_STATUS_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for single-segment telegram webhook paths", () => {
    expect(matchesApiBackendRewritePath(TELEGRAM_WEBHOOK_PATH)).toBe(true);
    for (const pathname of TELEGRAM_WEBHOOK_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact telegram integrations path", () => {
    expect(matchesApiBackendRewritePath(TELEGRAM_INTEGRATIONS_PATH)).toBe(true);
    for (const pathname of TELEGRAM_INTEGRATIONS_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact telegram link path", () => {
    expect(matchesApiBackendRewritePath(TELEGRAM_LINK_PATH)).toBe(true);
    for (const pathname of TELEGRAM_LINK_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for single-segment telegram bot paths", () => {
    expect(matchesApiBackendRewritePath(TELEGRAM_BOT_PATH)).toBe(true);
    for (const pathname of TELEGRAM_BOT_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for single-segment telegram avatar paths", () => {
    expect(matchesApiBackendRewritePath(TELEGRAM_AVATAR_PATH)).toBe(true);
    for (const pathname of TELEGRAM_AVATAR_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact telegram auth callback path", () => {
    expect(matchesApiBackendRewritePath(TELEGRAM_AUTH_CALLBACK_PATH)).toBe(
      true,
    );
    for (const pathname of TELEGRAM_AUTH_CALLBACK_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match the zero web download route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath("/api/zero/web/download-file")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/web/download-file/extra"),
    ).toBe(false);
  });

  it("should match the usage members route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath("/api/zero/usage/members")).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/usage/members/extra")).toBe(
      false,
    );
  });

  it("should match the zero org route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath(ZERO_ORG_PATH)).toBe(true);
    for (const pathname of ZERO_ORG_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match the zero chat search route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath(ZERO_CHAT_SEARCH_PATH)).toBe(true);
    for (const pathname of ZERO_CHAT_SEARCH_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match the zero chat messages route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath(ZERO_CHAT_MESSAGES_PATH)).toBe(true);
    for (const pathname of ZERO_CHAT_MESSAGES_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match the zero integrations chat message route for middleware pass-through", async () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/chat/message"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/chat/message/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/integrations/chat")).toBe(
      false,
    );
  });

  it("should match the zero integrations Slack message route for middleware pass-through", async () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/slack/message"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/slack/message/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/slack/messages"),
    ).toBe(false);
  });

  it("should match the zero integrations Slack status route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath("/api/zero/integrations/slack")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/slack/extra"),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/zero/integrations/slacks")).toBe(
      false,
    );
  });

  it("should match the zero integrations Slack connect route for middleware pass-through", async () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/slack/connect"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/slack/connect/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/slack/connects"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/slack/connected"),
    ).toBe(false);
  });

  it("should match the zero integrations Telegram message route for middleware pass-through", async () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/telegram/message"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/telegram/message/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/telegram"),
    ).toBe(false);
  });

  it("should match the zero integrations Telegram bots route for middleware pass-through", async () => {
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/telegram/bots"),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/telegram/bots/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/telegram"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/telegram/bot"),
    ).toBe(false);
  });

  it("should match the zero integrations Telegram download-file route for middleware pass-through", async () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/telegram/download-file",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/telegram/download-file/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/telegram/download"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/telegram"),
    ).toBe(false);
  });

  it("should match the zero integrations Slack download-file route for middleware pass-through", async () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/slack/download-file",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/slack/download-file/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/slack/download"),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/slack/downloaded"),
    ).toBe(false);
  });

  it("should match the zero integrations Telegram upload init route for middleware pass-through", async () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/telegram/upload-file/init",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/telegram/upload-file/init/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/telegram/upload-file",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/telegram"),
    ).toBe(false);
  });

  it("should match the zero integrations Telegram upload complete route for middleware pass-through", async () => {
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/telegram/upload-file/complete",
      ),
    ).toBe(true);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/telegram/upload-file/complete/extra",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath(
        "/api/zero/integrations/telegram/upload-file",
      ),
    ).toBe(false);
    expect(
      matchesApiBackendRewritePath("/api/zero/integrations/telegram"),
    ).toBe(false);
  });

  it("should match the zero composes route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath(ZERO_COMPOSES_PATH)).toBe(true);
    for (const pathname of ZERO_COMPOSES_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match the zero composes list route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath(ZERO_COMPOSES_LIST_PATH)).toBe(true);
    for (const pathname of ZERO_COMPOSES_LIST_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match the zero composes by-id route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath(ZERO_COMPOSES_BY_ID_PATH)).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/composes/not-a-uuid")).toBe(
      true,
    );
    expect(matchesApiBackendRewritePath("/api/zero/composes/metadata")).toBe(
      true,
    );
    for (const pathname of ZERO_COMPOSES_BY_ID_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match the zero composes metadata route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath(ZERO_COMPOSES_METADATA_PATH)).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath("/api/zero/composes/not-a-uuid/metadata"),
    ).toBe(true);
    for (const pathname of ZERO_COMPOSES_METADATA_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match the zero computer-use host route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath(ZERO_COMPUTER_USE_HOST_PATH)).toBe(
      true,
    );
    for (const pathname of ZERO_COMPUTER_USE_HOST_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match the zero computer-use register route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath(ZERO_COMPUTER_USE_REGISTER_PATH)).toBe(
      true,
    );
    for (const pathname of ZERO_COMPUTER_USE_REGISTER_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match the zero computer-use unregister route for middleware pass-through", async () => {
    expect(
      matchesApiBackendRewritePath(ZERO_COMPUTER_USE_UNREGISTER_PATH),
    ).toBe(true);
    for (const pathname of ZERO_COMPUTER_USE_UNREGISTER_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match the zero insights range route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath(ZERO_INSIGHTS_RANGE_PATH)).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/insights/range/extra")).toBe(
      false,
    );
  });

  it("should match the zero insights route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath(ZERO_INSIGHTS_PATH)).toBe(true);
    expect(matchesApiBackendRewritePath("/api/zero/insights/extra")).toBe(
      false,
    );
  });

  it("should match the v1 chat thread send route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath(V1_CHAT_THREADS_MESSAGES_PATH)).toBe(
      true,
    );
    for (const pathname of V1_CHAT_THREADS_MESSAGES_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match the v1 chat thread detail route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath(V1_CHAT_THREAD_DETAIL_PATH)).toBe(true);
    expect(
      matchesApiBackendRewritePath(V1_CHAT_THREAD_DETAIL_INVALID_UUID_PATH),
    ).toBe(true);
    expect(matchesApiBackendRewritePath("/api/v1/chat-threads/messages")).toBe(
      true,
    );
    expect(matchesApiBackendRewritePath("/api/v1/chat-threads")).toBe(false);
  });

  it("should match the v1 chat thread messages route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath(V1_CHAT_THREAD_MESSAGES_PATH)).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath(V1_CHAT_THREAD_MESSAGES_INVALID_UUID_PATH),
    ).toBe(true);
    expect(matchesApiBackendRewritePath("/api/v1/chat-threads/messages")).toBe(
      true,
    );
    expect(
      matchesApiBackendRewritePath(
        "/api/v1/chat-threads/550e8400-e29b-41d4-a716-446655440000/messages/extra",
      ),
    ).toBe(false);
    expect(matchesApiBackendRewritePath("/api/v1/chat-threads")).toBe(false);
  });

  it("should match the zero chat threads collection route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath(ZERO_CHAT_THREADS_PATH)).toBe(true);
    for (const pathname of ZERO_CHAT_THREADS_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match the zero chat thread artifacts route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath(ZERO_CHAT_THREAD_ARTIFACTS_PATH)).toBe(
      true,
    );
    for (const pathname of ZERO_CHAT_THREAD_ARTIFACTS_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match the zero chat thread detail route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath(ZERO_CHAT_THREAD_DETAIL_PATH)).toBe(
      true,
    );
    for (const pathname of ZERO_CHAT_THREAD_DETAIL_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match the zero org list route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath(ZERO_ORG_LIST_PATH)).toBe(true);
    for (const pathname of ZERO_ORG_LIST_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match the zero org domains route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath(ZERO_ORG_DOMAINS_PATH)).toBe(true);
    for (const pathname of ZERO_ORG_DOMAINS_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match the zero member credit cap route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath(ZERO_MEMBER_CREDIT_CAP_PATH)).toBe(
      true,
    );
    for (const pathname of ZERO_MEMBER_CREDIT_CAP_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match the zero org members route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath(ZERO_ORG_MEMBERS_PATH)).toBe(true);
    for (const pathname of ZERO_ORG_MEMBERS_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match the zero org membership requests route for middleware pass-through", async () => {
    expect(
      matchesApiBackendRewritePath(ZERO_ORG_MEMBERSHIP_REQUESTS_PATH),
    ).toBe(true);
    for (const pathname of ZERO_ORG_MEMBERSHIP_REQUESTS_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match the zero org invite route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath(ZERO_ORG_INVITE_PATH)).toBe(true);
    for (const pathname of ZERO_ORG_INVITE_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match the zero org leave route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath(ZERO_ORG_LEAVE_PATH)).toBe(true);
    for (const pathname of ZERO_ORG_LEAVE_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match the zero org logo route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath(ZERO_ORG_LOGO_PATH)).toBe(true);
    for (const pathname of ZERO_ORG_LOGO_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match the zero secrets route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath(ZERO_SECRETS_PATH)).toBe(true);
    expect(matchesApiBackendRewritePath(ZERO_SECRETS_BY_NAME_PATH)).toBe(true);
    for (const pathname of ZERO_SECRETS_BY_NAME_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for zero schedules disable paths", () => {
    expect(matchesApiBackendRewritePath(ZERO_SCHEDULES_DISABLE_PATH)).toBe(
      true,
    );
    for (const pathname of ZERO_SCHEDULES_DISABLE_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for zero schedules collection paths", () => {
    expect(matchesApiBackendRewritePath(ZERO_SCHEDULES_PATH)).toBe(true);
    for (const pathname of ZERO_SCHEDULES_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for zero runs collection paths", () => {
    expect(matchesApiBackendRewritePath(ZERO_RUNS_PATH)).toBe(true);
    for (const pathname of ZERO_RUNS_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for zero runs queue paths", () => {
    expect(matchesApiBackendRewritePath(ZERO_RUNS_QUEUE_PATH)).toBe(true);
    for (const pathname of ZERO_RUNS_QUEUE_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for UUID-shaped zero runs by-id paths", () => {
    expect(matchesApiBackendRewritePath(ZERO_RUNS_BY_ID_PATH)).toBe(true);
    for (const pathname of ZERO_RUNS_BY_ID_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for UUID-shaped zero runs runner paths", () => {
    expect(matchesApiBackendRewritePath(ZERO_RUNS_RUNNER_PATH)).toBe(true);
    for (const pathname of ZERO_RUNS_RUNNER_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for UUID-shaped zero runs agent events paths", () => {
    expect(matchesApiBackendRewritePath(ZERO_RUNS_AGENT_EVENTS_PATH)).toBe(
      true,
    );
    for (const pathname of ZERO_RUNS_AGENT_EVENTS_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for UUID-shaped zero runs cancel paths", () => {
    expect(matchesApiBackendRewritePath(ZERO_RUNS_CANCEL_PATH)).toBe(true);
    for (const pathname of ZERO_RUNS_CANCEL_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for UUID-shaped zero runs context paths", () => {
    expect(matchesApiBackendRewritePath(ZERO_RUNS_CONTEXT_PATH)).toBe(true);
    for (const pathname of ZERO_RUNS_CONTEXT_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for UUID-shaped zero runs network paths", () => {
    expect(matchesApiBackendRewritePath(ZERO_RUNS_NETWORK_PATH)).toBe(true);
    for (const pathname of ZERO_RUNS_NETWORK_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for zero schedules run paths", () => {
    expect(matchesApiBackendRewritePath(ZERO_SCHEDULES_RUN_PATH)).toBe(true);
    for (const pathname of ZERO_SCHEDULES_RUN_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for zero schedules by-name paths", () => {
    expect(matchesApiBackendRewritePath(ZERO_SCHEDULES_BY_NAME_PATH)).toBe(
      true,
    );
    for (const pathname of ZERO_SCHEDULES_BY_NAME_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for zero schedules enable paths", () => {
    expect(matchesApiBackendRewritePath(ZERO_SCHEDULES_ENABLE_PATH)).toBe(true);
    for (const pathname of ZERO_SCHEDULES_ENABLE_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact zero api keys path", () => {
    expect(matchesApiBackendRewritePath(ZERO_API_KEYS_PATH)).toBe(true);
    for (const pathname of ZERO_API_KEYS_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for UUID-shaped zero api key by-id paths", () => {
    expect(matchesApiBackendRewritePath(ZERO_API_KEY_BY_ID_PATH)).toBe(true);
    for (const pathname of ZERO_API_KEY_BY_ID_PROXY_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact zero billing status path", () => {
    expect(matchesApiBackendRewritePath(ZERO_BILLING_STATUS_PATH)).toBe(true);
    for (const pathname of ZERO_BILLING_STATUS_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact zero billing auto-recharge path", () => {
    expect(matchesApiBackendRewritePath(ZERO_BILLING_AUTO_RECHARGE_PATH)).toBe(
      true,
    );
    for (const pathname of ZERO_BILLING_AUTO_RECHARGE_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact zero billing checkout path", () => {
    expect(matchesApiBackendRewritePath(ZERO_BILLING_CHECKOUT_PATH)).toBe(true);
    for (const pathname of ZERO_BILLING_CHECKOUT_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact zero billing downgrade path", () => {
    expect(matchesApiBackendRewritePath(ZERO_BILLING_DOWNGRADE_PATH)).toBe(
      true,
    );
    for (const pathname of ZERO_BILLING_DOWNGRADE_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact zero billing invoices path", () => {
    expect(matchesApiBackendRewritePath(ZERO_BILLING_INVOICES_PATH)).toBe(true);
    for (const pathname of ZERO_BILLING_INVOICES_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact zero billing portal path", () => {
    expect(matchesApiBackendRewritePath(ZERO_BILLING_PORTAL_PATH)).toBe(true);
    for (const pathname of ZERO_BILLING_PORTAL_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact zero default-agent path", () => {
    expect(matchesApiBackendRewritePath(ZERO_DEFAULT_AGENT_PATH)).toBe(true);
    for (const pathname of ZERO_DEFAULT_AGENT_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact zero developer-support path", () => {
    expect(matchesApiBackendRewritePath(ZERO_DEVELOPER_SUPPORT_PATH)).toBe(
      true,
    );
    for (const pathname of ZERO_DEVELOPER_SUPPORT_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the single-segment zero billing redeem path", () => {
    expect(matchesApiBackendRewritePath(ZERO_BILLING_REDEEM_PATH)).toBe(true);
    for (const pathname of ZERO_BILLING_REDEEM_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact runners heartbeat path", () => {
    expect(matchesApiBackendRewritePath(RUNNERS_HEARTBEAT_PATH)).toBe(true);
    for (const pathname of RUNNERS_HEARTBEAT_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the single-segment runners job claim path", () => {
    expect(matchesApiBackendRewritePath(RUNNERS_JOB_CLAIM_PATH)).toBe(true);
    for (const pathname of RUNNERS_JOB_CLAIM_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact runners poll path", () => {
    expect(matchesApiBackendRewritePath(RUNNERS_POLL_PATH)).toBe(true);
    for (const pathname of RUNNERS_POLL_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact runners realtime token path", () => {
    expect(matchesApiBackendRewritePath(RUNNERS_REALTIME_TOKEN_PATH)).toBe(
      true,
    );
    for (const pathname of RUNNERS_REALTIME_TOKEN_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should bypass web middleware only for the exact zero model providers path", () => {
    expect(matchesApiBackendRewritePath(ZERO_MODEL_PROVIDERS_PATH)).toBe(true);
    for (const pathname of ZERO_MODEL_PROVIDERS_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match the variables routes for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath(ZERO_VARIABLES_PATH)).toBe(true);
    for (const pathname of ZERO_VARIABLES_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }

    expect(matchesApiBackendRewritePath(ZERO_VARIABLE_BY_NAME_PATH)).toBe(true);
    for (const pathname of ZERO_VARIABLE_BY_NAME_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });

  it("should match the permission policies route for middleware pass-through", async () => {
    expect(matchesApiBackendRewritePath(PERMISSION_POLICIES_PATH)).toBe(true);
    for (const pathname of PERMISSION_POLICIES_NEXT_NEGATIVE_PATHS) {
      expect(matchesApiBackendRewritePath(pathname)).toBe(false);
    }
  });
});
