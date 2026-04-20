import { command } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { setupClerk$, watchOrgSwitch$ } from "./auth.ts";
import { initTheme$ } from "./theme.ts";
import { setRootSignal$ } from "./root-signal.ts";
import {
  initRoutes$,
  detachedNavigateTo$,
  setupAuthPageWrapper,
  pathParams$,
} from "./route.ts";
import { registerServiceWorker$ } from "../lib/push-notifications.ts";
import { setupInstallPrompt$ } from "./pwa-install.ts";
import { ROUTES, type RoutePath } from "./route-paths.ts";

import { setupGlobalMethod$ } from "./bootstrap/global-method.ts";
import { setupLoggers$ } from "./bootstrap/loggers.ts";
import { setupSlackConnectPage$ } from "./zero-page/slack-connect-page.ts";
import { setupQueuePage$ } from "./queue-page/queue-page-setup.ts";
import { setupActivityPage$ } from "./activity-page/activity-page-setup.ts";
import { setupActivityDetailPage$ } from "./activity-page/activity-detail-page-setup.ts";
import { setupActivityInspectPage$ } from "./activity-page/activity-inspect-page-setup.ts";
import { setupAgentsPage$ } from "./agents-page/agents-page-setup.ts";
import { setupAgentDetailPage$ } from "./agents-page/agent-detail-page-setup.ts";
import { setupWorksPage$ } from "./works-page/works-page-setup.ts";
import { setupPreferencesPage$ } from "./preferences-page/preferences-page-setup.ts";
import { setupSchedulePage$ } from "./schedule-page/schedule-page-setup.ts";
import { setupScheduleDetailPage$ } from "./schedule-page/schedule-detail-page-setup.ts";
import { setupAgentChatPage$ } from "./zero-page/agent-chat-page-setup.ts";
import { setupHomePage$ } from "./zero-page/home-page-setup.ts";
import { setupChatPage$ } from "./chat-page/chat-page-setup.ts";
import { setupInternalConnectorLogos$ } from "./internal-connector-logos-setup.ts";
import { setupOnboardingPage$ } from "./onboarding-page/onboarding-page-setup.ts";
import { setupIdeationPage$ } from "./zero-page/ideation-page-setup.ts";
import { setupConnectorsPage$ } from "./connectors-page/connectors-page-setup.ts";
import { setupDirectedConnectPage$ } from "./connectors-page/directed-connect-page-setup.ts";
import { setupDirectedAuthorizePage$ } from "./connectors-page/directed-authorize-page-setup.ts";
import { setupSignInTokenPage$ } from "./sign-in-token-setup.ts";
import { setupPermissionAllowPage$ } from "./permission-allow/permission-allow-page-setup.ts";
import { setupReportErrorPage$ } from "./report-error/report-error-page-setup.ts";
import { setupChatListPage$ } from "./zero-page/chat-list-page-setup.ts";
import { setupLabPage$ } from "./lab-page/lab-page-setup.ts";
import { setupPhonePage$ } from "./phone-page/phone-page-setup.ts";
import { setupVoiceChatPage$ } from "./voice-chat/voice-chat-setup.ts";
import { setupNetworkInsightsPage$ } from "./network-insights/network-insights-page-setup.ts";
import { initSlackOrg$ as handleSlackRedirect$ } from "./zero-page/zero-slack.ts";
import { setupSkeletonPage$, setupErrorPage$ } from "./skeleton-page-setup.ts";
import { startSkeletonCycling$ } from "./app-skeleton.ts";
import { setupMissionControlPage$ } from "./mission-control-page/mission-control-page.ts";
import { setupRealtime$ } from "./realtime.ts";
import { setupPwaEdgeSwipe$ } from "./zero-page/pwa-edge-swipe.ts";
import { setupSidebarShortcut$ } from "./zero-page/zero-nav.ts";

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
 * Reads the `id` param from the source URL and maps it to `targetParam` on the target route.
 */
function redirectWithId(target: RoutePath, targetParam: string) {
  return command(({ get, set }) => {
    const params = get(pathParams$) ?? {};
    set(detachedNavigateTo$, target, {
      pathParams: { [targetParam]: String(params.id) } as Record<
        string,
        string
      >,
      replace: true,
    });
  });
}

