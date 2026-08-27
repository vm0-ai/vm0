import { command, type Command } from "ccstate";
import { createElement } from "react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { SupportedLocale } from "../i18n/resources.ts";
import { setupClerk$, watchOrgSwitch$ } from "./auth.ts";
import { initTheme$ } from "./theme.ts";
import { initLocale$, syncLocalePreference$ } from "./locale.ts";
import { setRootSignal$ } from "./root-signal.ts";
import {
  initRoutes$,
  detachedNavigateTo$,
  lazyRouteSetup,
  setupPageWrapper,
  setupAuthPageWrapper,
  pathParams$,
  pathname$,
  searchParams$,
  type LazyRouteSetup,
  type RouteSetup,
  type RouteSetupLoader,
  type RouterPathParams,
} from "./route.ts";
import { registerServiceWorker$ } from "../lib/push-notifications.ts";
import { onDomEventFn } from "./utils.ts";
import "./pwa-install.ts";
import { ROUTES, type RoutePath } from "./route-paths.ts";

import { setupGlobalMethod$ } from "./bootstrap/global-method.ts";
import { setupLoggers$ } from "./bootstrap/loggers.ts";
import { setupSignInPage$, setupSignUpPage$ } from "./auth-page-setup.ts";
import {
  setupSignInV2Page$,
  setupSignUpV2Page$,
} from "./auth-v2-page-setup.ts";
import { handleSlackRedirect$ } from "./bootstrap/slack-redirect.ts";
import { setupSkeletonPage$, setupErrorPage$ } from "./skeleton-page-setup.ts";
import {
  hideAppSkeleton$,
  initBootstrapSkeleton$,
  startSkeletonCycling$,
} from "./app-skeleton.ts";
import {
  registerPageLayout$,
  updatePage$,
  type PageLayout,
  type PageLayoutComponent,
} from "./react-router.ts";
import { NotFoundPage } from "../views/not-found-page.tsx";

import {
  featureSwitch$,
  reloadFeatureSwitch$,
} from "./external/feature-switch.ts";
import {
  setupConnectionDiagnostics$,
  writeConnectionDiagnostic$,
} from "./connection-diagnostics.ts";
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
    if (!get(searchParams$).has("settings")) {
      return;
    }
    const { checkUnifiedSettingsParam$ } =
      await import("./okou-page/settings/settings-dialog.ts");
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

type AuthenticatedPageLayout = Exclude<PageLayout, "none">;

async function loadPageLayout(
  layout: AuthenticatedPageLayout,
): Promise<PageLayoutComponent> {
  if (layout === "sidebar") {
    return (await import("../views/okou-page/sidebar-layout.tsx"))
      .SidebarLayout;
  }
  return (await import("../views/okou-page/directed-shared.tsx"))
    .MinimalSidebarLayout;
}

function loadAuthenticatedRouteSetup(
  load: RouteSetupLoader,
  layout?: AuthenticatedPageLayout,
): RouteSetupLoader {
  return async () => {
    const [setup, shortcuts, layoutComponent] = await Promise.all([
      load(),
      import("./okou-page/global-keyboard-shortcuts.ts"),
      layout ? loadPageLayout(layout) : undefined,
    ]);
    return command(async ({ set }, signal: AbortSignal) => {
      signal.throwIfAborted();
      if (layout && layoutComponent) {
        set(registerPageLayout$, layout, layoutComponent);
      }
      set(shortcuts.setupGlobalKeyboardShortcuts$, signal);
      await set(setup, signal);
    });
  };
}

function wrapLazyRouteSetup(
  route: LazyRouteSetup,
  wrap: (setup: RouteSetup) => RouteSetup,
): LazyRouteSetup {
  return { ...route, setup: wrap(route.setup) };
}

function setupLazyAuthPage(
  load: RouteSetupLoader,
  layout?: AuthenticatedPageLayout,
) {
  return wrapLazyRouteSetup(
    lazyRouteSetup(loadAuthenticatedRouteSetup(load, layout)),
    setupAuthPageWrapper,
  );
}

function setupLazyAuthSidebarPage(load: RouteSetupLoader) {
  return wrapLazyRouteSetup(
    lazyRouteSetup(loadAuthenticatedRouteSetup(load, "sidebar")),
    setupAuthSidebarPageWrapper,
  );
}

