// Long-lived Node server entry point. Used by `pnpm dev` (tsx watch) and
// `pnpm start`. Distinct from `./index.ts`, which is the Vercel-function
// entry built by `@hono/vite-build/vercel`.

import "./instrument";

import { serve } from "@hono/node-server";

import { createApp } from "./app-factory";
import { logger } from "./lib/log";

function main(): void {
  const L = logger("Server");
  const instanceAbortController = new AbortController();

  process.once("SIGTERM", () => {
    const error = new Error("Aborted due to terminated function instance");
    error.name = "AbortError";
    instanceAbortController.abort(error);
  });

  const app = createApp({ signal: instanceAbortController.signal });

  serve(
    {
      fetch: app.fetch,
      port: 3001,
    },
    (info) => {
      L.debug(`Server is running on http://localhost:${info.port}`);
    },
  );
}

main();
