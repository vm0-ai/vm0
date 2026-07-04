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
  type RouterPathParams,
} from "./route.ts";
import { registerServiceWorker$ } from "../lib/push-notifications.ts";
import { onDomEventFn } from "./utils.ts";
import "./pwa-install.ts";
import { ROUTES, type RoutePath } from "./route-paths.ts";

import { setupGlobalMethod$ } from "./bootstrap/global-method.ts";
import { setupLoggers$ } from "./bootstrap/loggers.ts";
import { initSlackOrg$ as handleSlackRedirect$ } from "./zero-page/zero-slack.ts";
import { hideAppSkeleton$, startSkeletonCycling$ } from "./app-skeleton.ts";
import { setupRealtime$ } from "./realtime.ts";
import { updatePage$ } from "./react-router.ts";
import { NotFoundPage } from "../views/not-found-page.tsx";

import { setupGlobalKeyboardShortcuts$ } from "./zero-page/zero-nav.ts";
import { reloadFeatureSwitch$ } from "./external/feature-switch.ts";
import { reloadBillingStatus$ } from "./zero-page/billing.ts";
import { checkUnifiedSettingsParam$ } from "./zero-page/settings/settings-dialog.ts";

type RouteSetupCommand = Command<Promise<void> | void, [AbortSignal]>;

const setupNotFoundPage$ = command(async ({ set }, signal: AbortSignal) => {
  set(updatePage$, createElement(NotFoundPage));
  await set(hideAppSkeleton$, signal);
});

function asRouteSetupCommand(setup: unknown): RouteSetupCommand {
  return setup as RouteSetupCommand;
}

function lazyRouteSetup(load: () => Promise<unknown>): RouteSetupCommand {
  return command(async ({ set }, signal: AbortSignal) => {
    const setupPage = asRouteSetupCommand(await load());
    signal.throwIfAborted();
    await set(setupPage, signal);
  });
}

