import { setupBrowserAuthorizationPage$ } from "../browser-authorization/browser-authorization-page-setup.ts";
import { setupBrowserSessionPage$ } from "../browser-session/browser-session-page-setup.ts";
import { setupComputerUseAuthorizationPage$ } from "../computer-use-authorization/computer-use-authorization-page-setup.ts";
import { setupPermissionAllowPage$ } from "../permission-allow/permission-allow-page-setup.ts";

export function getBrowserRouteSetups() {
  return {
    setupBrowserAuthorizationPage$,
    setupBrowserSessionPage$,
    setupComputerUseAuthorizationPage$,
    setupPermissionAllowPage$,
  };
}
