import { command, type Command } from "ccstate";
import { createElement } from "react";
import { toast } from "@vm0/ui/components/ui/sonner";
import { setupClerk$, watchOrgSwitch$ } from "./auth.ts";
import { initTheme$ } from "./theme.ts";
import { setRootSignal$ } from "./root-signal.ts";
import {
  initRoutes$,
  detachedNavigateTo$,
  setupAuthPageWrapper,
  pathParams$,
  pathname$,
} from "./route.ts";
import { registerServiceWorker$ } from "../lib/push-notifications.ts";
import { onDomEventFn } from "./utils.ts";
import "./pwa-install.ts";
import { ROUTES, type RoutePath } from "./route-paths.ts";

import { setupGlobalMethod$ } from "./bootstrap/global-method.ts";
import { setupLoggers$ } from "./bootstrap/loggers.ts";
import { setupSlackConnectPage$ } from "./zero-page/slack-connect-page.ts";
import { setupAgentPhoneConnectPage$ } from "./zero-page/agentphone-connect-page.ts";
import { setupGithubConnectPage$ } from "./zero-page/github-connect-page.ts";
import { setupGithubSettingsPage$ } from "./zero-page/github-settings-page.ts";
import { setupTelegramConnectPage$ } from "./zero-page/telegram-connect-page.ts";
import { setupTelegramSettingsPage$ } from "./zero-page/telegram-settings-page.ts";
import { setupActivityPage$ } from "./activity-page/activity-page-setup.ts";
import { setupActivityDetailPage$ } from "./activity-page/activity-detail-page-setup.ts";
import { setupActivityInspectPage$ } from "./activity-page/activity-inspect-page-setup.ts";
import { setupAgentsPage$ } from "./agents-page/agents-page-setup.ts";
import { setupAgentDetailPage$ } from "./agents-page/agent-detail-page-setup.ts";
import { setupSkillsPage$ } from "./skills-page/skills-page-setup.ts";
import { setupMemoryPage$ } from "./memory-page/memory-page-setup.ts";
import { setupWorksPage$ } from "./works-page/works-page-setup.ts";
import { setupPreferencesPage$ } from "./preferences-page/preferences-page-setup.ts";
import { setupApiKeysPage$ } from "./api-keys-page/api-keys-page-setup.ts";
import { setupBb0DevicePage$ } from "./device-bb0-page/device-bb0-page-setup.ts";
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
import { setupLabPage$ } from "./lab-page/lab-page-setup.ts";
import { setupNetworkInsightsPage$ } from "./network-insights/network-insights-page-setup.ts";
import { setupUsagePage$ } from "./usage-page/usage-page-setup.ts";
import { initSlackOrg$ as handleSlackRedirect$ } from "./zero-page/zero-slack.ts";
import { setupSkeletonPage$, setupErrorPage$ } from "./skeleton-page-setup.ts";
import { hideAppSkeleton$, startSkeletonCycling$ } from "./app-skeleton.ts";
import { setupRedeemCampaignPage$ } from "./redeem-campaign/redeem-campaign-page-setup.ts";
import { setupRealtime$ } from "./realtime.ts";
import { updatePage$ } from "./react-router.ts";
import { NotFoundPage } from "../views/not-found-page.tsx";

import { setupGlobalKeyboardShortcuts$ } from "./zero-page/zero-nav.ts";
import { reloadFeatureSwitch$ } from "./external/feature-switch.ts";
import { googleAdsBillingConversionPayload } from "./bootstrap/billing-conversion.ts";
import {
  markCompletedBillingCheckout$,
  reloadBillingStatus$,
} from "./zero-page/billing.ts";
import { checkUnifiedSettingsParam$ } from "./zero-page/settings/settings-dialog.ts";