// Dynamic route imports optimize loading performance by keeping inactive pages
// out of the initial application bundle.
const setupSlackConnectPage$ = lazyRouteSetup(async () => {
  const module = await import("./zero-page/slack-connect-page.ts");
  return module.setupSlackConnectPage$;
});
const setupAgentPhoneConnectPage$ = lazyRouteSetup(async () => {
  const module = await import("./zero-page/agentphone-connect-page.ts");
  return module.setupAgentPhoneConnectPage$;
});
const setupGithubConnectPage$ = lazyRouteSetup(async () => {
  const module = await import("./zero-page/github-connect-page.ts");
  return module.setupGithubConnectPage$;
});
const setupTeamsConnectPage$ = lazyRouteSetup(async () => {
  const module = await import("./zero-page/teams-connect-page.ts");
  return module.setupTeamsConnectPage$;
});
const setupTelegramConnectPage$ = lazyRouteSetup(async () => {
  const module = await import("./zero-page/telegram-connect-page.ts");
  return module.setupTelegramConnectPage$;
});
const setupTelegramSettingsPage$ = lazyRouteSetup(async () => {
  const module = await import("./zero-page/telegram-settings-page.ts");
  return module.setupTelegramSettingsPage$;
});
const setupActivityPage$ = lazyRouteSetup(async () => {
  const module = await import("./activity-page/activity-page-setup.ts");
  return module.setupActivityPage$;
});
const setupActivityDetailPage$ = lazyRouteSetup(async () => {
  const module = await import("./activity-page/activity-detail-page-setup.ts");
  return module.setupActivityDetailPage$;
});
const setupActivityInspectPage$ = lazyRouteSetup(async () => {
  const module = await import("./activity-page/activity-inspect-page-setup.ts");
  return module.setupActivityInspectPage$;
});
const setupAgentsPage$ = lazyRouteSetup(async () => {
  const module = await import("./agents-page/agents-page-setup.ts");
  return module.setupAgentsPage$;
});
const setupAgentDetailPage$ = lazyRouteSetup(async () => {
  const module = await import("./agents-page/agent-detail-page-setup.ts");
  return module.setupAgentDetailPage$;
});
const setupWorkflowsPage$ = lazyRouteSetup(async () => {
  const module = await import("./workflows-page/workflows-page-setup.ts");
  return module.setupWorkflowsPage$;
});
const setupWorkflowDetailPage$ = lazyRouteSetup(async () => {
  const module = await import("./workflows-page/workflow-detail-page-setup.ts");
  return module.setupWorkflowDetailPage$;
});
const setupMemoryPage$ = lazyRouteSetup(async () => {
  const module = await import("./memory-page/memory-page-setup.ts");
  return module.setupMemoryPage$;
});
const setupWorksPage$ = lazyRouteSetup(async () => {
  const module = await import("./works-page/works-page-setup.ts");
  return module.setupWorksPage$;
});
const setupPreferencesPage$ = lazyRouteSetup(async () => {
  const module = await import("./preferences-page/preferences-page-setup.ts");
  return module.setupPreferencesPage$;
});
const setupApiKeysPage$ = lazyRouteSetup(async () => {
  const module = await import("./api-keys-page/api-keys-page-setup.ts");
  return module.setupApiKeysPage$;
});
const setupBb0DevicePage$ = lazyRouteSetup(async () => {
  const module = await import("./device-bb0-page/device-bb0-page-setup.ts");
  return module.setupBb0DevicePage$;
});
const setupAutomationsPage$ = lazyRouteSetup(async () => {
  const module = await import("./automation-page/automation-page-setup.ts");
  return module.setupAutomationsPage$;
});
const setupAutomationDetailPage$ = lazyRouteSetup(async () => {
  const module =
    await import("./automation-page/automation-detail-page-setup.ts");
  return module.setupAutomationDetailPage$;
});
const setupAgentChatPage$ = lazyRouteSetup(async () => {
  const module = await import("./zero-page/agent-chat-page-setup.ts");
  return module.setupAgentChatPage$;
});
const setupHomePage$ = lazyRouteSetup(async () => {
  const module = await import("./zero-page/home-page-setup.ts");
  return module.setupHomePage$;
});
const setupChatPage$ = lazyRouteSetup(async () => {
  const module = await import("./chat-page/chat-page-setup.ts");
  return module.setupChatPage$;
});
const setupPromptPage$ = lazyRouteSetup(async () => {
  const module = await import("./prompt-page/prompt-page-setup.ts");
  return module.setupPromptPage$;
});
const setupOnboardingRedirectPage$ = lazyRouteSetup(async () => {
  const module = await import("./zero-page/onboard-guard.ts");
  return module.setupOnboardingRedirectPage$;
});
const setupIdeationPage$ = lazyRouteSetup(async () => {
  const module = await import("./zero-page/ideation-page-setup.ts");
  return module.setupIdeationPage$;
});
const setupConnectorsPage$ = lazyRouteSetup(async () => {
  const module = await import("./connectors-page/connectors-page-setup.ts");
  return module.setupConnectorsPage$;
});
const setupCustomConnectorProposalPage$ = lazyRouteSetup(async () => {
  const module =
    await import("./connectors-page/custom-connector-proposal-page-setup.ts");
  return module.setupCustomConnectorProposalPage$;
});
const setupComputerUseAuthorizationPage$ = lazyRouteSetup(async () => {
  const module =
    await import("./computer-use-authorization/computer-use-authorization-page-setup.ts");
  return module.setupComputerUseAuthorizationPage$;
});
const setupDirectedConnectPage$ = lazyRouteSetup(async () => {
  const module =
    await import("./connectors-page/directed-connect-page-setup.ts");
  return module.setupDirectedConnectPage$;
});
const setupDirectedAuthorizePage$ = lazyRouteSetup(async () => {
  const module =
    await import("./connectors-page/directed-authorize-page-setup.ts");
  return module.setupDirectedAuthorizePage$;
});
const setupSignInTokenPage$ = lazyRouteSetup(async () => {
  const module = await import("./sign-in-token-setup.ts");
  return module.setupSignInTokenPage$;
});
const setupSignInPage$ = lazyRouteSetup(async () => {
  const module = await import("./auth-page-setup.ts");
  return module.setupSignInPage$;
});
const setupSignUpPage$ = lazyRouteSetup(async () => {
  const module = await import("./auth-page-setup.ts");
  return module.setupSignUpPage$;
});
const setupPermissionAllowPage$ = lazyRouteSetup(async () => {
  const module =
    await import("./permission-allow/permission-allow-page-setup.ts");
  return module.setupPermissionAllowPage$;
});
const setupReportErrorPage$ = lazyRouteSetup(async () => {
  const module = await import("./report-error/report-error-page-setup.ts");
  return module.setupReportErrorPage$;
});
const setupLabPage$ = lazyRouteSetup(async () => {
  const module = await import("./lab-page/lab-page-setup.ts");
  return module.setupLabPage$;
});
const setupNetworkInsightsPage$ = lazyRouteSetup(async () => {
  const module =
    await import("./network-insights/network-insights-page-setup.ts");
  return module.setupNetworkInsightsPage$;
});
const setupUsagePage$ = lazyRouteSetup(async () => {
  const module = await import("./usage-page/usage-page-setup.ts");
  return module.setupUsagePage$;
});
const setupExportPage$ = lazyRouteSetup(async () => {
  const module = await import("./export-page/export-page-setup.ts");
  return module.setupExportPage$;
});
const setupSkeletonPage$ = lazyRouteSetup(async () => {
  const module = await import("./skeleton-page-setup.ts");
  return module.setupSkeletonPage$;
});
const setupErrorPage$ = lazyRouteSetup(async () => {
  const module = await import("./skeleton-page-setup.ts");
  return module.setupErrorPage$;
});
const setupRedeemCampaignPage$ = lazyRouteSetup(async () => {
  const module =
    await import("./redeem-campaign/redeem-campaign-page-setup.ts");
  return module.setupRedeemCampaignPage$;
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
      pathParams: { [targetParam]: String(params.id) } as RouterPathParams,
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
  {
    path: ROUTES.signIn,
    setup: setupSignInPage$,
  },
  {
    path: ROUTES.signInCatchAll,
    setup: setupSignInPage$,
  },
  {
    path: ROUTES.signUp,
    setup: setupSignUpPage$,
  },
  {
    path: ROUTES.signUpCatchAll,
    setup: setupSignUpPage$,
  },

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
    path: ROUTES.prompt,
    setup: setupAuthPageWrapper(setupPromptPage$),
  },
  {
    path: ROUTES.ideas,
    setup: setupAuthSidebarPageWrapper(setupIdeationPage$),
  },
  {
    path: ROUTES.customConnectorProposal,
    setup: setupAuthPageWrapper(setupCustomConnectorProposalPage$),
  },
  {
    path: ROUTES.computerUseAuthorize,
    setup: setupAuthPageWrapper(setupComputerUseAuthorizationPage$),
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
    path: ROUTES.workflowDetail,
    setup: setupAuthSidebarPageWrapper(setupWorkflowDetailPage$),
  },
  {
    path: ROUTES.workflowDetailAutomations,
    setup: setupAuthSidebarPageWrapper(setupWorkflowDetailPage$),
  },
  {
    path: ROUTES.workflowDetailInstructions,
    setup: setupAuthSidebarPageWrapper(setupWorkflowDetailPage$),
  },
  {
    path: ROUTES.workflowDetailInfo,
    setup: setupAuthSidebarPageWrapper(setupWorkflowDetailPage$),
  },
  {
    path: ROUTES.workflows,
    setup: setupAuthSidebarPageWrapper(setupWorkflowsPage$),
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
    path: ROUTES.memory,
    setup: setupAuthSidebarPageWrapper(setupMemoryPage$),
  },
  {
    path: ROUTES.settingsSlack,
    setup: setupAuthSidebarPageWrapper(setupSlackConnectPage$),
  },
  {
    path: ROUTES.settingsTeams,
    setup: setupAuthSidebarPageWrapper(setupTeamsConnectPage$),
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
    path: ROUTES.automationDetail,
    setup: setupAuthSidebarPageWrapper(setupAutomationDetailPage$),
  },
  {
    path: ROUTES.automations,
    setup: setupAuthSidebarPageWrapper(setupAutomationsPage$),
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
    path: ROUTES.exportData,
    setup: setupAuthPageWrapper(setupExportPage$),
  },
  {
    path: ROUTES.onboarding,
    setup: setupAuthPageWrapper(setupOnboardingRedirectPage$),
  },
  {
    path: ROUTES.signInToken,
    setup: setupSignInTokenPage$,
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
  const credits = url.searchParams.get("credits");
  const concurrency = url.searchParams.get("concurrency");
  if (!billing && !credits && !concurrency) {
    return;
  }

  url.searchParams.delete("billing");
  url.searchParams.delete("billing_session_id");
  url.searchParams.delete("credits");
  url.searchParams.delete("credit_checkout_session_id");
  url.searchParams.delete("concurrency");
  window.history.replaceState(null, "", url.toString());

  if (billing === "pro" || billing === "team") {
    const label = billing === "pro" ? "Pro" : "Team";
    showSuccessToastAfterMount(
      `${label} checkout completed. Credits will be added after the invoice is paid.`,
    );
    set(reloadBillingStatus$);
  }

  if (credits === "purchased") {
    showSuccessToastAfterMount(
      "Credits added. You can continue chatting with Zero.",
    );
    set(reloadBillingStatus$);
  }

  if (concurrency === "purchased") {
    showSuccessToastAfterMount(
      "Concurrency added. Your new slots will become available after Stripe confirms the subscription.",
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
