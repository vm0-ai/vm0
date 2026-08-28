import { command, type Command } from "ccstate";
import { createElement } from "react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { SupportedLocale } from "../i18n/resources.ts";
import { setupClerk$, watchOrgSwitch$ } from "./auth.ts";
import { initTheme$, syncThemePreferences$ } from "./theme.ts";
import { initLocale$, syncLocalePreference$ } from "./locale.ts";
import { setRootSignal$ } from "./root-signal.ts";
import {
  initRoutes$,
  detachedNavigateTo$,
  setupPageWrapper,
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
import { setupSlackConnectPage$ } from "./okou-page/slack-connect-page.ts";
import { setupAgentPhoneConnectPage$ } from "./okou-page/agentphone-connect-page.ts";
import { setupGithubConnectPage$ } from "./okou-page/github-connect-page.ts";
import { setupTeamsConnectPage$ } from "./okou-page/teams-connect-page.ts";
import { setupTelegramConnectPage$ } from "./okou-page/telegram-connect-page.ts";
import { setupTelegramSettingsPage$ } from "./okou-page/telegram-settings-page.ts";
import { setupFeishuSettingsPage$ } from "./okou-page/feishu-settings-page.ts";
import { setupStrapiSettingsPage$ } from "./okou-page/strapi-settings-page.ts";
import { setupFeishuOAuthCallbackPage$ } from "./okou-page/feishu-oauth-callback-page.ts";
import { setupActivityDetailPage$ } from "./activity-page/activity-detail-page-setup.ts";
import { setupActivityInspectPage$ } from "./activity-page/activity-inspect-page-setup.ts";
import { setupAgentsPage$ } from "./agents-page/agents-page-setup.ts";
import { setupAgentDetailPage$ } from "./agents-page/agent-detail-page-setup.ts";
import { setupArtifactsPage$ } from "./artifacts-page/artifacts-page-setup.ts";
import { setupWorkflowsPage$ } from "./workflows-page/workflows-page-setup.ts";
import { setupWorkflowDetailPage$ } from "./workflows-page/workflow-detail-page-setup.ts";
import { setupWorksPage$ } from "./works-page/works-page-setup.ts";
import { setupPreferencesPage$ } from "./preferences-page/preferences-page-setup.ts";
import { setupAgentChatPage$ } from "./okou-page/agent-chat-page-setup.ts";
import { setupHomePage$ } from "./okou-page/home-page-setup.ts";
import { setupChatPage$ } from "./chat-page/chat-page-setup.ts";
import { setupPromptPage$ } from "./prompt-page/prompt-page-setup.ts";
import {
  setupOnboardingImageRunPage$,
  setupOnboardingImageTemplatePage$,
  setupOnboardingMakePage$,
  setupOnboardingPresentationRunPage$,
  setupOnboardingPresentationTemplatePage$,
  setupOnboardingVideoRunPage$,
  setupOnboardingVideoTemplatePage$,
  setupOnboardingWorkflowPickerPage$,
  setupOnboardingWorkflowRunPage$,
} from "./onboarding/onboarding-page-setup.ts";
import { setupIdeationPage$ } from "./okou-page/ideation-page-setup.ts";
import { setupConnectorsPage$ } from "./connectors-page/connectors-page-setup.ts";
import { setupComputerUseAuthorizationPage$ } from "./computer-use-authorization/computer-use-authorization-page-setup.ts";
import { setupBrowserAuthorizationPage$ } from "./browser-authorization/browser-authorization-page-setup.ts";
import { setupBrowserSessionPage$ } from "./browser-session/browser-session-page-setup.ts";
import { setupDirectedConnectPage$ } from "./connectors-page/directed-connect-page-setup.ts";
import { setupDirectedAuthorizePage$ } from "./connectors-page/directed-authorize-page-setup.ts";
import { setupConnectorRedirectingPage$ } from "./connectors-page/connector-redirecting-page-setup.ts";
import { setupConnectorCallbackPage$ } from "./connectors-page/connector-callback-page-setup.ts";
import { setupBankingConnectReturnPage$ } from "./banking-connect-return-page-setup.ts";
import { setupEmailUnsubscribePage$ } from "./email-unsubscribe/email-unsubscribe-page-setup.ts";
import { setupSignInTokenPage$ } from "./sign-in-token-setup.ts";
import { setupMorningBriefUnsubscribePage$ } from "./morning-brief-unsubscribe/morning-brief-unsubscribe-page-setup.ts";
import { setupSignInPage$, setupSignUpPage$ } from "./auth-page-setup.ts";
import {
  setupSignInV2Page$,
  setupSignUpV2Page$,
} from "./auth-v2-page-setup.ts";
import { setupPermissionAllowPage$ } from "./permission-allow/permission-allow-page-setup.ts";
import { setupLabPage$ } from "./lab-page/lab-page-setup.ts";
import { setupExportPage$ } from "./export-page/export-page-setup.ts";
import { initSlackOrg$ as handleSlackRedirect$ } from "./okou-page/slack.ts";
import { setupSkeletonPage$, setupErrorPage$ } from "./skeleton-page-setup.ts";
import {
  hideAppSkeleton$,
  initBootstrapSkeleton$,
  startSkeletonCycling$,
} from "./app-skeleton.ts";
import { setupRedeemCampaignPage$ } from "./redeem-campaign/redeem-campaign-page-setup.ts";
import { updatePage$ } from "./react-router.ts";
import { NotFoundPage } from "../views/not-found-page.tsx";
import { setupSharedThreadPage$ } from "./shared-thread-page/shared-thread-page-setup.ts";

import { setupGlobalKeyboardShortcuts$ } from "./okou-page/nav.ts";
import {
  featureSwitch$,
  reloadFeatureSwitch$,
} from "./external/feature-switch.ts";
import {
  setupConnectionDiagnostics$,
  writeConnectionDiagnostic$,
} from "./connection-diagnostics.ts";
import { checkUnifiedSettingsParam$ } from "./okou-page/settings/settings-dialog.ts";
import { captureInvitationRedirect$ } from "./invitation-redirect.ts";
import {
  initBootstrapPhaseTiming$,
  markBootstrapLocaleInitCompleted$,
  markBootstrapLocaleInitStarted$,
} from "../lib/posthog.ts";

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
    path: ROUTES.sharedThread,
    setup: setupSharedThreadPage$,
    analytics: false,
  },
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
  {
    path: ROUTES.signInV2,
    setup: setupPageWrapper(setupSignInV2Page$),
  },
  {
    path: ROUTES.signInV2CatchAll,
    setup: setupPageWrapper(setupSignInV2Page$),
  },
  {
    path: ROUTES.signUpV2,
    setup: setupPageWrapper(setupSignUpV2Page$),
  },
  {
    path: ROUTES.signUpV2CatchAll,
    setup: setupPageWrapper(setupSignUpV2Page$),
  },

  // --- New routes ---
  {
    path: ROUTES.chat,
    setup: setupAuthSidebarPageWrapper(setupChatPage$),
  },
  {
    path: ROUTES.browser,
    setup: setupAuthPageWrapper(setupBrowserSessionPage$),
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
    path: ROUTES.computerUseAuthorize,
    setup: setupAuthPageWrapper(setupComputerUseAuthorizationPage$),
  },
  {
    path: ROUTES.browserAuthorize,
    setup: setupAuthPageWrapper(setupBrowserAuthorizationPage$),
  },
  {
    path: ROUTES.bankingConnectReturnResult,
    setup: setupBankingConnectReturnPage$,
  },
  {
    path: ROUTES.bankingConnectReturn,
    setup: setupBankingConnectReturnPage$,
  },
  {
    path: ROUTES.connectorCallbackResult,
    setup: setupConnectorCallbackPage$,
  },
  {
    path: ROUTES.feishuOAuthCallback,
    setup: setupFeishuOAuthCallbackPage$,
  },
  {
    path: ROUTES.connectorCallback,
    setup: setupConnectorCallbackPage$,
  },
  {
    path: ROUTES.connectorRedirecting,
    setup: setupConnectorRedirectingPage$,
  },
  {
    path: ROUTES.emailUnsubscribe,
    setup: setupEmailUnsubscribePage$,
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
    path: ROUTES.artifacts,
    setup: setupAuthSidebarPageWrapper(setupArtifactsPage$),
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
    path: ROUTES.settingsFeishu,
    setup: setupAuthSidebarPageWrapper(setupFeishuSettingsPage$),
  },
  {
    path: ROUTES.settingsStrapi,
    setup: setupAuthSidebarPageWrapper(setupStrapiSettingsPage$),
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
    path: ROUTES.works,
    setup: setupAuthSidebarPageWrapper(setupWorksPage$),
  },
  {
    path: ROUTES.settings,
    setup: setupAuthSidebarPageWrapper(setupPreferencesPage$),
  },
  {
    path: ROUTES.lab,
    setup: setupAuthSidebarPageWrapper(setupLabPage$),
  },
  {
    path: ROUTES.exportData,
    setup: setupAuthPageWrapper(setupExportPage$),
  },
  {
    path: ROUTES.onboarding,
    setup: setupAuthPageWrapper(setupOnboardingMakePage$),
  },
  {
    path: ROUTES.onboardingWorkflowPicker,
    setup: setupAuthPageWrapper(setupOnboardingWorkflowPickerPage$),
  },
  {
    path: ROUTES.onboardingWorkflowRun,
    setup: setupAuthPageWrapper(setupOnboardingWorkflowRunPage$),
  },
  {
    path: ROUTES.onboardingPresentationTemplate,
    setup: setupAuthPageWrapper(setupOnboardingPresentationTemplatePage$),
  },
  {
    path: ROUTES.onboardingPresentationRun,
    setup: setupAuthPageWrapper(setupOnboardingPresentationRunPage$),
  },
  {
    path: ROUTES.onboardingImageTemplate,
    setup: setupAuthPageWrapper(setupOnboardingImageTemplatePage$),
  },
  {
    path: ROUTES.onboardingImageRun,
    setup: setupAuthPageWrapper(setupOnboardingImageRunPage$),
  },
  {
    path: ROUTES.onboardingVideoTemplate,
    setup: setupAuthPageWrapper(setupOnboardingVideoTemplatePage$),
  },
  {
    path: ROUTES.onboardingVideoRun,
    setup: setupAuthPageWrapper(setupOnboardingVideoRunPage$),
  },
  {
    path: ROUTES.signInToken,
    setup: setupSignInTokenPage$,
  },
  {
    // Public route: opened from the Morning Brief email, no auth guard.
    path: ROUTES.morningBriefUnsubscribe,
    setup: setupMorningBriefUnsubscribePage$,
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
    setup: setupAuthPageWrapper(
      setupSettingsParamAfterStableRoute(setupHomePage$),
    ),
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

const setupFeatureSwitches$ = command(
  async (
    { set },
    initialLocaleLoadFailure: SupportedLocale | null,
    signal: AbortSignal,
  ) => {
    await set(reloadFeatureSwitch$, signal);
    await set(syncLocalePreference$, initialLocaleLoadFailure, signal);
    await set(syncThemePreferences$, signal);
  },
);

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
  async ({ get, set }, render: () => void, signal: AbortSignal) => {
    set(initBootstrapPhaseTiming$, signal);
    set(captureInvitationRedirect$);
    set(markBootstrapLocaleInitStarted$);
    const initialLocaleLoadFailure = await set(initLocale$, signal);
    signal.throwIfAborted();
    set(markBootstrapLocaleInitCompleted$);
    set(initTheme$);
    set(setRootSignal$, signal);
    set(initBootstrapSkeleton$);

    set(setupLoggers$);

    // The cached effective switches already drive the first rendered frame.
    // Install capture from that same snapshot before setupRouter starts the
    // authenticated daemons, so their initial Clerk and Ably waits are kept
    // even while remote feature-switch hydration is still pending.
    set(setupConnectionDiagnostics$, signal);
    set(writeConnectionDiagnostic$, {
      action: "set-enabled",
      enabled: get(featureSwitch$)[FeatureSwitchKey.OkouDebug] ?? false,
    });

    render();

    set(handleSlackRedirect$);

    await Promise.all([
      set(setupRoutes$, signal),
      set(startSkeletonCycling$, signal),
      set(setupGlobalMethod$, signal),
      set(registerServiceWorker$, signal),
      set(setupNotificationListener$, signal),

      set(setupGlobalKeyboardShortcuts$, signal),
      set(setupClerk$, signal),
      set(watchOrgSwitch$, signal),
      set(setupFeatureSwitches$, initialLocaleLoadFailure, signal),
    ]);

    signal.throwIfAborted();
  },
);
