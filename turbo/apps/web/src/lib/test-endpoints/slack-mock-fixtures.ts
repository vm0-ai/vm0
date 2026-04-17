/**
 * Canned Slack Web API fixture identifiers used by the e2e Slack mock
 * routes under `/api/test/slack-mock/*` and by the BATS helpers in
 * `e2e/helpers/slack.bash`.
 *
 * Keep this file the single source of truth so the two cannot drift.
 * BATS sources its copy from `e2e/helpers/slack-fixtures.sh`, which
 * mirrors these values.
 */
export const SLACK_E2E_FIXTURES = {
  /** Bot user in the E2E mock workspace. Matches Slack's `Uxxxxx` shape. */
  botUserId: "U_E2E_BOT",
  /** Default real-user stand-in for `users.info` lookups. */
  userUserId: "U_E2E_USER",
  /** Mock bot ID returned by `auth.test`. */
  botId: "B_E2E_BOT",
  /** Workspace / team ID used throughout the mock suite. */
  teamId: "T_E2E",
  /** Slack app ID for the mock install. */
  appId: "A_E2E_APP",
  /** Default channel ID used by BATS slash-command invocations. */
  channelId: "C_E2E_MOCK",
  /** Opaque bot token returned by the mock oauth exchange. */
  botToken: "xoxb-e2e-test-bot-token",
  /** Team / workspace display name. */
  teamName: "E2E Test Team",
} as const;

export const SLACK_E2E_SCOPES = [
  "app_mentions:read",
  "channels:read",
  "chat:write",
  "chat:write.public",
  "commands",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "users:read",
  "users:read.email",
] as const;
