import type { AppRoute } from "@okouai/api-contracts/contracts/trpc-contract";
import { apiNamespaceAliasPaths } from "@okouai/api-contracts/contracts/api-namespaces";
import type { SignalRouteHandler } from "./context/route";

export type { SignalRouteHandler };

export interface RouteEntry {
  readonly route: AppRoute;
  readonly handler: SignalRouteHandler<unknown>;
}

function routeRegistrationKey(entry: RouteEntry): string {
  return `${entry.route.method} ${entry.route.path}`;
}

export function assertUniqueRouteRegistrations(
  routes: readonly RouteEntry[],
): void {
  const keys = new Set<string>();
  for (const entry of routes) {
    const key = routeRegistrationKey(entry);
    if (keys.has(key)) {
      throw new Error(`Duplicate API route registration: ${key}`);
    }
    keys.add(key);
  }
}

function routeEntryWithPath(entry: RouteEntry, path: string): RouteEntry {
  if (path === entry.route.path) {
    return entry;
  }
  return {
    route: { ...entry.route, path },
    handler: entry.handler,
  };
}

/**
 * Final paths that the Feishu, Slack, and Microsoft consoles hold after #28278
 * Stage 0, keyed by the branded path that serves them today. OAuth callbacks
 * join `/api/integrations/**` beside the IM connect routes, and inbound
 * webhooks join `/api/webhooks/**` beside the other providers.
 *
 * Step 1 only makes these paths routable: each one adds a second way to reach
 * the handler that already serves its branded path. No producer emits a final
 * URL yet, so switching them is #28278 step 3, after the consoles are updated.
 */
const FINAL_PROVIDER_CONSOLE_PATHS: Readonly<Record<string, string>> = {
  "GET /api/okou/slack/oauth/callback":
    "/api/integrations/slack/oauth/callback",
  "GET /api/okou/teams/oauth/callback":
    "/api/integrations/teams/oauth/callback",
  "GET /api/okou/feishu/oauth/callback":
    "/api/integrations/feishu/oauth/callback",
  "POST /api/okou/slack/events": "/api/webhooks/slack/events",
  "POST /api/okou/slack/commands": "/api/webhooks/slack/commands",
  "POST /api/okou/slack/interactive": "/api/webhooks/slack/interactive",
  "POST /api/okou/teams/bot": "/api/webhooks/teams/bot",
  "POST /api/okou/feishu/events/:installationId":
    "/api/webhooks/feishu/events/:installationId",
};

/**
 * Adds the eight final provider console paths. Unlike the namespace aliases
 * below, this expands an explicit list and never derives a path, so no other
 * route gains a second registration.
 */
export function withFinalProviderConsolePaths(
  routes: readonly RouteEntry[],
): readonly RouteEntry[] {
  return routes.flatMap((entry) => {
    const finalPath = FINAL_PROVIDER_CONSOLE_PATHS[routeRegistrationKey(entry)];
    if (finalPath === undefined) {
      return [entry];
    }
    return [entry, routeEntryWithPath(entry, finalPath)];
  });
}

/**
 * Phase A compatibility for #26487. Remove only in a separately authorized
 * cleanup after legacy Platform, CLI, runner, Desktop, and stored callback
 * callers have drained, production telemetry confirms no Zero dependency,
 * and rollback no longer targets a release that requires /api/zero/**.
 */
export function withApiNamespaceAliases(
  routes: readonly RouteEntry[],
): readonly RouteEntry[] {
  return routes.flatMap((entry) => {
    return apiNamespaceAliasPaths(entry.route.path).map((path) => {
      return routeEntryWithPath(entry, path);
    });
  });
}
