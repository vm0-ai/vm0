import { command, type Command } from "ccstate";
import { setupClerk$ } from "./auth.ts";
import { setRootSignal$ } from "./root-signal.ts";
import {
  initRoutes$,
  navigateInReact$,
  setupAuthPageWrapper,
  setupPageWrapper,
} from "./route.ts";
import { setupHomePage$ } from "./home/home-page.ts";
import { setupLogsPage$ } from "./logs-page/logs-page.ts";
import { setupLogDetailPage$ } from "./logs-page/log-detail-page.ts";
import { setupSettingsPage$ } from "./settings-page/settings-page.ts";
import { setupPreferencesPage$ } from "./preferences-page/preferences-page.ts";
import { setupAgentsPage$ } from "./agents-page/agents-page.ts";
import { setupAgentDetailPage$ } from "./agent-detail/agent-detail-page.ts";
import { setupAgentLogsPage$ } from "./agent-detail/agent-logs-page.ts";
import { setupAgentLogDetailPage$ } from "./agent-detail/agent-log-detail-page.ts";
import { setupAgentConnectionsPage$ } from "./agent-detail/agent-connections-page.ts";
import { hasScope$ } from "./scope.ts";
import { logger } from "./log.ts";
import { setupGlobalMethod$ } from "./bootstrap/global-method.ts";
import { setupLoggers$ } from "./bootstrap/loggers.ts";
import { setupPlaygroundPage$ } from "./playground-page/playground-page.ts";
import { setupEnvironmentVariablesSetupPage$ } from "./environment-variables-setup/setup-page.ts";
import { setupSlackSettingsPage$ } from "./integrations-page/slack-settings-page.ts";
import { setupGitHubSettingsPage$ } from "./integrations-page/github-settings-page.ts";
import { setupProviderSetupPage$ } from "./provider-setup/provider-setup-page.ts";
import { setupSlackConnectPage$ } from "./slack-connect/slack-connect-page.ts";
import { setupSlackConnectSuccessPage$ } from "./slack-connect/slack-connect-success-page.ts";
import { setupZeroPage$ } from "./zero-page/zero-page.ts";
import { setupSelectOrgPage$ } from "./select-org/select-org-page.ts";
import { setupTelegramSettingsPage$ } from "./integrations-page/telegram-settings-page.ts";
import { setupTelegramConnectPage$ } from "./telegram-connect/telegram-connect-page.ts";
import { setupTelegramConnectSuccessPage$ } from "./telegram-connect/telegram-connect-success-page.ts";

const L = logger("Bootstrap");

const ROUTE_CONFIG = [
  {
    path: "/",
    setup: setupAuthPageWrapper(setupHomePage$),
  },
  {
    path: "/select-org",
    setup: setupAuthPageWrapper(setupSelectOrgPage$),
  },
  {
    path: "/zero/chat/:sessionId",
    setup: setupAuthPageWrapper(setupZeroPage$),
  },
  {
    path: "/zero/:tab/:sub",
    setup: setupAuthPageWrapper(setupZeroPage$),
  },
  {
    path: "/zero/:tab",
    setup: setupAuthPageWrapper(setupZeroPage$),
  },
  {
    path: "/zero",
    setup: setupAuthPageWrapper(setupZeroPage$),
  },
  {
    path: "/logs",
    setup: setupScopeRequiredPageWrapper(setupLogsPage$),
  },
  {
    path: "/logs/:id",
    setup: setupScopeRequiredPageWrapper(setupLogDetailPage$),
  },
  {
    path: "/settings",
    setup: setupScopeRequiredPageWrapper(setupSettingsPage$),
  },
  {
    path: "/preferences",
    setup: setupAuthPageWrapper(setupPreferencesPage$),
  },
  {
    path: "/agents/:name/logs/:id",
    setup: setupScopeRequiredPageWrapper(setupAgentLogDetailPage$),
  },
  {
    path: "/agents/:name/logs",
    setup: setupScopeRequiredPageWrapper(setupAgentLogsPage$),
  },
  {
    path: "/agents/:name/connections",
    setup: setupScopeRequiredPageWrapper(setupAgentConnectionsPage$),
  },
  {
    path: "/agents/:name",
    setup: setupScopeRequiredPageWrapper(setupAgentDetailPage$),
  },
  {
    path: "/agents",
    setup: setupAuthPageWrapper(setupAgentsPage$),
  },
  {
    path: "/settings/slack",
    setup: setupScopeRequiredPageWrapper(setupSlackSettingsPage$),
  },
  {
    path: "/settings/github",
    setup: setupScopeRequiredPageWrapper(setupGitHubSettingsPage$),
  },
  {
    path: "/environment-variables-setup",
    setup: setupScopeRequiredPageWrapper(setupEnvironmentVariablesSetupPage$),
  },
  {
    path: "/provider-setup",
    setup: setupAuthPageWrapper(setupProviderSetupPage$),
  },
  {
    path: "/slack/connect",
    setup: setupAuthPageWrapper(setupSlackConnectPage$),
  },
  {
    path: "/slack/connect/success",
    setup: setupAuthPageWrapper(setupSlackConnectSuccessPage$),
  },
  {
    path: "/settings/telegram",
    setup: setupScopeRequiredPageWrapper(setupTelegramSettingsPage$),
  },
  {
    path: "/telegram/connect",
    setup: setupAuthPageWrapper(setupTelegramConnectPage$),
  },
  {
    path: "/telegram/connect/success",
    setup: setupAuthPageWrapper(setupTelegramConnectSuccessPage$),
  },
  {
    path: "/_playground",
    setup: setupPageWrapper(setupPlaygroundPage$),
  },
] as const;

const setupRoutes$ = command(async ({ set }, signal: AbortSignal) => {
  await set(initRoutes$, ROUTE_CONFIG, signal);
});

export const bootstrap$ = command(
  async ({ set }, render: () => void, signal: AbortSignal) => {
    set(setRootSignal$, signal);

    set(setupLoggers$);

    render();

    await Promise.all([
      set(setupGlobalMethod$, signal),
      set(setupClerk$, signal),
      set(setupRoutes$, signal),
    ]);
    signal.throwIfAborted();
  },
);

function setupScopeRequiredPageWrapper(
  fn: Command<Promise<void> | void, [AbortSignal]>,
) {
  return setupAuthPageWrapper(
    command(async ({ get, set }, signal: AbortSignal) => {
      L.debug("enter setupScopeRequiredPageWrapper");

      // First, immediately render the page to provide instant visual feedback
      // The page components will show loading skeletons while data fetches
      await set(fn, signal);
      signal.throwIfAborted();

      // Then check scope in background (after page is already displayed)
      const scopeExists = await get(hasScope$);
      signal.throwIfAborted();
      L.debug("scopeExists", scopeExists);

      if (!scopeExists) {
        L.debug("redirect to homepage because scope does not exist");
        set(navigateInReact$, "/");
        return;
      }
    }),
  );
}
