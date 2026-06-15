/**
 * Existing Next.js API routes in apps/web at the point web route growth was
 * frozen. New API routes should be implemented in apps/api instead.
 *
 * When a route is migrated out of apps/web, remove its entry here as part of
 * the same change. Do not add new entries; the no-new-api-routes rule checks
 * that this baseline only shrinks relative to the branch's git base.
 */
export const WEB_API_ROUTE_BASELINE = [] as const;

export const WEB_API_ROUTE_BASELINE_SET = new Set<string>(
  WEB_API_ROUTE_BASELINE,
);