const setupNotFoundPage$ = command(async ({ set }, signal: AbortSignal) => {
  set(updatePage$, createElement(NotFoundPage));
  await set(hideAppSkeleton$, signal);
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

function setupSettingsParamAfterStableRoute(
  setupPage: Command<Promise<void> | void, [AbortSignal]>,
) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const initialPathname = get(pathname$);
    await set(setupPage, signal);
    signal.throwIfAborted();
    if (get(pathname$) !== initialPathname) {
      return;
    }
    await set(checkUnifiedSettingsParam$, signal);
  });
}

function setupAuthSidebarPageWrapper(
  setupPage: Command<Promise<void> | void, [AbortSignal]>,
) {
  return setupAuthPageWrapper(setupSettingsParamAfterStableRoute(setupPage));
}

const ROUTE_CONFIG = [
  // --- New routes ---
  {
    path: ROUTES.insights,
    setup: setupAuthSidebarPageWrapper(setupNetworkInsightsPage$),
  },
  {
    path: ROUTES.chat,
    setup: setupAuthSidebarPageWrapper(setupChatPage$),
  },
  {
    path: ROUTES.ideas,
    setup: setupAuthSidebarPageWrapper(setupIdeationPage$),
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
    setup: setupAuthSidebarPageWrapper(setupConnectorsPage$),
  },
  {
    path: ROUTES.agentIdeas,
    setup: setupAuthSidebarPageWrapper(setupIdeationPage$),
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
    setup: setupAuthSidebarPageWrapper(setupAgentDetailPage$),
  },
  {
    path: ROUTES.agents,
    setup: setupAuthSidebarPageWrapper(setupAgentsPage$),
  },
  {
    path: ROUTES.skills,
    setup: setupAuthSidebarPageWrapper(setupSkillsPage$),
  },
  {
    path: ROUTES.memory,
    setup: setupAuthSidebarPageWrapper(setupMemoryPage$),
  },
  {
    path: ROUTES.settingsSlack,
    setup: setupAuthSidebarPageWrapper(setupSlackConnectPage$),
  },
  {
    path: ROUTES.settingsGithub,
    setup: setupAuthSidebarPageWrapper(setupGithubSettingsPage$),
  },
  {
    path: ROUTES.settingsTelegram,
    setup: setupAuthSidebarPageWrapper(setupTelegramSettingsPage$),
  },
  {
    path: ROUTES.githubConnect,
    setup: setupAuthPageWrapper(setupGithubConnectPage$),
  },
  {
    path: ROUTES.telegramConnect,
    setup: setupAuthPageWrapper(setupTelegramConnectPage$),
  },
  {
    path: ROUTES.agentphoneConnect,
    setup: setupAuthPageWrapper(setupAgentPhoneConnectPage$),
  },
  {
    path: ROUTES.activityInspect,
    setup: setupAuthSidebarPageWrapper(setupActivityInspectPage$),
  },
  {
    path: ROUTES.activityDetail,
    setup: setupAuthSidebarPageWrapper(setupActivityDetailPage$),
  },
  {
    path: ROUTES.activities,
    setup: setupAuthSidebarPageWrapper(setupActivityPage$),
  },
  {
    path: ROUTES.works,
    setup: setupAuthSidebarPageWrapper(setupWorksPage$),
  },
  {
    path: ROUTES.settings,
    setup: setupAuthSidebarPageWrapper(setupPreferencesPage$),
  },
  {
    path: ROUTES.settingsApiKeys,
    setup: setupAuthSidebarPageWrapper(setupApiKeysPage$),
  },
  {
    path: ROUTES.deviceBb0,
    setup: setupAuthSidebarPageWrapper(setupBb0DevicePage$),
  },
  {
    path: ROUTES.scheduleDetail,
    setup: setupAuthSidebarPageWrapper(setupScheduleDetailPage$),
  },
  {
    path: ROUTES.schedules,
    setup: setupAuthSidebarPageWrapper(setupSchedulePage$),
  },
  {
    path: ROUTES.lab,
    setup: setupAuthSidebarPageWrapper(setupLabPage$),
  },
  {
    path: ROUTES.usage,
    setup: setupAuthSidebarPageWrapper(setupUsagePage$),
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
    path: ROUTES.redeemCampaign,
    setup: setupAuthPageWrapper(setupRedeemCampaignPage$),
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
  { path: "/preferences", setup: redirectTo(ROUTES.settings) },

  {
    // Catch-all: keep unknown paths in place and show the not-found surface.
    path: "{/*path}",
    setup: setupNotFoundPage$,
  },
] as const;

const setupRoutes$ = command(async ({ set }, signal: AbortSignal) => {
  await set(initRoutes$, ROUTE_CONFIG, signal);
});

function showSuccessToastAfterMount(message: string): void {
  const showToast = () => {
    window.setTimeout(() => {
      toast.success(message);
    }, 0);
  };

  if (document.readyState === "complete") {
    showToast();
    return;
  }

  window.addEventListener("load", showToast, { once: true });
}

const handleBillingRedirect$ = command(({ set }) => {
  const url = new URL(window.location.href);
  const billing = url.searchParams.get("billing");
  const transactionId = url.searchParams.get("billing_session_id");
  const credits = url.searchParams.get("credits");
  if (!billing && !credits) {
    return;
  }

  url.searchParams.delete("billing");
  url.searchParams.delete("billing_session_id");
  url.searchParams.delete("credits");
  url.searchParams.delete("credit_checkout_session_id");
  window.history.replaceState(null, "", url.toString());

  if (billing === "pro" || billing === "team") {
    // Fire Google Ads conversion event: subscription completed via Stripe
    // checkout. The `billing` param is set only on Stripe success redirect
    // and stripped above, so this fires at most once per real conversion.
    type GtagFn = (...args: unknown[]) => void;
    const payload = googleAdsBillingConversionPayload(billing, transactionId);
    if (payload) {
      (window as Window & { gtag?: GtagFn }).gtag?.(
        "event",
        "conversion",
        payload,
      );
    }

    const label = billing === "pro" ? "Pro" : "Team";
    showSuccessToastAfterMount(
      `${label} checkout completed. Credits will be added after the invoice is paid.`,
    );
    set(markCompletedBillingCheckout$, billing, transactionId);
    set(reloadBillingStatus$);
  }

  if (credits === "purchased") {
    showSuccessToastAfterMount(
      "Credits added. You can continue chatting with Zero.",
    );
    set(reloadBillingStatus$);
  }
});

const setupNotificationListener$ = command(({ set }, signal: AbortSignal) => {
  navigator.serviceWorker?.addEventListener(
    "message",
    onDomEventFn((event: MessageEvent): void => {
      if (event.data?.type === "NOTIFICATION_CLICK" && event.data.url) {
        const match = /^\/chats\/(.+)$/.exec(event.data.url as string);
        if (match) {
          set(detachedNavigateTo$, "/chats/:threadId", {
            pathParams: { threadId: match[1] },
          });
        }
      }
    }),
    {
      signal,
    },
  );
});

export const bootstrap$ = command(
  async ({ set }, render: () => void, signal: AbortSignal) => {
    set(initTheme$);
    set(setRootSignal$, signal);

    set(setupLoggers$);

    render();

    set(handleBillingRedirect$);
    set(handleSlackRedirect$);

    await Promise.all([
      set(setupRoutes$, signal),
      set(startSkeletonCycling$, signal),
      set(setupRealtime$, signal),
      set(setupGlobalMethod$, signal),
      set(registerServiceWorker$, signal),
      set(setupNotificationListener$, signal),

      set(setupGlobalKeyboardShortcuts$, signal),
      set(setupClerk$, signal),
      set(watchOrgSwitch$, signal),
      set(reloadFeatureSwitch$, signal),
    ]);

    signal.throwIfAborted();
  },
);
