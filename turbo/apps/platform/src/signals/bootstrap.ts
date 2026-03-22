import { command } from "ccstate";
import { setupClerk$ } from "./auth.ts";
import { setRootSignal$ } from "./root-signal.ts";
import { initRoutes$, setupAuthPageWrapper } from "./route.ts";
import { setupGlobalMethod$ } from "./bootstrap/global-method.ts";
import { setupLoggers$ } from "./bootstrap/loggers.ts";
import { setupZeroPage$ } from "./zero-page/zero-page.ts";
import { setupSelectOrgPage$ } from "./select-org/select-org-page.ts";
import { setupSlackConnectPage$ } from "./zero-page/slack-connect-page.ts";
import { setupQueuePage$ } from "./queue-page/queue-page-setup.ts";
import { setupActivityPage$ } from "./activity-page/activity-page-setup.ts";
import { setupActivityDetailPage$ } from "./activity-page/activity-detail-page-setup.ts";
import { setupTeamPage$ } from "./team-page/team-page-setup.ts";
import { setupTeamDetailPage$ } from "./team-page/team-detail-page-setup.ts";
import { setupWorksPage$ } from "./works-page/works-page-setup.ts";
import { setupPreferencesPage$ } from "./preferences-page/preferences-page-setup.ts";
import { setupSchedulePage$ } from "./schedule-page/schedule-page-setup.ts";
import { setupSettingsPage$ } from "./settings-page/settings-page-setup.ts";
import { setupInternalConnectorLogos$ } from "./internal-connector-logos-setup.ts";
const ROUTE_CONFIG = [
  {
    path: "/select-org",
    setup: setupAuthPageWrapper(setupSelectOrgPage$),
  },
  {
    path: "/chat/:sessionId",
    setup: setupAuthPageWrapper(setupZeroPage$),
  },
  {
    path: "/talk/:name",
    setup: setupAuthPageWrapper(setupZeroPage$),
  },
  {
    path: "/team/:name",
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
    path: "/activity/:logId",
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
    path: "/schedule",
    setup: setupAuthPageWrapper(setupSchedulePage$),
  },
  {
    path: "/settings",
    setup: setupAuthPageWrapper(setupSettingsPage$),
  },
  {
    path: "/__internal-connector-logos",
    setup: setupInternalConnectorLogos$,
  },
  {
    path: "/:tab/:sub",
    setup: setupAuthPageWrapper(setupZeroPage$),
  },
  {
    path: "/:tab",
    setup: setupAuthPageWrapper(setupZeroPage$),
  },
  {
    path: "/",
    setup: setupAuthPageWrapper(setupZeroPage$),
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
