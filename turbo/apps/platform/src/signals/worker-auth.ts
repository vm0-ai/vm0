import { computed } from "ccstate";

import { CLERK_DEV_BROWSER_NAME } from "../lib/clerk-dev-browser.ts";
import { CLERK_PRIMARY_APP_DOMAIN_PARAM } from "../lib/clerk-primary-app-domain-param.ts";
import { startClerkWorkerRuntime } from "../lib/clerk-worker-runtime.ts";

export const clerk$ = computed(() => {
  // Only a page can read the dev browser JWT (a development instance needs
  // it) and the deployment's primary app domain, so the tab that starts the
  // Worker passes both on the Worker URL.
  const params = new URL(location.href).searchParams;
  return startClerkWorkerRuntime({
    devBrowserJwt: params.get(CLERK_DEV_BROWSER_NAME),
    productionPrimaryAppDomain: params.get(CLERK_PRIMARY_APP_DOMAIN_PARAM),
  });
});
