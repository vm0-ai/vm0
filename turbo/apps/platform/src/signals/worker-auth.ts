import { computed } from "ccstate";

import { CLERK_DEV_BROWSER_NAME } from "../lib/clerk-dev-browser.ts";
import { startClerkWorkerRuntime } from "../lib/clerk-worker-runtime.ts";

export const clerk$ = computed(() => {
  // Only a development instance needs the dev browser JWT, and only a page can
  // read it, so the tab that starts the Worker passes it on the Worker URL.
  const devBrowserJwt = new URL(location.href).searchParams.get(
    CLERK_DEV_BROWSER_NAME,
  );
  return startClerkWorkerRuntime(devBrowserJwt);
});
