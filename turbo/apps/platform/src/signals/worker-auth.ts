import { command } from "ccstate";

import { isDevelopmentClerkInstance } from "../lib/clerk-dev-browser.ts";
import { resolveClerkInstanceConfig } from "../lib/clerk-instance-config.ts";
import { startClerkWorkerRuntime } from "../lib/clerk-worker-runtime.ts";
import { awaitWorkerDevBrowserJwt$ } from "../shared-database/worker-dev-browser.ts";
import type { ClerkTokenSource } from "./clerk-token.ts";

export const startWorkerClerk$ = command(
  async ({ set }, signal: AbortSignal): Promise<ClerkTokenSource> => {
    const { publishableKey } = resolveClerkInstanceConfig();
    if (!isDevelopmentClerkInstance(publishableKey)) {
      return startClerkWorkerRuntime(null);
    }
    // A development instance rejects the Worker until it presents the page's
    // dev browser JWT, so Clerk only starts once the first tab hands it over.
    const devBrowserJwt = set(awaitWorkerDevBrowserJwt$, signal);
    return startClerkWorkerRuntime(await devBrowserJwt);
  },
);