const ROUTE_CONFIG = [
  // --- New routes ---
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
    setup: setupAuthPageWrapper(setupChatPage$),
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
    setup: setupAuthPageWrapper(setupAgentChatPage$),
  },
  {
    path: ROUTES.agentPermissions,
    setup: setupAuthPageWrapper(setupPermissionAllowPage$),
  },
  {
    path: ROUTES.reportError,
    setup: setupAuthPageWrapper(setupReportErrorPage$),
  },
  {
    path: ROUTES.agentDetail,
    setup: setupAuthPageWrapper(setupAgentDetailPage$),
  },
  {
    path: ROUTES.agents,
    setup: setupAuthPageWrapper(setupAgentsPage$),
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
    path: ROUTES.phone,
    setup: setupAuthPageWrapper(setupPhonePage$),
  },
  {
    path: ROUTES.lab,
    setup: setupAuthPageWrapper(setupLabPage$),
  },
  {
    path: ROUTES.voiceChat,
    setup: setupAuthPageWrapper(setupVoiceChatPage$),
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
    path: ROUTES.missionControl,
    setup: setupAuthPageWrapper(setupMissionControlPage$),
  },
  {
    path: ROUTES.skeleton,
    setup: setupSkeletonPage$,
  },
  {
    path: ROUTES.error,
    setup: setupErrorPage$,
  },
  {
    path: ROUTES.home,
    setup: setupAuthPageWrapper(setupHomePage$),
  },

  // --- Redirect routes (backward compatibility) ---
  { path: "/team", setup: redirectTo(ROUTES.agents) },
  { path: "/team/:id", setup: redirectWithId(ROUTES.agentDetail, "agentId") },
  { path: "/talk/:id", setup: redirectWithId(ROUTES.agentChat, "agentId") },
  {
    path: "/talk/:id/ideas",
    setup: redirectWithId(ROUTES.agentIdeas, "agentId"),
  },
  {
    path: "/firewall-allow/:id",
    setup: redirectWithId(ROUTES.agentPermissions, "agentId"),
  },
  { path: "/activity", setup: redirectTo(ROUTES.activities) },
  {
    path: "/activity/:id",
    setup: redirectWithId(ROUTES.activityDetail, "activityRunId"),
  },
  {
    path: "/activity/:id/context",
    setup: redirectWithId(ROUTES.activityDetail, "activityRunId"),
  },
  {
    path: "/activity/:id/network",
    setup: redirectWithId(ROUTES.activityDetail, "activityRunId"),
  },
  { path: "/chat/:id", setup: redirectWithId(ROUTES.chat, "threadId") },
  { path: "/schedule", setup: redirectTo(ROUTES.schedules) },
  {
    path: "/schedule/:id",
    setup: redirectWithId(ROUTES.scheduleDetail, "scheduleId"),
  },
  { path: "/queue", setup: redirectTo(ROUTES.queues) },
  { path: "/preferences", setup: redirectTo(ROUTES.settings) },

  {
    // Catch-all: redirect unknown paths to /
    path: "{/*path}",
    setup: setupNotFoundRedirect$,
  },
] as const;

const setupRoutes$ = command(async ({ set }, signal: AbortSignal) => {
  await set(initRoutes$, ROUTE_CONFIG, signal);
});

const handleBillingRedirect$ = command(() => {
  const url = new URL(window.location.href);
  const billing = url.searchParams.get("billing");
  if (!billing) {
    return;
  }

  url.searchParams.delete("billing");
  window.history.replaceState(null, "", url.toString());

  // Defer toast until Toaster component is mounted
  if (billing === "pro" || billing === "team") {
    const label = billing === "pro" ? "Pro" : "Team";
    window.addEventListener(
      "load",
      () => {
        toast.success(`Upgraded to ${label}! Your credits have been added.`);
      },
      { once: true },
    );
  }
});

const setupNotificationListener$ = command(({ set }, signal: AbortSignal) => {
  const handler = (event: MessageEvent) => {
    if (event.data?.type === "NOTIFICATION_CLICK" && event.data.url) {
      const match = /^\/chats\/(.+)$/.exec(event.data.url as string);
      if (match) {
        set(detachedNavigateTo$, "/chats/:threadId", {
          pathParams: { threadId: match[1] },
        });
      }
    }
  };
  navigator.serviceWorker?.addEventListener("message", handler);
  signal.addEventListener("abort", () => {
    navigator.serviceWorker?.removeEventListener("message", handler);
  });
});

export const bootstrap$ = command(
  async ({ set }, render: () => void, signal: AbortSignal) => {
    set(initTheme$);
    set(setRootSignal$, signal);

    set(setupLoggers$);

    render();

    set(handleBillingRedirect$);
    set(handleSlackRedirect$);
    await set(setupRealtime$, signal);

    await Promise.all([
      set(setupGlobalMethod$, signal),
      set(registerServiceWorker$, signal),
      set(setupNotificationListener$, signal),
      set(setupInstallPrompt$, signal),
      set(setupPwaEdgeSwipe$, signal),
      set(setupSidebarShortcut$, signal),
      set(startSkeletonCycling$, signal),
      (async () => {
        await set(setupClerk$, signal);
        await set(watchOrgSwitch$, signal);
      })(),
      set(setupRoutes$, signal),
    ]);

    signal.throwIfAborted();
  },
);
