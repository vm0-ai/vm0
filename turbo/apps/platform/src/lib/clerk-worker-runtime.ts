import { Clerk } from "@clerk/clerk-js/no-rhc";

import {
  CLERK_DEV_BROWSER_ROTATION_HEADER,
  withClerkDevBrowserJwt,
} from "./clerk-dev-browser.ts";
import { resolveClerkInstanceConfig } from "./clerk-instance-config.ts";
import type { ClerkTokenSource } from "../signals/clerk-token.ts";

/**
 * Mirrors Clerk's own DOM-less client: `@clerk/chrome-extension` builds the
 * same `@clerk/clerk-js/no-rhc` instance and injects the dev browser JWT
 * through `__internal_onBeforeRequest` / `__internal_onAfterResponse`, because
 * a development instance identifies the browser by `__clerk_db_jwt` instead of
 * a cookie on the Frontend API domain. Production instances keep using cookies:
 * a SharedWorker request carries the same cookies as the page that owns it.
 */
function attachDevBrowser(clerk: Clerk, devBrowserJwt: string): void {
  let jwt = devBrowserJwt;
  clerk.__internal_onBeforeRequest((request) => {
    if (request.url) {
      request.url = withClerkDevBrowserJwt(request.url, jwt);
    }
  });
  clerk.__internal_onAfterResponse((_request, response) => {
    const rotated = response?.headers.get(CLERK_DEV_BROWSER_ROTATION_HEADER);
    if (rotated) {
      jwt = rotated;
    }
  });
}

export async function startClerkWorkerRuntime(
  devBrowserJwt: string | null,
): Promise<ClerkTokenSource> {
  const { publishableKey, satelliteConfig } = resolveClerkInstanceConfig();
  const clerk = new Clerk(
    publishableKey,
    satelliteConfig ? { domain: satelliteConfig.domain } : undefined,
  );
  if (devBrowserJwt) {
    attachDevBrowser(clerk, devBrowserJwt);
  }
  await clerk.load({
    standardBrowser: false,
    ...(satelliteConfig
      ? {
          isSatellite: satelliteConfig.isSatellite,
          satelliteAutoSync: satelliteConfig.satelliteAutoSync,
        }
      : {}),
  });
  return clerk;
}
