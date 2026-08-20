import type { AppRoute } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  apiNamespaceAliasPaths,
  brandedApiNamespace,
} from "@okouai/api-contracts/contracts/api-namespaces";
import type { SignalRouteHandler } from "./context/route";

export type { SignalRouteHandler };

export interface RouteEntry {
  readonly route: AppRoute;
  readonly handler: SignalRouteHandler<unknown>;
  /**
   * Set when this registration exists only because the blanket namespace
   * expansion derived it, and not because `LEGACY_ZERO_PATHS` lists it. Route
   * modules never set it; `withApiNamespaceAliases` is its only producer, and
   * `createAppWithRoutes` reads it to report the first request that arrives.
   */
  readonly viaNamespaceAliasFallback?: boolean;
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
 * the handler that already serves its branded path. Producers switch one at a
 * time in #28278 step 3, once the provider console holds the final URL; the
 * Teams OAuth callback switched in #28300 and the Feishu events URL we display
 * to operators in #28338. Every branded path here stays registered: removal is
 * gated on #26701.
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
 * The legacy `/api/zero/**` paths this service owes callers, keyed by the
 * canonical `/api/okou/**` path of the contract that serves them. This table
 * is the source of truth for Phase A compatibility from #26487: an entry here
 * is compatibility kept deliberately, rather than a derivation nobody can
 * audit.
 *
 * While the fallback below is still in place, a row is what separates a
 * deliberate legacy path from a reported one — removing a row makes that path
 * start reporting, not start 404ing. Reachability follows the table only once
 * #26701 removes the fallback; that is the slice where a deleted row also
 * retires the path.
 *
 * Keyed by path alone rather than by `METHOD path` like
 * `FINAL_PROVIDER_CONSOLE_PATHS`: the evidence below is a path template with
 * no method attached, so restricting an entry to the single method that
 * happened to appear inside a three-day window would 404 a caller's other
 * methods on the same path.
 *
 * The first group is every `/api/zero/**` path template that received a
 * request in `vm0-request-log-prod`, re-derived on 2026-08-20 over the whole
 * retained window. Some of the lowest-count rows are operator probes from the
 * #28356 investigation rather than real clients; they stay, because a dead
 * row costs one line and a missing row costs a real caller a 404.
 *
 * The second group is seeded regardless of measured traffic, because a
 * provider console — not a client we control — holds the URL.
 */
const LEGACY_ZERO_PATHS: Readonly<Record<string, string>> = {
  // Measured `/api/zero/**` traffic, most requests first.
  "/api/okou/realtime/token": "/api/zero/realtime/token",
  "/api/okou/computer-use/host/commands/next":
    "/api/zero/computer-use/host/commands/next",
  "/api/okou/computer-use/audit-events": "/api/zero/computer-use/audit-events",
  "/api/okou/computer-use/heartbeat": "/api/zero/computer-use/heartbeat",
  "/api/okou/slack/events": "/api/zero/slack/events",
  "/api/okou/org": "/api/zero/org",
  "/api/okou/connector-catalog/:connectorSlug/permissions":
    "/api/zero/connector-catalog/:connectorSlug/permissions",
  "/api/okou/slack/oauth/install": "/api/zero/slack/oauth/install",
  "/api/okou/host/deployments/:deploymentId/complete":
    "/api/zero/host/deployments/:deploymentId/complete",
  "/api/okou/host/deployments/prepare": "/api/zero/host/deployments/prepare",
  "/api/okou/uploads/prepare": "/api/zero/uploads/prepare",
  "/api/okou/uploads/complete": "/api/zero/uploads/complete",
  "/api/okou/recognize": "/api/zero/recognize",
  "/api/okou/web/download-file": "/api/zero/web/download-file",
  "/api/okou/teams/bot": "/api/zero/teams/bot",
  "/api/okou/logs": "/api/zero/logs",
  "/api/okou/agents/:id": "/api/zero/agents/:id",
  "/api/okou/agents/:id/user-connectors":
    "/api/zero/agents/:id/user-connectors",
  "/api/okou/scrape": "/api/zero/scrape",
  "/api/okou/connectors": "/api/zero/connectors",
  "/api/okou/host/sites/:publicSlug/files":
    "/api/zero/host/sites/:publicSlug/files",
  "/api/okou/billing/concurrency-checkout/preview":
    "/api/zero/billing/concurrency-checkout/preview",
  "/api/okou/feishu/events/:installationId":
    "/api/zero/feishu/events/:installationId",
  "/api/okou/computer-use/hosts/start": "/api/zero/computer-use/hosts/start",
  "/api/okou/logs/:id": "/api/zero/logs/:id",
  "/api/okou/mail/drafts/:mailDraftId": "/api/zero/mail/drafts/:mailDraftId",

  // Held by a provider console, so measured traffic cannot retire them. Every
  // branded path in `FINAL_PROVIDER_CONSOLE_PATHS` is listed, including the
  // Teams OAuth callback that the Microsoft app registration still points at
  // after #28300 — see the ordering constraint recorded on #26701.
  "/api/okou/teams/oauth/callback": "/api/zero/teams/oauth/callback",
  "/api/okou/slack/oauth/callback": "/api/zero/slack/oauth/callback",
  "/api/okou/feishu/oauth/callback": "/api/zero/feishu/oauth/callback",
  "/api/okou/slack/commands": "/api/zero/slack/commands",
  "/api/okou/slack/interactive": "/api/zero/slack/interactive",
};

interface BrandedPathForms {
  readonly canonical: string;
  readonly legacy: string;
}

/**
 * Splits a branded path into its canonical and legacy forms, so the table can
 * be keyed on the canonical path no matter which namespace the contract
 * happens to declare today.
 */
function brandedPathForms(path: string): BrandedPathForms | undefined {
  const aliases = apiNamespaceAliasPaths(path);
  const canonical = aliases.find((alias) => {
    return brandedApiNamespace(alias) === "okou";
  });
  const legacy = aliases.find((alias) => {
    return brandedApiNamespace(alias) === "zero";
  });
  if (canonical === undefined || legacy === undefined) {
    return undefined;
  }
  return { canonical, legacy };
}

/**
 * True when only the blanket expansion produces `aliasPath`: it is a legacy
 * path that no contract declares and `LEGACY_ZERO_PATHS` does not list.
 */
function isFallbackOnlyLegacyPath(
  declaredPath: string,
  aliasPath: string,
): boolean {
  if (aliasPath === declaredPath) {
    return false;
  }
  const forms = brandedPathForms(declaredPath);
  if (!forms || aliasPath !== forms.legacy) {
    return false;
  }
  return LEGACY_ZERO_PATHS[forms.canonical] !== aliasPath;
}

/**
 * Registers the legacy `/api/zero/**` paths named in `LEGACY_ZERO_PATHS`, and
 * keeps the blanket expansion behind them as a fallback so no path that
 * resolves today stops resolving.
 *
 * The fallback stays until #26701 can prove it is unused, which the request
 * log alone cannot do: it retains about three days, which cannot tell a
 * drained caller apart from a weekly one. Narrowing on that evidence would
 * silently 404 a real client, so instead every fallback-only registration is
 * marked and `createAppWithRoutes` reports the first request that reaches it.
 * That turns each gap in the table into a measurement rather than an outage.
 */
export function withApiNamespaceAliases(
  routes: readonly RouteEntry[],
): readonly RouteEntry[] {
  return routes.flatMap((entry) => {
    return apiNamespaceAliasPaths(entry.route.path).map((path) => {
      const alias = routeEntryWithPath(entry, path);
      if (!isFallbackOnlyLegacyPath(entry.route.path, path)) {
        return alias;
      }
      return { ...alias, viaNamespaceAliasFallback: true };
    });
  });
}

/**
 * The branded paths a migrated route still answers on, keyed by the neutral
 * canonical path its contract now declares.
 *
 * `LEGACY_ZERO_PATHS` cannot express this, which is why this is a second table
 * rather than more rows in that one. That table classifies which of the
 * `/api/zero/**` registrations the expansion above already produced are
 * intentional; this one decides which branded registrations exist at all.
 * `apiNamespaceAliasPaths` returns a neutral path unchanged, so once #28278
 * moves a contract off `/api/okou/**` the expansion produces no branded path
 * for it and neither branded path is registered any more — published CLI builds
 * still calling the branded path would get a 404 with nothing in either table
 * able to say otherwise.
 *
 * A migrated route generally owes both branded forms, so a value is a list
 * rather than a single path.
 *
 * The table ships empty. Each #28278 slice adds the rows for the paths it
 * moves, so a move and the compatibility it owes land in one commit.
 *
 * Every row is compatibility debt under the same removal gate as
 * `LEGACY_ZERO_PATHS`: a row is removed only under #26701's evidence rules. The
 * request log retains about three days, which by itself cannot prove a row is
 * drained — it cannot tell a caller that left from one that calls weekly.
 */
type MigratedBrandedPathTable = Readonly<Record<string, readonly string[]>>;

const MIGRATED_BRANDED_PATHS: Readonly<Record<string, readonly string[]>> = {
  // #28415. Published CLI builds poll generation status and post image
  // generations at the `okou` form — `getBuiltInGenerationStatus` and
  // `generateWebImage` build those URLs by hand rather than from the contract,
  // so they shipped independently of this path. The `zero` form was reachable
  // through the blanket expansion until the contract moved. Both are owed.
  //
  // Surface: a run context holding an older commit-addressed CLI package.
  // `CLI_PKG_URL` is chosen from the API's environment when the run is created,
  // so a run queued before this deploy keeps calling the branded path for the
  // queue lifetime plus its claimed execution, bounded by the runner's
  // `JOB_TIMEOUT` of 2 hours. Removable under #26701's evidence rules, the same
  // gate as `LEGACY_ZERO_PATHS` above.
  "/api/built-in-generations/:generationId": [
    "/api/okou/built-in-generations/:generationId",
    "/api/zero/built-in-generations/:generationId",
  ],
  "/api/image-io/generate": [
    "/api/okou/image-io/generate",
    "/api/zero/image-io/generate",
  ],
};

/**
 * Registers the branded paths named in `MIGRATED_BRANDED_PATHS`, so a contract
 * that has moved to its neutral path keeps serving the branded paths released
 * callers still hold.
 *
 * Applied after `withApiNamespaceAliases` and never before it: these paths are
 * finished registrations, and passing them back through the blanket expansion
 * would derive each one's sibling namespace a second time and register it
 * twice. Nothing produced here is marked `viaNamespaceAliasFallback` — a row is
 * a declared commitment rather than a gap the compatibility table missed, so it
 * must not reach the fallback report in `createAppWithRoutes`.
 */
export function withMigratedBrandedPaths(
  routes: readonly RouteEntry[],
  brandedPaths: MigratedBrandedPathTable = MIGRATED_BRANDED_PATHS,
): readonly RouteEntry[] {
  return routes.flatMap((entry) => {
    const migrated = brandedPaths[entry.route.path];
    if (migrated === undefined) {
      return [entry];
    }
    return [
      entry,
      ...migrated.map((path) => {
        return routeEntryWithPath(entry, path);
      }),
    ];
  });
}
