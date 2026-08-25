import { now } from "../../lib/time.ts";

/**
 * Open a Slack OAuth URL in a new tab.
 *
 * The timestamp defeats the browser cache, which otherwise replays a finished
 * redirect, and `?prompt=` is forwarded so the flow can carry it through to the
 * Slack DM greeting.
 */
export function openFreshOAuth(url: string) {
  const fresh = new URL(url, window.location.origin);
  const prompt = new URLSearchParams(window.location.search).get("prompt");
  if (prompt) {
    fresh.searchParams.set("prompt", prompt);
  }
  fresh.searchParams.set("_t", String(now()));
  window.open(fresh.toString(), "_blank");
}
