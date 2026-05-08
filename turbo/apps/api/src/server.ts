// Long-lived Node server entry point. Used by `pnpm dev` (tsx watch) and
// `pnpm start`. Distinct from `./index.ts`, which is the Vercel-function
// entry built by `@hono/vite-build/vercel` — that path can never host the
// WS relay because Vercel functions don't pass through the WS upgrade
// handshake.
//
// `injectWebSocket` attaches the @hono/node-ws WebSocketServer to the Node
// http server's `upgrade` event, enabling the relay endpoint registered by
// `createAppWithWebSocket`.

import "./instrument";

import { serve } from "@hono/node-server";

import { createAppWithWebSocket } from "./app-factory";
import { logger } from "./lib/log";

function main(): void {
  const L = logger("Server");
  const instanceAbortController = new AbortController();

  process.once("SIGTERM", () => {
    const error = new Error("Aborted due to terminated function instance");
    error.name = "AbortError";
    instanceAbortController.abort(error);
  });

  const { app, injectWebSocket } = createAppWithWebSocket({
    signal: instanceAbortController.signal,
  });

  const server = serve(
    {
      fetch: app.fetch,
      port: 3001,
    },
    (info) => {
      L.debug(`Server is running on http://localhost:${info.port}`);
    },
  );

  injectWebSocket(server);
}

main();