function setupLazyAuthSettingsPage(load: RouteSetupLoader) {
  return wrapLazyRouteSetup(
    lazyRouteSetup(loadAuthenticatedRouteSetup(load)),
    setupAuthSidebarPageWrapper,
  );
}

function setupLazyAuthMinimalPage(load: RouteSetupLoader) {
  return setupLazyAuthPage(load, "minimal");
}

const loadActivityRouteSetups = async () => {
  return (await import("./route-setups/activity.ts")).getActivityRouteSetups();
};
const loadBrowserRouteSetups = async () => {
  return (await import("./route-setups/browser.ts")).getBrowserRouteSetups();
};
const loadChatRouteSetups = async () => {
  return (await import("./route-setups/chat.ts")).getChatRouteSetups();
};
const loadHomeRouteSetups = async () => {
  return (await import("./route-setups/home.ts")).getHomeRouteSetups();
};
const loadMiscRouteSetups = async () => {
  return (await import("./route-setups/misc.ts")).getMiscRouteSetups();
};
const loadOnboardingRouteSetups = async () => {
  return (
    await import("./route-setups/onboarding.ts")
  ).getOnboardingRouteSetups();
};
const loadSettingsRouteSetups = async () => {
  return (await import("./route-setups/settings.ts")).getSettingsRouteSetups();
};
const loadWorkflowRouteSetups = async () => {
  return (await import("./route-setups/workflows.ts")).getWorkflowRouteSetups();
};

