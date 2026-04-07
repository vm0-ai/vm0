import { command } from "ccstate";
import { setupClerk$ } from "./auth.ts";
import { setRootSignal$ } from "./root-signal.ts";
import {
  initRoutes$,
  detachedNavigateTo$,
  setupAuthPageWrapper,
  pathParams$,
} from "./route.ts";
import { ROUTES, type RoutePath } from "./route-paths.ts";

import { setupGlobalMethod$ } from "./bootstrap/global-method.ts";
import { setupLoggers$ } from "./bootstrap/loggers.ts";
import { setupSelectOrgPage$ } from "./select-org/select-org-page.ts";
import { setupSlackConnectPage$ } from "./zero-page/slack-connect-page.ts";
import { setupQueuePage$ } from "./queue-page/queue-page-setup.ts";
import { setupActivityPage$ } from "./activity-page/activity-page-setup.ts";
import { setupActivityDetailPage$ } from "./activity-page/activity-detail-page-setup.ts";
import { setupActivityInspectPage$ } from "./activity-page/activity-inspect-page-setup.ts";
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
import { setupDirectedConnectPage$ } from "./connectors-page/directed-connect-page-setup.ts";
import { setupDirectedAuthorizePage$ } from "./connectors-page/directed-authorize-page-setup.ts";
import { setupSignInTokenPage$ } from "./sign-in-token-setup.ts";
import { setupFirewallAllowPage$ } from "./firewall-allow/firewall-allow-page-setup.ts";
import { setupChatListPage$ } from "./zero-page/chat-list-page-setup.ts";
import { setupLabPage$ } from "./lab-page/lab-page-setup.ts";
import { setupNetworkInsightsPage$ } from "./network-insights/network-insights-page-setup.ts";

/**
 * Catch-all fallback — redirects unknown paths to /.
 * Intentionally not wrapped with setupAuthPageWrapper: the / route
 * already enforces auth, so wrapping here would add an unnecessary
 * sign-in round-trip before the redirect.
 */
const setupNotFoundRedirect$ = command(({ set }) => {
  set(detachedNavigateTo$, "/");
});

/**
 * Create a redirect setup command for static routes (no params to forward).
 */
function redirectTo(target: RoutePath) {
  return command(({ set }) => {
    set(detachedNavigateTo$, target, { replace: true });
  });
}

/**
 * Create a redirect setup command for parameterized routes.
 * Reads pathParams$ and forwards the id param to the target route.
 */
function redirectWithId(target: RoutePath) {
  return command(({ get, set }) => {
    const params = get(pathParams$) ?? {};
    set(detachedNavigateTo$, target, {
      pathParams: { id: String(params.id) },
      replace: true,
    });
  });
}

const ROUTE_CONFIG = [
  // --- New routes ---
  {
    path: ROUTES.selectOrg,
    setup: setupAuthPageWrapper(setupSelectOrgPage$),
  },
  {
    path: ROUTES.chatList,
    setup: setupAuthPageWrapper(setupChatListPage$),
  },
  {
    path: ROUTES.insights,
    setup: setupAuthPageWrapper(setupNetworkInsightsPage$),
  },
  {
    path: ROUTES.chat,
    setup: setupAuthPageWrapper(setupChatSessionPage$),
  },
  {
    path: ROUTES.ideas,
    setup: setupAuthPageWrapper(setupIdeationPage$),
  },
  {
    path: ROUTES.directedAuthorize,
    setup: setupAuthPageWrapper(setupDirectedAuthorizePage$),
  },
  {
    path: ROUTES.directedConnect,
    setup: setupAuthPageWrapper(setupDirectedConnectPage$),
  },
  {
    path: ROUTES.connectors,
    setup: setupAuthPageWrapper(setupConnectorsPage$),
  },
  {
    path: ROUTES.agentIdeas,
    setup: setupAuthPageWrapper(setupIdeationPage$),
  },
  {
    path: ROUTES.agentChat,
    setup: setupAuthPageWrapper(setupTalkPage$),
  },
  {
    path: ROUTES.agentPermissions,
    setup: setupAuthPageWrapper(setupFirewallAllowPage$),
  },
  {
    path: ROUTES.agentDetail,
    setup: setupAuthPageWrapper(setupTeamDetailPage$),
  },
  {
    path: ROUTES.agents,
    setup: setupAuthPageWrapper(setupTeamPage$),
  },
  {
    path: ROUTES.settingsSlack,
    setup: setupAuthPageWrapper(setupSlackConnectPage$),
  },
  {
    path: ROUTES.queues,
    setup: setupAuthPageWrapper(setupQueuePage$),
  },
  {
    path: ROUTES.activityInspect,
    setup: setupAuthPageWrapper(setupActivityInspectPage$),
  },
  {
    path: ROUTES.activityDetail,
    setup: setupAuthPageWrapper(setupActivityDetailPage$),
  },
  {
    path: ROUTES.activities,
    setup: setupAuthPageWrapper(setupActivityPage$),
  },
  {
    path: ROUTES.works,
    setup: setupAuthPageWrapper(setupWorksPage$),
  },
  {
    path: ROUTES.settings,
    setup: setupAuthPageWrapper(setupPreferencesPage$),
  },
  {
    path: ROUTES.scheduleDetail,
    setup: setupAuthPageWrapper(setupScheduleDetailPage$),
  },
  {
    path: ROUTES.schedules,
    setup: setupAuthPageWrapper(setupSchedulePage$),
  },
  {
    path: ROUTES.settingsUsage,
    setup: setupAuthPageWrapper(setupUsagePage$),
  },
  {
    path: ROUTES.lab,
    setup: setupAuthPageWrapper(setupLabPage$),
  },
  {
    path: ROUTES.onboarding,
    setup: setupAuthPageWrapper(setupOnboardingPage$),
  },
  {
    path: ROUTES.signInToken,
    setup: setupSignInTokenPage$,
  },
  {
    path: ROUTES.internalConnectorLogos,
    setup: setupInternalConnectorLogos$,
  },
  {
    path: ROUTES.home,
    setup: setupAuthPageWrapper(setupHomePage$),
  },

  // --- Redirect routes (backward compatibility) ---
  { path: "/team", setup: redirectTo(ROUTES.agents) },
  { path: "/team/:id", setup: redirectWithId(ROUTES.agentDetail) },
  { path: "/talk/:id", setup: redirectWithId(ROUTES.agentChat) },
  { path: "/talk/:id/ideas", setup: redirectWithId(ROUTES.agentIdeas) },
  {
    path: "/firewall-allow/:id",
    setup: redirectWithId(ROUTES.agentPermissions),
  },
  { path: "/activity", setup: redirectTo(ROUTES.activities) },
  { path: "/activity/:id", setup: redirectWithId(ROUTES.activityDetail) },
  {
    path: "/activity/:id/context",
    setup: redirectWithId(ROUTES.activityDetail),
  },
  {
    path: "/activity/:id/network",
    setup: redirectWithId(ROUTES.activityDetail),
  },
  { path: "/chat/:id", setup: redirectWithId(ROUTES.chat) },
  { path: "/schedule", setup: redirectTo(ROUTES.schedules) },
  { path: "/schedule/:id", setup: redirectWithId(ROUTES.scheduleDetail) },
  { path: "/queue", setup: redirectTo(ROUTES.queues) },
  { path: "/preferences", setup: redirectTo(ROUTES.settings) },
  { path: "/usage", setup: redirectTo(ROUTES.settingsUsage) },
  { path: "/slack/connect", setup: redirectTo(ROUTES.settingsSlack) },

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
