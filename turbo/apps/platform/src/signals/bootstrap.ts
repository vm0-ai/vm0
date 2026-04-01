import { command } from "ccstate";
import { setupClerk$ } from "./auth.ts";
import { setRootSignal$ } from "./root-signal.ts";
import {
  initRoutes$,
  detachedNavigateTo$,
  setupAuthPageWrapper,
} from "./route.ts";
import { setupGlobalMethod$ } from "./bootstrap/global-method.ts";
import { setupLoggers$ } from "./bootstrap/loggers.ts";
import { setupSelectOrgPage$ } from "./select-org/select-org-page.ts";
import { setupSlackConnectPage$ } from "./zero-page/slack-connect-page.ts";
import { setupQueuePage$ } from "./queue-page/queue-page-setup.ts";
import { setupActivityPage$ } from "./activity-page/activity-page-setup.ts";
import { setupActivityDetailPage$ } from "./activity-page/activity-detail-page-setup.ts";
import { setupActivityContextPage$ } from "./activity-page/activity-context-page-setup.ts";
import { setupActivityNetworkPage$ } from "./activity-page/activity-network-page-setup.ts";
import { setupTeamPage$ } from "./team-page/team-page-setup.ts";
import { setupTeamDetailPage$ } from "./team-page/team-detail-page-setup.ts";
import { setupWorksPage$ } from "./works-page/works-page-setup.ts";
import { setupPreferencesPage$ } from "./preferences-page/preferences-page-setup.ts";
import { setupSchedulePage$ } from "./schedule-page/schedule-page-setup.ts";
import { setupScheduleDetailPage$ } from "./schedule-page/schedule-detail-page-setup.ts";
import { setupTalkPage$ } from "./zero-page/talk-page-setup.ts";
import { setupHomePage$ } from "./zero-page/home-page-setup.ts";
import { setupUsagePage$ } from "./usage-page/usage-page-setup.ts";
import { setupChatSessionPage$ } from "./zero-page/chat-session-page-setup.ts";
import { setupInternalConnectorLogos$ } from "./internal-connector-logos-setup.ts";
import { setupOnboardingPage$ } from "./onboarding-page/onboarding-page-setup.ts";
import { setupIdeationPage$ } from "./zero-page/ideation-page-setup.ts";
import { setupConnectorsPage$ } from "./connectors-page/connectors-page-setup.ts";
import { setupSignInTokenPage$ } from "./sign-in-token-setup.ts";
import { setupFirewallAllowPage$ } from "./firewall-allow/firewall-allow-page-setup.ts";

/**
 * Catch-all fallback — redirects unknown paths to /.
 * Intentionally not wrapped with setupAuthPageWrapper: the / route
 * already enforces auth, so wrapping here would add an unnecessary
 * sign-in round-trip before the redirect.
 */
const setupNotFoundRedirect$ = command(({ set }) => {
  set(detachedNavigateTo$, "/");
});

const ROUTE_CONFIG = [
  {
    path: "/select-org",
    setup: setupAuthPageWrapper(setupSelectOrgPage$),
  },
  {
    path: "/chat/:chatThreadId",
    setup: setupAuthPageWrapper(setupChatSessionPage$),
  },
  {
    path: "/ideas",
    setup: setupAuthPageWrapper(setupIdeationPage$),
  },
  {
    path: "/connectors",
    setup: setupAuthPageWrapper(setupConnectorsPage$),
  },
  {
    path: "/talk/:agentId/ideas",
    setup: setupAuthPageWrapper(setupIdeationPage$),
  },
  {
    path: "/talk/:agentId",
    setup: setupAuthPageWrapper(setupTalkPage$),
  },
  {
    path: "/team/:agentId",
    setup: setupAuthPageWrapper(setupTeamDetailPage$),
  },
  {
    path: "/team",
    setup: setupAuthPageWrapper(setupTeamPage$),
  },
  {
    path: "/slack/connect",
    setup: setupAuthPageWrapper(setupSlackConnectPage$),
  },
  {
    path: "/queue",
    setup: setupAuthPageWrapper(setupQueuePage$),
  },
  {
    path: "/activity/:runId/network",
    setup: setupAuthPageWrapper(setupActivityNetworkPage$),
  },
  {
    path: "/activity/:runId/context",
    setup: setupAuthPageWrapper(setupActivityContextPage$),
  },
  {
    path: "/activity/:runId",
    setup: setupAuthPageWrapper(setupActivityDetailPage$),
  },
  {
    path: "/activity",
    setup: setupAuthPageWrapper(setupActivityPage$),
  },
  {
    path: "/works",
    setup: setupAuthPageWrapper(setupWorksPage$),
  },
  {
    path: "/preferences",
    setup: setupAuthPageWrapper(setupPreferencesPage$),
  },
  {
    path: "/schedule/:scheduleId",
    setup: setupAuthPageWrapper(setupScheduleDetailPage$),
  },
  {
    path: "/schedule",
    setup: setupAuthPageWrapper(setupSchedulePage$),
  },
  {
    path: "/usage",
    setup: setupAuthPageWrapper(setupUsagePage$),
  },
  {
    path: "/firewall-allow/:agentId",
    setup: setupAuthPageWrapper(setupFirewallAllowPage$),
  },
  {
    path: "/onboarding",
    setup: setupAuthPageWrapper(setupOnboardingPage$),
  },
  {
    path: "/sign-in-token",
    setup: setupSignInTokenPage$,
  },
  {
    path: "/__internal-connector-logos",
    setup: setupInternalConnectorLogos$,
  },
  {
    path: "/",
    setup: setupAuthPageWrapper(setupHomePage$),
  },
  {
    // Catch-all: redirect unknown paths to /
    path: "{/*path}",
    setup: setupNotFoundRedirect$,
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
