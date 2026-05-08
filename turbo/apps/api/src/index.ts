import "./instrument";
import { createApp } from "./app-factory";

// Vercel function entry point built by `@hono/vite-build/vercel` (see
// `vite.config.ts`). Distinct from `./server.ts`, which is the long-lived
// Node entry used by `pnpm dev` / `pnpm start`. Vercel can't host the
// realtime relay WebSocket — Epic #12128 pivoted to Plan D (browser-direct
// to OpenAI), and the WS scaffolding has since been retired.

const app = (() => {
  const instanceAbortController = new AbortController();

  process.once("SIGTERM", () => {
    const error = new Error("Aborted due to terminated function instance");
    error.name = "AbortError";
    instanceAbortController.abort(error);
  });

  return createApp({ signal: instanceAbortController.signal });
})();

export default app;