const ROUTE_CONFIG = [
  {
    path: ROUTES.sharedThread,
    ...lazyRouteSetup(async () => {
      return (await loadMiscRouteSetups()).setupSharedThreadPage$;
    }),
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
    ...setupLazyAuthSidebarPage(async () => {
      return (await loadChatRouteSetups()).setupChatPage$;
    }),
  },
  {
    path: ROUTES.browser,
    ...setupLazyAuthMinimalPage(async () => {
      return (await loadBrowserRouteSetups()).setupBrowserSessionPage$;
    }),
  },
  {
    path: ROUTES.prompt,
    ...setupLazyAuthPage(async () => {
      return (await loadChatRouteSetups()).setupPromptPage$;
    }),
  },
  {
    path: ROUTES.ideas,
    ...setupLazyAuthSidebarPage(async () => {
      return (await loadChatRouteSetups()).setupIdeationPage$;
    }),
  },
  {
    path: ROUTES.computerUseAuthorize,
    ...setupLazyAuthMinimalPage(async () => {
      return (await loadBrowserRouteSetups())
        .setupComputerUseAuthorizationPage$;
    }),
  },
  {
    path: ROUTES.browserAuthorize,
    ...setupLazyAuthMinimalPage(async () => {
      return (await loadBrowserRouteSetups()).setupBrowserAuthorizationPage$;
    }),
  },
  {
    path: ROUTES.bankingConnectReturnResult,
    ...lazyRouteSetup(async () => {
      return (await loadSettingsRouteSetups()).setupBankingConnectReturnPage$;
    }),
  },
  {
    path: ROUTES.bankingConnectReturn,
    ...lazyRouteSetup(async () => {
      return (await loadSettingsRouteSetups()).setupBankingConnectReturnPage$;
    }),
  },
  {
    path: ROUTES.connectorCallbackResult,
    ...lazyRouteSetup(async () => {
      return (await loadSettingsRouteSetups()).setupConnectorCallbackPage$;
    }),
  },
  {
    path: ROUTES.feishuOAuthCallback,
    ...lazyRouteSetup(async () => {
      return (await loadSettingsRouteSetups()).setupFeishuOAuthCallbackPage$;
    }),
  },
  {
    path: ROUTES.connectorCallback,
    ...lazyRouteSetup(async () => {
      return (await loadSettingsRouteSetups()).setupConnectorCallbackPage$;
    }),
  },
  {
    path: ROUTES.connectorRedirecting,
    ...lazyRouteSetup(async () => {
      return (await loadSettingsRouteSetups()).setupConnectorRedirectingPage$;
    }),
  },
  {
    path: ROUTES.emailUnsubscribe,
    ...lazyRouteSetup(async () => {
      return (await loadMiscRouteSetups()).setupEmailUnsubscribePage$;
    }),
  },
  {
    path: ROUTES.directedAuthorize,
    ...setupLazyAuthMinimalPage(async () => {
      return (await loadSettingsRouteSetups()).setupDirectedAuthorizePage$;
    }),
  },
  {
    path: ROUTES.directedConnect,
    ...setupLazyAuthMinimalPage(async () => {
      return (await loadSettingsRouteSetups()).setupDirectedConnectPage$;
    }),
  },
  {
    path: ROUTES.connectors,
    ...setupLazyAuthSidebarPage(async () => {
      return (await loadSettingsRouteSetups()).setupConnectorsPage$;
    }),
  },
  {
    path: ROUTES.agentIdeas,
    ...setupLazyAuthSidebarPage(async () => {
      return (await loadChatRouteSetups()).setupIdeationPage$;
    }),
  },
  {
    path: ROUTES.agentChat,
    ...setupLazyAuthSidebarPage(async () => {
      return (await loadChatRouteSetups()).setupAgentChatPage$;
    }),
  },
  {
    path: ROUTES.agentPermissions,
    ...setupLazyAuthMinimalPage(async () => {
      return (await loadBrowserRouteSetups()).setupPermissionAllowPage$;
    }),
  },
  {
    path: ROUTES.workflowDetail,
    ...setupLazyAuthSidebarPage(async () => {
      return (await loadWorkflowRouteSetups()).setupWorkflowDetailPage$;
    }),
  },
  {
    path: ROUTES.workflowDetailAutomations,
    ...setupLazyAuthSidebarPage(async () => {
      return (await loadWorkflowRouteSetups()).setupWorkflowDetailPage$;
    }),
  },
  {
    path: ROUTES.workflowDetailInstructions,
    ...setupLazyAuthSidebarPage(async () => {
      return (await loadWorkflowRouteSetups()).setupWorkflowDetailPage$;
    }),
  },
  {
    path: ROUTES.workflowDetailInfo,
    ...setupLazyAuthSidebarPage(async () => {
      return (await loadWorkflowRouteSetups()).setupWorkflowDetailPage$;
    }),
  },
  {
    path: ROUTES.workflows,
    ...setupLazyAuthSidebarPage(async () => {
      return (await loadWorkflowRouteSetups()).setupWorkflowsPage$;
    }),
  },
  {
    path: ROUTES.agentDetail,
    ...setupLazyAuthSidebarPage(async () => {
      return (await loadHomeRouteSetups()).setupAgentDetailPage$;
    }),
  },
  {
    path: ROUTES.agents,
    ...setupLazyAuthSidebarPage(async () => {
      return (await loadHomeRouteSetups()).setupAgentsPage$;
    }),
  },
  {
    path: ROUTES.artifacts,
    ...setupLazyAuthSidebarPage(async () => {
      return (await loadActivityRouteSetups()).setupArtifactsPage$;
    }),
  },
  {
    path: ROUTES.settingsSlack,
    ...setupLazyAuthSettingsPage(async () => {
      return (await loadSettingsRouteSetups()).setupSlackConnectPage$;
    }),
  },
  {
    path: ROUTES.settingsTeams,
    ...setupLazyAuthSettingsPage(async () => {
      return (await loadSettingsRouteSetups()).setupTeamsConnectPage$;
    }),
  },
  {
    path: ROUTES.settingsFeishu,
    ...setupLazyAuthSidebarPage(async () => {
      return (await loadSettingsRouteSetups()).setupFeishuSettingsPage$;
    }),
  },
  {
    path: ROUTES.settingsStrapi,
    ...setupLazyAuthSidebarPage(async () => {
      return (await loadSettingsRouteSetups()).setupStrapiSettingsPage$;
    }),
  },
  {
    path: ROUTES.settingsTelegram,
    ...setupLazyAuthSidebarPage(async () => {
      return (await loadSettingsRouteSetups()).setupTelegramSettingsPage$;
    }),
  },
  {
    path: ROUTES.githubConnect,
    ...setupLazyAuthPage(async () => {
      return (await loadSettingsRouteSetups()).setupGithubConnectPage$;
    }),
  },
  {
    path: ROUTES.telegramConnect,
    ...setupLazyAuthPage(async () => {
      return (await loadSettingsRouteSetups()).setupTelegramConnectPage$;
    }),
  },
  {
    path: ROUTES.agentphoneConnect,
    ...setupLazyAuthPage(async () => {
      return (await loadSettingsRouteSetups()).setupAgentPhoneConnectPage$;
    }),
  },
  {
    path: ROUTES.activityInspect,
    ...setupLazyAuthSidebarPage(async () => {
      return (await loadActivityRouteSetups()).setupActivityInspectPage$;
    }),
  },
  {
    path: ROUTES.activityDetail,
    ...setupLazyAuthSidebarPage(async () => {
      return (await loadActivityRouteSetups()).setupActivityDetailPage$;
    }),
  },
  {
    path: ROUTES.works,
    ...setupLazyAuthSidebarPage(async () => {
      return (await loadActivityRouteSetups()).setupWorksPage$;
    }),
  },
  {
    path: ROUTES.settings,
    ...setupLazyAuthSidebarPage(async () => {
      return (await loadSettingsRouteSetups()).setupPreferencesPage$;
    }),
  },
  {
    path: ROUTES.lab,
    ...setupLazyAuthSidebarPage(async () => {
      return (await loadMiscRouteSetups()).setupLabPage$;
    }),
  },
  {
    path: ROUTES.exportData,
    ...setupLazyAuthPage(async () => {
      return (await loadActivityRouteSetups()).setupExportPage$;
    }),
  },
  {
    path: ROUTES.onboarding,
    ...setupLazyAuthPage(async () => {
      return (await loadOnboardingRouteSetups()).setupOnboardingMakePage$;
    }),
  },
  {
    path: ROUTES.onboardingWorkflowPicker,
    ...setupLazyAuthPage(async () => {
      return (await loadOnboardingRouteSetups())
        .setupOnboardingWorkflowPickerPage$;
    }),
  },
  {
    path: ROUTES.onboardingWorkflowRun,
    ...setupLazyAuthPage(async () => {
      return (await loadOnboardingRouteSetups())
        .setupOnboardingWorkflowRunPage$;
    }),
  },
  {
    path: ROUTES.onboardingPresentationTemplate,
    ...setupLazyAuthPage(async () => {
      return (await loadOnboardingRouteSetups())
        .setupOnboardingPresentationTemplatePage$;
    }),
  },
  {
    path: ROUTES.onboardingPresentationRun,
    ...setupLazyAuthPage(async () => {
      return (await loadOnboardingRouteSetups())
        .setupOnboardingPresentationRunPage$;
    }),
  },
  {
    path: ROUTES.onboardingImageTemplate,
    ...setupLazyAuthPage(async () => {
      return (await loadOnboardingRouteSetups())
        .setupOnboardingImageTemplatePage$;
    }),
  },
  {
    path: ROUTES.onboardingImageRun,
    ...setupLazyAuthPage(async () => {
      return (await loadOnboardingRouteSetups()).setupOnboardingImageRunPage$;
    }),
  },
  {
    path: ROUTES.onboardingVideoTemplate,
    ...setupLazyAuthPage(async () => {
      return (await loadOnboardingRouteSetups())
        .setupOnboardingVideoTemplatePage$;
    }),
  },
  {
    path: ROUTES.onboardingVideoRun,
    ...setupLazyAuthPage(async () => {
      return (await loadOnboardingRouteSetups()).setupOnboardingVideoRunPage$;
    }),
  },
  {
    path: ROUTES.signInToken,
    ...lazyRouteSetup(async () => {
      return (await loadMiscRouteSetups()).setupSignInTokenPage$;
    }),
  },
  {
    // Public route: opened from the Morning Brief email, no auth guard.
    path: ROUTES.morningBriefUnsubscribe,
    ...lazyRouteSetup(async () => {
      return (await loadMiscRouteSetups()).setupMorningBriefUnsubscribePage$;
    }),
  },
  {
    path: ROUTES.redeemCampaign,
    ...setupLazyAuthMinimalPage(async () => {
      return (await loadSettingsRouteSetups()).setupRedeemCampaignPage$;
    }),
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
    ...setupLazyAuthSidebarPage(async () => {
      return (await loadHomeRouteSetups()).setupHomePage$;
    }),
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

      set(setupClerk$, signal),
      set(watchOrgSwitch$, signal),
      set(setupFeatureSwitches$, initialLocaleLoadFailure, signal),
    ]);

    signal.throwIfAborted();
  },
);
