import "./instrument";
import { createApp } from "./app-factory";

// IMPORTANT — VERCEL ENTRY POINT.
//
// This file is the build entry for `@hono/vite-build/vercel` (see
// `vite.config.ts`). It MUST NOT register any WebSocket route, because
// Vercel functions never receive the WS upgrade handshake — the upgrade
// fails before the function ever runs and any registered WS handler is
// dead code on this path.
//
// The realtime relay's WS endpoint lives in the long-lived runtime started
// by `server.ts` (used by `pnpm start` / `pnpm dev` / tests / non-Vercel
// hosts). See `createAppWithWebSocket` in `app-factory.ts`. Production
// rollout of the relay is gated behind Epic #12128 Open Question #1
// (production deploy target for apps/api) and the `VoiceChatRealtimeBilling`
// feature switch (default OFF) — no end-user traffic reaches the relay
// route on Vercel.
//
// On the Vercel deployment, requests to `/api/zero/voice-chat/relay` 404
// cleanly via the standard `notFound` proxy in `createApp`.

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
