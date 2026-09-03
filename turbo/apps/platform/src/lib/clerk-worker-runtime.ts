import { Clerk } from "@clerk/clerk-js/no-rhc";

import {
  CLERK_DEV_BROWSER_ROTATION_HEADER,
  withClerkDevBrowserJwt,
} from "./clerk-dev-browser.ts";
import { resolveClerkProductionSatelliteDomain } from "./clerk-production-topology.ts";
import { resolvePlatformRuntimeConfig } from "./platform-host.ts";
import type { ClerkTokenSource } from "../signals/clerk-token.ts";

export interface ClerkWorkerRuntimeOptions {
  readonly devBrowserJwt: string | null;
  /**
   * The deployment's Clerk primary app domain as the tab read it from
   * index.html. Unknown values fail closed to the current topology.
   */
  readonly productionPrimaryAppDomain: string | null;
}

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
  options: ClerkWorkerRuntimeOptions,
): Promise<ClerkTokenSource> {
  const satelliteDomain = resolveClerkProductionSatelliteDomain(
    location.hostname,
    options.productionPrimaryAppDomain,
  );
  // clerk-js derives the Frontend API host from `domain` as given whenever
  // `window` is undefined: the `clerk.` prefix the page gets for free is only
  // added in a browser scope. Without it a satellite Worker sends every Clerk
  // request to the app origin itself. The satellite load options are likewise
  // ignored in a Worker, so only the host is passed.
  const clerk = new Clerk(
    resolvePlatformRuntimeConfig().clerkPublishableKey,
    satelliteDomain ? { domain: `clerk.${satelliteDomain}` } : undefined,
  );
  if (options.devBrowserJwt) {
    attachDevBrowser(clerk, options.devBrowserJwt);
  }
  await clerk.load({ standardBrowser: false });
  return clerk;
}
