/**
 * Existing Next.js API routes in apps/web at the point web route growth was
 * frozen. New API routes should be implemented in apps/api instead.
 *
 * When a route is migrated out of apps/web, remove its entry here as part of
 * the same change. Do not add new entries; the no-new-api-routes rule checks
 * that this baseline only shrinks relative to the branch's git base.
 */
export const WEB_API_ROUTE_BASELINE = [
  "app/api/webhooks/agent/telemetry/route.ts",
  "app/api/webhooks/agent/usage-event/route.ts",
  "app/api/webhooks/clerk/route.ts",
  "app/api/webhooks/github/route.ts",
  "app/api/webhooks/stripe/route.ts",
  "app/api/zero/feature-switches/route.ts",
  "app/api/zero/integrations/slack/route.ts",
  "app/api/zero/integrations/slack/upload-file/complete/route.ts",
  "app/api/zero/integrations/slack/upload-file/init/route.ts",
] as const;

export const WEB_API_ROUTE_BASELINE_SET = new Set<string>(
  WEB_API_ROUTE_BASELINE,
);
