"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { posthog } from "posthog-js";
import { env } from "../../src/env";

// Marketing-site PostHog is shared with app.vm0.ai via a parent-domain cookie
// on `.vm0.ai`, so a visitor's anonymous distinct_id carries across vm0.ai →
// app.vm0.ai. When the app side calls posthog.identify() at signup, PostHog
// links the marketing-site session to the resulting user — giving us
// per-channel signup attribution that Plausible cannot provide on its own.

const POSTHOG_KEY = env().NEXT_PUBLIC_POSTHOG_KEY;

let initialized = false;

function ensureInitialized(): void {
  if (initialized || !POSTHOG_KEY) {
    return;
  }
  posthog.init(POSTHOG_KEY, {
    // First-party reverse proxy (Cloudflare-fronted): forwards /static assets,
    // /flags and ingest to PostHog US so ad blockers do not drop events.
    // Shared with so.vm0.ai for one ingest domain. The legacy /ingest
    // next.config rewrite is now unused and can be removed in a follow-up.
    api_host: "https://j.vm0.ai",
    ui_host: "https://us.posthog.com",
    autocapture: false,
    // Manual $pageview is required for the App Router because the SDK's
    // built-in pageview hook fires on full document loads only.
    capture_pageview: false,
    disable_session_recording: true,
    persistence: "localStorage+cookie",
    // Default is true in posthog-js, but pinning here documents the cross-
    // subdomain behavior the funnel attribution relies on.
    cross_subdomain_cookie: true,
    sanitize_properties(properties, _event) {
      if (properties?.$current_url) {
        properties["$current_url"] = properties["$current_url"].replace(
          /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
          "/:id",
        );
      }
      return properties;
    },
  });
  initialized = true;
}

export function capturePostHogEvent(
  eventName: string,
  properties?: Record<string, unknown>,
): void {
  ensureInitialized();
  if (!POSTHOG_KEY) {
    return;
  }
  posthog.capture(eventName, properties);
}

export function PostHogProvider() {
  const pathname = usePathname();

  useEffect(() => {
    ensureInitialized();
    if (!POSTHOG_KEY) {
      return;
    }
    posthog.capture("$pageview");
  }, [pathname]);

  return null;
}
