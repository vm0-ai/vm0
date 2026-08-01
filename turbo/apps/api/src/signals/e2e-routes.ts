import type { RouteEntry } from "./route-entry";
import { cliAuthTestRoutes } from "./routes/cli-auth-test";
import { testAgentComposesRoutes } from "./routes/test-agent-composes";
import { testAgentRunsRoutes } from "./routes/test-agent-runs";
import { testOAuthProviderAuthorizeRoutes } from "./routes/test-oauth-provider-authorize";
import { testOAuthProviderDeviceAuthRoutes } from "./routes/test-oauth-provider-device-auth";
import { testOAuthProviderEchoRoutes } from "./routes/test-oauth-provider-echo";
import { testOAuthProviderTokenRoutes } from "./routes/test-oauth-provider-token";
import { testOAuthProviderUserinfoRoutes } from "./routes/test-oauth-provider-userinfo";
import { testSlackMockRoutes } from "./routes/test-slack-mock";
import { testSlackStateRoutes } from "./routes/test-slack-state";
import { testStorageFixtureRoutes } from "./routes/test-storage-fixture";
import { testTelegramMockRoutes } from "./routes/test-telegram-mock";
import { testTelegramStateRoutes } from "./routes/test-telegram-state";
import { testTeamsDispatchProbeRoutes } from "./routes/test-teams-dispatch-probe";
import { testTeamsMockRoutes } from "./routes/test-teams-mock";
import { testTeamsStateRoutes } from "./routes/test-teams-state";
import { testZeroAgentStateRoutes } from "./routes/test-zero-agent-state";

/**
 * Deployed end-to-end infrastructure routes.
 *
 * These endpoints exist for the CLI E2E and Playwright suites that run against
 * deployed preview environments, where in-process mocking (MSW) is impossible:
 *
 * - `cli-auth-test`: E2E account/token/connector provisioning used by the
 *   deploy workflow (`Generate E2E test tokens`) and `e2e/` suites.
 * - `test-agent-runs`: direct run creation used by the runner E2E suite after
 *   the public agent run creation endpoint was retired.
 * - `test-agent-composes`: compose creation and name lookup used by the runner
 *   E2E suite after the public agent compose endpoints were retired.
 * - `test-oauth-provider-*`: the synthetic OAuth provider backing the
 *   `test-oauth`/`test-oauth-device` connectors in `packages/connectors`.
 * - `test-slack-mock` / `test-telegram-mock` / `test-teams-mock`: provider
 *   stand-ins that integration API traffic is redirected to on previews via
 *   `E2E_SLACK_MOCK_ENABLED` / `E2E_TELEGRAM_MOCK_ENABLED` /
 *   `E2E_TEAMS_MOCK_ENABLED`.
 * - state routes and the Teams dispatch probe: fixture seeding and provider
 *   ingress used by `e2e/helpers/slack.bash`, `e2e/helpers/telegram.bash`,
 *   and `e2e/helpers/teams.bash`.
 *
 * Every route here is gated by `isTestEndpointAllowed` (development or
 * preview-with-bypass only) and returns 404 in production.
 *
 * API integration tests (vitest) must NOT use these routes: construct state
 * through real production APIs, mock external providers with MSW, and assert
 * through product read surfaces instead.
 */
export const E2E_ROUTES: readonly RouteEntry[] = [
  ...cliAuthTestRoutes,
  ...testAgentComposesRoutes,
  ...testAgentRunsRoutes,
  ...testOAuthProviderAuthorizeRoutes,
  ...testOAuthProviderDeviceAuthRoutes,
  ...testOAuthProviderEchoRoutes,
  ...testOAuthProviderTokenRoutes,
  ...testOAuthProviderUserinfoRoutes,
  ...testSlackMockRoutes,
  ...testSlackStateRoutes,
  ...testStorageFixtureRoutes,
  ...testTelegramMockRoutes,
  ...testTelegramStateRoutes,
  ...testTeamsDispatchProbeRoutes,
  ...testTeamsMockRoutes,
  ...testTeamsStateRoutes,
  ...testZeroAgentStateRoutes,
];
