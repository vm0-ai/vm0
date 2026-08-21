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
 * Each #28278 slice adds the rows for the paths it moves, so a move and the
 * compatibility it owes land in one commit.
 *
 * Every row is compatibility debt under the same removal gate as
 * `LEGACY_ZERO_PATHS`: a row is removed only under #26701's evidence rules. The
 * request log retains about three days, which by itself cannot prove a row is
 * drained — it cannot tell a caller that left from one that calls weekly.
 *
 * The surfaces a row holds open, and the window each one bounds: an open web or
 * app page keeps the bundle it loaded for about two days, and an execution
 * context pins its commit-addressed CLI package at creation, so a run queued
 * before this deploy can still start the older CLI and hold it for the two-hour
 * `JOB_TIMEOUT` drain. An installed CLI or desktop build has no window at all,
 * which is why removal is gated on #26701's request-log evidence rather than on
 * a date.
 */
type MigratedBrandedPathTable = Readonly<Record<string, readonly string[]>>;

const MIGRATED_BRANDED_PATHS: Readonly<Record<string, readonly string[]>> = {
  // #28417. Published CLI builds post to the `okou` form — `callMaps` builds
  // the URL by hand rather than from the contract, so the path it holds shipped
  // independently of this table — and the `zero` form was reachable through the
  // blanket expansion until the contract moved. Both are owed.
  //
  // Surface: commit-addressed CLI packages, not web clients. A run execution
  // context pins `CLI_PKG_URL` when it is created and keeps that artifact after
  // a later API deploy, so the exposure is the context drain described in
  // `docs/deployment-compatibility.md` — maximum queue lifetime plus maximum
  // claimed execution and finalization lifetime, with execution bounded by the
  // runner's 2h `JOB_TIMEOUT` — rather than the ~2 day web-client window. That
  // drain is the floor for removal, not the condition: these rows retire under
  // #26701's evidence rules like every other row in this file.
  "/api/maps/geocode": ["/api/okou/maps/geocode", "/api/zero/maps/geocode"],
  "/api/maps/reverse-geocode": [
    "/api/okou/maps/reverse-geocode",
    "/api/zero/maps/reverse-geocode",
  ],
  "/api/maps/directions": [
    "/api/okou/maps/directions",
    "/api/zero/maps/directions",
  ],
  "/api/maps/places/search": [
    "/api/okou/maps/places/search",
    "/api/zero/maps/places/search",
  ],
  "/api/maps/places/details": [
    "/api/okou/maps/places/details",
    "/api/zero/maps/places/details",
  ],
  "/api/maps/osm/download": [
    "/api/okou/maps/osm/download",
    "/api/zero/maps/osm/download",
  ],
  "/api/maps/osm/render": [
    "/api/okou/maps/osm/render",
    "/api/zero/maps/osm/render",
  ],
  // #28421: personal model providers, onboarding, team, and user preferences.
  "/api/me/model-provider-accounts/:id": [
    "/api/okou/me/model-provider-accounts/:id",
    "/api/zero/me/model-provider-accounts/:id",
  ],
  "/api/me/model-provider-accounts/:id/activate": [
    "/api/okou/me/model-provider-accounts/:id/activate",
    "/api/zero/me/model-provider-accounts/:id/activate",
  ],
  "/api/me/model-provider-accounts/:id/subscription-reset": [
    "/api/okou/me/model-provider-accounts/:id/subscription-reset",
    "/api/zero/me/model-provider-accounts/:id/subscription-reset",
  ],
  "/api/me/model-providers": [
    "/api/okou/me/model-providers",
    "/api/zero/me/model-providers",
  ],
  "/api/me/model-providers/:type": [
    "/api/okou/me/model-providers/:type",
    "/api/zero/me/model-providers/:type",
  ],
  "/api/me/model-providers/:type/subscription-reset": [
    "/api/okou/me/model-providers/:type/subscription-reset",
    "/api/zero/me/model-providers/:type/subscription-reset",
  ],
  "/api/onboarding/complete": [
    "/api/okou/onboarding/complete",
    "/api/zero/onboarding/complete",
  ],
  "/api/onboarding/status": [
    "/api/okou/onboarding/status",
    "/api/zero/onboarding/status",
  ],
  "/api/team": ["/api/okou/team", "/api/zero/team"],
  "/api/user-model-preference": [
    "/api/okou/user-model-preference",
    "/api/zero/user-model-preference",
  ],
  "/api/user-preferences": [
    "/api/okou/user-preferences",
    "/api/zero/user-preferences",
  ],
  // #28357, the first #28278 slice. Published CLI builds post to the `okou`
  // form (`callWeather` built it by hand rather than from the contract, so it
  // shipped independently of this path), and the `zero` form was reachable
  // through the blanket expansion until the contract moved. Both are owed.
  //
  // Surface: commit-addressed CLI packages pinned by run contexts created
  // before this deploy, so the branded form outlives the deploy by the queue
  // and claimed-execution drain — up to the 2h runner/sandbox window — plus any
  // external holder of the `zero` brand path, which has no time box. Removal
  // therefore follows the table's #26701 evidence gate above, not a clock.
  "/api/weather/current": [
    "/api/okou/weather/current",
    "/api/zero/weather/current",
  ],
  "/api/weather/forecast/hourly": [
    "/api/okou/weather/forecast/hourly",
    "/api/zero/weather/forecast/hourly",
  ],
  "/api/weather/forecast/daily": [
    "/api/okou/weather/forecast/daily",
    "/api/zero/weather/forecast/daily",
  ],
  "/api/weather/history/hourly": [
    "/api/okou/weather/history/hourly",
    "/api/zero/weather/history/hourly",
  ],
  "/api/weather/air-quality/current": [
    "/api/okou/weather/air-quality/current",
    "/api/zero/weather/air-quality/current",
  ],
  // #28418: the browser, finance, SEO, and MCP connector routes. The callers
  // these rows keep working are a released web or app client, which holds the
  // branded path until a refresh loads a build that derives the neutral one
  // (~2 days), and a CLI artifact pinned by an execution context's
  // `CLI_PKG_URL`, which holds it for that context's queue and claimed-run
  // lifetime. Neither window is the removal condition on its own: a row is
  // removed under #26701's evidence rules, because the request log retains
  // about three days and cannot tell a drained caller from a weekly one.
  "/api/browsers": ["/api/okou/browsers", "/api/zero/browsers"],
  "/api/browsers/current": [
    "/api/okou/browsers/current",
    "/api/zero/browsers/current",
  ],
  "/api/browsers/lease": [
    "/api/okou/browsers/lease",
    "/api/zero/browsers/lease",
  ],
  "/api/browsers/use": ["/api/okou/browsers/use", "/api/zero/browsers/use"],
  "/api/finance/chart": ["/api/okou/finance/chart", "/api/zero/finance/chart"],
  "/api/finance/profile": [
    "/api/okou/finance/profile",
    "/api/zero/finance/profile",
  ],
  "/api/finance/quote": ["/api/okou/finance/quote", "/api/zero/finance/quote"],
  "/api/finance/search": [
    "/api/okou/finance/search",
    "/api/zero/finance/search",
  ],
  "/api/mcp-connectors": [
    "/api/okou/mcp-connectors",
    "/api/zero/mcp-connectors",
  ],
  "/api/seo/backlinks-summary": [
    "/api/okou/seo/backlinks-summary",
    "/api/zero/seo/backlinks-summary",
  ],
  "/api/seo/keyword-ideas": [
    "/api/okou/seo/keyword-ideas",
    "/api/zero/seo/keyword-ideas",
  ],
  "/api/seo/ranked-keywords": [
    "/api/okou/seo/ranked-keywords",
    "/api/zero/seo/ranked-keywords",
  ],
  "/api/seo/serp": ["/api/okou/seo/serp", "/api/zero/seo/serp"],
  // #28415. Published CLI builds poll generation status and post image
  // generations at the `okou` form — `getBuiltInGenerationStatus` and
  // `generateWebImage` build those URLs by hand rather than from the contract,
  // so they shipped independently of this path. The `zero` form was reachable
  // through the blanket expansion until the contract moved. Both are owed.
  //
  // Same surface as the rows above: commit-addressed CLI packages pinned by run
  // contexts created before this deploy, draining over the queue lifetime plus
  // claimed execution bounded by the runner's 2h `JOB_TIMEOUT`. Removal follows
  // the table's #26701 evidence gate, not that clock.
  "/api/built-in-generations/:generationId": [
    "/api/okou/built-in-generations/:generationId",
    "/api/zero/built-in-generations/:generationId",
  ],
  "/api/image-io/generate": [
    "/api/okou/image-io/generate",
    "/api/zero/image-io/generate",
  ],
  // #28416. Every consumer of these four derives its URL from the contract, so
  // no caller hardcodes the branded form — but a published CLI package embeds
  // the contract path it was built from, and the `zero` form was reachable
  // through the blanket expansion until the contract moved. Both are owed.
  //
  // Surface: commit-addressed CLI packages pinned by execution contexts created
  // before this deploy, bounded by the queue lifetime plus the runner's 2h
  // `JOB_TIMEOUT` drain, plus any external holder of the `zero` form, which has
  // no window. Removal follows the #26701 evidence gate above, not a date.
  "/api/recognize": ["/api/okou/recognize", "/api/zero/recognize"],
  "/api/scrape": ["/api/okou/scrape", "/api/zero/scrape"],
  "/api/translate": ["/api/okou/translate", "/api/zero/translate"],
  "/api/web-search": ["/api/okou/web-search", "/api/zero/web-search"],
  // #28419. The goal and hosted-site contracts. `domains/host.ts` builds its
  // four URLs by hand rather than from the contract, so a published CLI holds
  // the `okou` form independently of this table; the `zero` form was reachable
  // through the blanket expansion until the contract moved. Both are owed, on
  // the same commit-addressed CLI drain described above.
  //
  // A key holds its path parameter verbatim, because the lookup below matches
  // `entry.route.path` exactly rather than an expanded request path.
  "/api/goal": ["/api/okou/goal", "/api/zero/goal"],
  "/api/goal/block": ["/api/okou/goal/block", "/api/zero/goal/block"],
  "/api/goal/complete": ["/api/okou/goal/complete", "/api/zero/goal/complete"],
  "/api/goal/pause": ["/api/okou/goal/pause", "/api/zero/goal/pause"],
  "/api/goal/resume": ["/api/okou/goal/resume", "/api/zero/goal/resume"],
  "/api/host/deployments/:deploymentId/complete": [
    "/api/okou/host/deployments/:deploymentId/complete",
    "/api/zero/host/deployments/:deploymentId/complete",
  ],
  "/api/host/deployments/prepare": [
    "/api/okou/host/deployments/prepare",
    "/api/zero/host/deployments/prepare",
  ],
  "/api/host/sites/:publicSlug/files": [
    "/api/okou/host/sites/:publicSlug/files",
    "/api/zero/host/sites/:publicSlug/files",
  ],
  "/api/host/sites/:site/deployments": [
    "/api/okou/host/sites/:site/deployments",
    "/api/zero/host/sites/:site/deployments",
  ],
  // #28420. Every caller of these five derives its URL from the contract, so
  // nothing in this repository still asks for a branded form. Released builds
  // do: a browser tab holding already-loaded platform code keeps calling the
  // `okou` path it was built against until it navigates or reloads, which is
  // the ~2 day old-web-client window in `docs/fallback.md` section 7. The
  // `zero` form was reachable through the blanket expansion until the contract
  // moved. Both are owed, and both are removable only under #26701's evidence
  // rules, like every other row in this table.
  "/api/attribution/signup": [
    "/api/okou/attribution/signup",
    "/api/zero/attribution/signup",
  ],
  "/api/chat-thread-drafts": [
    "/api/okou/chat-thread-drafts",
    "/api/zero/chat-thread-drafts",
  ],
  "/api/chat-thread-unreads": [
    "/api/okou/chat-thread-unreads",
    "/api/zero/chat-thread-unreads",
  ],
  "/api/chat-thread-unreads/mark-read": [
    "/api/okou/chat-thread-unreads/mark-read",
    "/api/zero/chat-thread-unreads/mark-read",
  ],
  "/api/indicators": ["/api/okou/indicators", "/api/zero/indicators"],
  // #28422: artifact catalog, logs, push subscriptions, the platform realtime
  // token, and the run reads.
  "/api/artifacts/catalog": [
    "/api/okou/artifacts/catalog",
    "/api/zero/artifacts/catalog",
  ],
  "/api/artifacts/catalog/:artifactId": [
    "/api/okou/artifacts/catalog/:artifactId",
    "/api/zero/artifacts/catalog/:artifactId",
  ],
  "/api/logs": ["/api/okou/logs", "/api/zero/logs"],
  "/api/logs/:id": ["/api/okou/logs/:id", "/api/zero/logs/:id"],
  "/api/push-subscriptions": [
    "/api/okou/push-subscriptions",
    "/api/zero/push-subscriptions",
  ],
  "/api/realtime/token": [
    "/api/okou/realtime/token",
    "/api/zero/realtime/token",
  ],
  "/api/runs/:id": ["/api/okou/runs/:id", "/api/zero/runs/:id"],
  "/api/runs/:id/cancel": [
    "/api/okou/runs/:id/cancel",
    "/api/zero/runs/:id/cancel",
  ],
  "/api/runs/:id/context": [
    "/api/okou/runs/:id/context",
    "/api/zero/runs/:id/context",
  ],
  "/api/runs/:id/network": [
    "/api/okou/runs/:id/network",
    "/api/zero/runs/:id/network",
  ],
  "/api/runs/:id/runner": [
    "/api/okou/runs/:id/runner",
    "/api/zero/runs/:id/runner",
  ],
  "/api/runs/:id/telemetry/agent": [
    "/api/okou/runs/:id/telemetry/agent",
    "/api/zero/runs/:id/telemetry/agent",
  ],
  "/api/runs/queue": ["/api/okou/runs/queue", "/api/zero/runs/queue"],
  // #28459: the chat threads themselves, the chat event and search readers,
  // shared threads, per-thread browser sessions, per-thread goals, workflow
  // automations, queue position, and the X image share. Every caller in this
  // repository derives its URL from the contract, so nothing here still asks
  // for a branded form. Released builds do: a browser tab holding
  // already-loaded platform code keeps calling the `okou` path it was built
  // against until it navigates or reloads, the ~2 day old-web-client window in
  // `docs/fallback.md` section 7; a commit-addressed CLI package pinned by an
  // execution context's `CLI_PKG_URL` holds it for that context's queue and
  // claimed-run lifetime; and the `okou-app` share worker deployed to
  // Cloudflare Pages reads `shared-threads/:id/meta` from a build that ships
  // separately from this one. The `zero` form was reachable through the
  // blanket expansion until the contract moved. All of it is owed, and a row
  // retires under #26701's evidence rules rather than on any of those clocks.
  //
  // A key holds its path parameter verbatim, because the lookup below matches
  // `entry.route.path` exactly rather than an expanded request path.
  "/api/chat-threads": ["/api/okou/chat-threads", "/api/zero/chat-threads"],
  "/api/chat-threads/:id": [
    "/api/okou/chat-threads/:id",
    "/api/zero/chat-threads/:id",
  ],
  "/api/chat-threads/:id/computer-use-host": [
    "/api/okou/chat-threads/:id/computer-use-host",
    "/api/zero/chat-threads/:id/computer-use-host",
  ],
  "/api/chat-threads/:id/connector-selections": [
    "/api/okou/chat-threads/:id/connector-selections",
    "/api/zero/chat-threads/:id/connector-selections",
  ],
  "/api/chat-threads/:id/draft": [
    "/api/okou/chat-threads/:id/draft",
    "/api/zero/chat-threads/:id/draft",
  ],
  "/api/chat-threads/:id/image-model": [
    "/api/okou/chat-threads/:id/image-model",
    "/api/zero/chat-threads/:id/image-model",
  ],
  "/api/chat-threads/:id/mark-read": [
    "/api/okou/chat-threads/:id/mark-read",
    "/api/zero/chat-threads/:id/mark-read",
  ],
  "/api/chat-threads/:id/mark-unread": [
    "/api/okou/chat-threads/:id/mark-unread",
    "/api/zero/chat-threads/:id/mark-unread",
  ],
  "/api/chat-threads/:id/metadata": [
    "/api/okou/chat-threads/:id/metadata",
    "/api/zero/chat-threads/:id/metadata",
  ],
  "/api/chat-threads/:id/model-selection": [
    "/api/okou/chat-threads/:id/model-selection",
    "/api/zero/chat-threads/:id/model-selection",
  ],
  "/api/chat-threads/:id/pin": [
    "/api/okou/chat-threads/:id/pin",
    "/api/zero/chat-threads/:id/pin",
  ],
  "/api/chat-threads/:id/rename": [
    "/api/okou/chat-threads/:id/rename",
    "/api/zero/chat-threads/:id/rename",
  ],
  "/api/chat-threads/:id/unpin": [
    "/api/okou/chat-threads/:id/unpin",
    "/api/zero/chat-threads/:id/unpin",
  ],
  "/api/chat-threads/:id/video-model": [
    "/api/okou/chat-threads/:id/video-model",
    "/api/zero/chat-threads/:id/video-model",
  ],
  "/api/chat-threads/:threadId/artifacts": [
    "/api/okou/chat-threads/:threadId/artifacts",
    "/api/zero/chat-threads/:threadId/artifacts",
  ],
  "/api/chat-threads/:threadId/browser": [
    "/api/okou/chat-threads/:threadId/browser",
    "/api/zero/chat-threads/:threadId/browser",
  ],
  "/api/chat-threads/:threadId/browser/close": [
    "/api/okou/chat-threads/:threadId/browser/close",
    "/api/zero/chat-threads/:threadId/browser/close",
  ],
  "/api/chat-threads/:threadId/browser/lease": [
    "/api/okou/chat-threads/:threadId/browser/lease",
    "/api/zero/chat-threads/:threadId/browser/lease",
  ],
  "/api/chat-threads/:threadId/browser/open": [
    "/api/okou/chat-threads/:threadId/browser/open",
    "/api/zero/chat-threads/:threadId/browser/open",
  ],
  "/api/chat-threads/:threadId/browser/resize": [
    "/api/okou/chat-threads/:threadId/browser/resize",
    "/api/zero/chat-threads/:threadId/browser/resize",
  ],
  "/api/chat-threads/:threadId/event-rows": [
    "/api/okou/chat-threads/:threadId/event-rows",
    "/api/zero/chat-threads/:threadId/event-rows",
  ],
  "/api/chat-threads/:threadId/event-snapshot": [
    "/api/okou/chat-threads/:threadId/event-snapshot",
    "/api/zero/chat-threads/:threadId/event-snapshot",
  ],
  "/api/chat-threads/:threadId/goal": [
    "/api/okou/chat-threads/:threadId/goal",
    "/api/zero/chat-threads/:threadId/goal",
  ],
  "/api/chat-threads/:threadId/goal/pause": [
    "/api/okou/chat-threads/:threadId/goal/pause",
    "/api/zero/chat-threads/:threadId/goal/pause",
  ],
  "/api/chat-threads/:threadId/shared-threads": [
    "/api/okou/chat-threads/:threadId/shared-threads",
    "/api/zero/chat-threads/:threadId/shared-threads",
  ],
  "/api/chat-threads/:threadId/workflow-automations": [
    "/api/okou/chat-threads/:threadId/workflow-automations",
    "/api/zero/chat-threads/:threadId/workflow-automations",
  ],
  "/api/chat-threads/events": [
    "/api/okou/chat-threads/events",
    "/api/zero/chat-threads/events",
  ],
  "/api/chat-threads/snapshot": [
    "/api/okou/chat-threads/snapshot",
    "/api/zero/chat-threads/snapshot",
  ],
  "/api/chat/events": ["/api/okou/chat/events", "/api/zero/chat/events"],
  "/api/chat/search": ["/api/okou/chat/search", "/api/zero/chat/search"],
  "/api/image-share/x": ["/api/okou/image-share/x", "/api/zero/image-share/x"],
  "/api/queue-position": [
    "/api/okou/queue-position",
    "/api/zero/queue-position",
  ],
  "/api/shared-threads/:id": [
    "/api/okou/shared-threads/:id",
    "/api/zero/shared-threads/:id",
  ],
  "/api/shared-threads/:id/meta": [
    "/api/okou/shared-threads/:id/meta",
    "/api/zero/shared-threads/:id/meta",
  ],
  // #28457: the billing surface — plan and usage-pack checkout, concurrency
  // subscriptions, credit purchase, the Stripe portal, invoices, and code
  // redemption. Every caller derives its URL from the contract, so nothing in
  // this repository asks for a branded form, but released builds still do: an
  // already-loaded platform tab keeps calling the `okou` path it was built
  // against for the ~2 day old-web-client window in `docs/fallback.md` section
  // 7, and a CLI package pinned by an execution context's `CLI_PKG_URL` embeds
  // the contract path it was built from for that context's queue and claimed-run
  // lifetime. The `zero` form was reachable through the blanket expansion until
  // the contract moved, and `/api/zero/billing/concurrency-checkout/preview` is
  // measured traffic in `LEGACY_ZERO_PATHS`, so it is owed by evidence rather
  // than by symmetry. Both forms are removable only under #26701's evidence
  // rules, like every other row in this table.
  "/api/billing/auto-recharge": [
    "/api/okou/billing/auto-recharge",
    "/api/zero/billing/auto-recharge",
  ],
  "/api/billing/checkout": [
    "/api/okou/billing/checkout",
    "/api/zero/billing/checkout",
  ],
  "/api/billing/checkout/complete": [
    "/api/okou/billing/checkout/complete",
    "/api/zero/billing/checkout/complete",
  ],
  "/api/billing/checkout/confirm": [
    "/api/okou/billing/checkout/confirm",
    "/api/zero/billing/checkout/confirm",
  ],
  "/api/billing/concurrency-checkout": [
    "/api/okou/billing/concurrency-checkout",
    "/api/zero/billing/concurrency-checkout",
  ],
  "/api/billing/concurrency-checkout/preview": [
    "/api/okou/billing/concurrency-checkout/preview",
    "/api/zero/billing/concurrency-checkout/preview",
  ],
  "/api/billing/concurrency-subscriptions/:subscriptionId/cancel": [
    "/api/okou/billing/concurrency-subscriptions/:subscriptionId/cancel",
    "/api/zero/billing/concurrency-subscriptions/:subscriptionId/cancel",
  ],
  "/api/billing/concurrency-subscriptions/:subscriptionId/changes/confirm": [
    "/api/okou/billing/concurrency-subscriptions/:subscriptionId/changes/confirm",
    "/api/zero/billing/concurrency-subscriptions/:subscriptionId/changes/confirm",
  ],
  "/api/billing/concurrency-subscriptions/:subscriptionId/changes/preview": [
    "/api/okou/billing/concurrency-subscriptions/:subscriptionId/changes/preview",
    "/api/zero/billing/concurrency-subscriptions/:subscriptionId/changes/preview",
  ],
  "/api/billing/concurrency-subscriptions/:subscriptionId/restore": [
    "/api/okou/billing/concurrency-subscriptions/:subscriptionId/restore",
    "/api/zero/billing/concurrency-subscriptions/:subscriptionId/restore",
  ],
  "/api/billing/credit-checkout": [
    "/api/okou/billing/credit-checkout",
    "/api/zero/billing/credit-checkout",
  ],
  "/api/billing/credit-checkout/confirm": [
    "/api/okou/billing/credit-checkout/confirm",
    "/api/zero/billing/credit-checkout/confirm",
  ],
  "/api/billing/downgrade": [
    "/api/okou/billing/downgrade",
    "/api/zero/billing/downgrade",
  ],
  "/api/billing/invoices": [
    "/api/okou/billing/invoices",
    "/api/zero/billing/invoices",
  ],
  "/api/billing/invoices/receipts": [
    "/api/okou/billing/invoices/receipts",
    "/api/zero/billing/invoices/receipts",
  ],
  "/api/billing/portal": [
    "/api/okou/billing/portal",
    "/api/zero/billing/portal",
  ],
  "/api/billing/redeem-code": [
    "/api/okou/billing/redeem-code",
    "/api/zero/billing/redeem-code",
  ],
  "/api/billing/redeem/:campaign": [
    "/api/okou/billing/redeem/:campaign",
    "/api/zero/billing/redeem/:campaign",
  ],
  "/api/billing/restore": [
    "/api/okou/billing/restore",
    "/api/zero/billing/restore",
  ],
  "/api/billing/status": [
    "/api/okou/billing/status",
    "/api/zero/billing/status",
  ],
  "/api/billing/usage-pack-catalog": [
    "/api/okou/billing/usage-pack-catalog",
    "/api/zero/billing/usage-pack-catalog",
  ],
  "/api/billing/usage-pack-checkout": [
    "/api/okou/billing/usage-pack-checkout",
    "/api/zero/billing/usage-pack-checkout",
  ],
  "/api/billing/usage-pack-checkout/confirm": [
    "/api/okou/billing/usage-pack-checkout/confirm",
    "/api/zero/billing/usage-pack-checkout/confirm",
  ],
  "/api/billing/usage-pack-credits": [
    "/api/okou/billing/usage-pack-credits",
    "/api/zero/billing/usage-pack-credits",
  ],
  "/api/billing/usage-pack-migration": [
    "/api/okou/billing/usage-pack-migration",
    "/api/zero/billing/usage-pack-migration",
  ],
  "/api/billing/usage-pack-migration/:migrationId/confirm": [
    "/api/okou/billing/usage-pack-migration/:migrationId/confirm",
    "/api/zero/billing/usage-pack-migration/:migrationId/confirm",
  ],
  "/api/billing/usage-pack-migration/:migrationId/revision/confirm": [
    "/api/okou/billing/usage-pack-migration/:migrationId/revision/confirm",
    "/api/zero/billing/usage-pack-migration/:migrationId/revision/confirm",
  ],
  "/api/billing/usage-pack-migration/:migrationId/revision/preview": [
    "/api/okou/billing/usage-pack-migration/:migrationId/revision/preview",
    "/api/zero/billing/usage-pack-migration/:migrationId/revision/preview",
  ],
  "/api/billing/usage-pack-migration/preview": [
    "/api/okou/billing/usage-pack-migration/preview",
    "/api/zero/billing/usage-pack-migration/preview",
  ],
  "/api/billing/usage-pack-subscription": [
    "/api/okou/billing/usage-pack-subscription",
    "/api/zero/billing/usage-pack-subscription",
  ],
  "/api/billing/usage-pack-subscription/changes/:changeId/confirm": [
    "/api/okou/billing/usage-pack-subscription/changes/:changeId/confirm",
    "/api/zero/billing/usage-pack-subscription/changes/:changeId/confirm",
  ],
  "/api/billing/usage-pack-subscription/changes/preview": [
    "/api/okou/billing/usage-pack-subscription/changes/preview",
    "/api/zero/billing/usage-pack-subscription/changes/preview",
  ],
  "/api/billing/usage-pack-subscription/subscription-change/confirm": [
    "/api/okou/billing/usage-pack-subscription/subscription-change/confirm",
    "/api/zero/billing/usage-pack-subscription/subscription-change/confirm",
  ],
  "/api/billing/usage-pack-subscription/subscription-change/preview": [
    "/api/okou/billing/usage-pack-subscription/subscription-change/preview",
    "/api/zero/billing/usage-pack-subscription/subscription-change/preview",
  ],
  // #28466: the desktop Computer Use family. The highest-traffic branded family
  // in the repository — about 716,000 requests over the retained request-log
  // window — and the one with the longest-lived callers: `computer-use-host.ts`
  // in an installed Desktop build hardcodes the `okou` form of the host
  // endpoints, and an installed build updates on its owner's schedule rather
  // than on a deploy, so it has no window at all. The `zero` form carried
  // measured traffic of its own and was reachable through the blanket expansion
  // until the contract moved. Both are owed on all sixteen paths.
  //
  // The four rows `LEGACY_ZERO_PATHS` lists — `host/commands/next`,
  // `audit-events`, `heartbeat`, and `hosts/start` — were served by that table
  // before this move and are served by these rows after it: the contract no
  // longer declares a branded path for the expansion to classify. The rows
  // there stay untouched, and removal of either set follows #26701's evidence
  // rules.
  //
  // A key holds its path parameter verbatim, because the lookup below matches
  // `entry.route.path` exactly rather than an expanded request path.
  "/api/computer-use/audit-events": [
    "/api/okou/computer-use/audit-events",
    "/api/zero/computer-use/audit-events",
  ],
  "/api/computer-use/authorization-requests": [
    "/api/okou/computer-use/authorization-requests",
    "/api/zero/computer-use/authorization-requests",
  ],
  "/api/computer-use/authorization-requests/:requestToken": [
    "/api/okou/computer-use/authorization-requests/:requestToken",
    "/api/zero/computer-use/authorization-requests/:requestToken",
  ],
  "/api/computer-use/authorization-requests/:requestToken/apply": [
    "/api/okou/computer-use/authorization-requests/:requestToken/apply",
    "/api/zero/computer-use/authorization-requests/:requestToken/apply",
  ],
  "/api/computer-use/commands": [
    "/api/okou/computer-use/commands",
    "/api/zero/computer-use/commands",
  ],
  "/api/computer-use/commands/:commandId": [
    "/api/okou/computer-use/commands/:commandId",
    "/api/zero/computer-use/commands/:commandId",
  ],
  "/api/computer-use/commands/:commandId/plugin-content": [
    "/api/okou/computer-use/commands/:commandId/plugin-content",
    "/api/zero/computer-use/commands/:commandId/plugin-content",
  ],
  "/api/computer-use/commands/:commandId/screenshot": [
    "/api/okou/computer-use/commands/:commandId/screenshot",
    "/api/zero/computer-use/commands/:commandId/screenshot",
  ],
  "/api/computer-use/heartbeat": [
    "/api/okou/computer-use/heartbeat",
    "/api/zero/computer-use/heartbeat",
  ],
  "/api/computer-use/host/commands/:commandId/complete": [
    "/api/okou/computer-use/host/commands/:commandId/complete",
    "/api/zero/computer-use/host/commands/:commandId/complete",
  ],
  "/api/computer-use/host/commands/next": [
    "/api/okou/computer-use/host/commands/next",
    "/api/zero/computer-use/host/commands/next",
  ],
  "/api/computer-use/host/stop": [
    "/api/okou/computer-use/host/stop",
    "/api/zero/computer-use/host/stop",
  ],
  "/api/computer-use/hosts": [
    "/api/okou/computer-use/hosts",
    "/api/zero/computer-use/hosts",
  ],
  "/api/computer-use/hosts/start": [
    "/api/okou/computer-use/hosts/start",
    "/api/zero/computer-use/hosts/start",
  ],
  "/api/computer-use/plugin-commands": [
    "/api/okou/computer-use/plugin-commands",
    "/api/zero/computer-use/plugin-commands",
  ],
  "/api/computer-use/write-commands": [
    "/api/okou/computer-use/write-commands",
    "/api/zero/computer-use/write-commands",
  ],
  // #28423: the integration control plane and the CLI messaging and file
  // surfaces for Feishu, Slack, Microsoft Teams, Telegram, GitHub, AgentPhone,
  // and Strapi. Two callers hold a branded form independently of the contract:
  // `downloadFeishuFile` and `downloadPhoneFile` in the CLI build their URL by
  // hand, so a published package keeps asking for the `okou` path it shipped
  // with. Every other caller derives its URL from the contract, which a
  // published CLI package still embeds at the version it was built from, and
  // the `zero` form was reachable through the blanket expansion until the
  // contract moved. Both are owed.
  //
  // Surfaces: commit-addressed CLI packages pinned by execution contexts
  // created before this deploy, which drain over the queue lifetime plus
  // claimed execution bounded by the runner's 2h `JOB_TIMEOUT`, and a released
  // platform tab holding the branded connect and Strapi paths until it
  // navigates or reloads (~2 days). Neither window is the removal condition:
  // these rows retire under #26701's evidence rules like every other row here.
  //
  // A key holds its path parameter verbatim, because the lookup below matches
  // `entry.route.path` exactly rather than an expanded request path.
  "/api/integrations/feishu": [
    "/api/okou/integrations/feishu",
    "/api/zero/integrations/feishu",
  ],
  "/api/integrations/feishu/app-id": [
    "/api/okou/integrations/feishu/app-id",
    "/api/zero/integrations/feishu/app-id",
  ],
  "/api/integrations/feishu/connect": [
    "/api/okou/integrations/feishu/connect",
    "/api/zero/integrations/feishu/connect",
  ],
  "/api/integrations/feishu/download-file": [
    "/api/okou/integrations/feishu/download-file",
    "/api/zero/integrations/feishu/download-file",
  ],
  "/api/integrations/feishu/installations/:installationId": [
    "/api/okou/integrations/feishu/installations/:installationId",
    "/api/zero/integrations/feishu/installations/:installationId",
  ],
  "/api/integrations/feishu/installations/:installationId/connect": [
    "/api/okou/integrations/feishu/installations/:installationId/connect",
    "/api/zero/integrations/feishu/installations/:installationId/connect",
  ],
  "/api/integrations/feishu/message": [
    "/api/okou/integrations/feishu/message",
    "/api/zero/integrations/feishu/message",
  ],
  "/api/integrations/feishu/upload-file/complete": [
    "/api/okou/integrations/feishu/upload-file/complete",
    "/api/zero/integrations/feishu/upload-file/complete",
  ],
  "/api/integrations/feishu/upload-file/init": [
    "/api/okou/integrations/feishu/upload-file/init",
    "/api/zero/integrations/feishu/upload-file/init",
  ],
  "/api/integrations/github/upload-file/complete": [
    "/api/okou/integrations/github/upload-file/complete",
    "/api/zero/integrations/github/upload-file/complete",
  ],
  "/api/integrations/github/upload-file/init": [
    "/api/okou/integrations/github/upload-file/init",
    "/api/zero/integrations/github/upload-file/init",
  ],
  "/api/integrations/phone/download-file": [
    "/api/okou/integrations/phone/download-file",
    "/api/zero/integrations/phone/download-file",
  ],
  "/api/integrations/phone/message": [
    "/api/okou/integrations/phone/message",
    "/api/zero/integrations/phone/message",
  ],
  "/api/integrations/phone/upload-file/complete": [
    "/api/okou/integrations/phone/upload-file/complete",
    "/api/zero/integrations/phone/upload-file/complete",
  ],
  "/api/integrations/phone/upload-file/init": [
    "/api/okou/integrations/phone/upload-file/init",
    "/api/zero/integrations/phone/upload-file/init",
  ],
  "/api/integrations/slack": [
    "/api/okou/integrations/slack",
    "/api/zero/integrations/slack",
  ],
  "/api/integrations/slack/connect": [
    "/api/okou/integrations/slack/connect",
    "/api/zero/integrations/slack/connect",
  ],
  "/api/integrations/slack/message": [
    "/api/okou/integrations/slack/message",
    "/api/zero/integrations/slack/message",
  ],
  "/api/integrations/slack/upload-file/complete": [
    "/api/okou/integrations/slack/upload-file/complete",
    "/api/zero/integrations/slack/upload-file/complete",
  ],
  "/api/integrations/slack/upload-file/init": [
    "/api/okou/integrations/slack/upload-file/init",
    "/api/zero/integrations/slack/upload-file/init",
  ],
  "/api/integrations/slack/upload-file/materialize": [
    "/api/okou/integrations/slack/upload-file/materialize",
    "/api/zero/integrations/slack/upload-file/materialize",
  ],
  "/api/integrations/strapi": [
    "/api/okou/integrations/strapi",
    "/api/zero/integrations/strapi",
  ],
  "/api/integrations/strapi/:integrationId": [
    "/api/okou/integrations/strapi/:integrationId",
    "/api/zero/integrations/strapi/:integrationId",
  ],
  "/api/integrations/strapi/:integrationId/check-test": [
    "/api/okou/integrations/strapi/:integrationId/check-test",
    "/api/zero/integrations/strapi/:integrationId/check-test",
  ],
  "/api/integrations/strapi/:integrationId/secret": [
    "/api/okou/integrations/strapi/:integrationId/secret",
    "/api/zero/integrations/strapi/:integrationId/secret",
  ],
  "/api/integrations/teams/connect": [
    "/api/okou/integrations/teams/connect",
    "/api/zero/integrations/teams/connect",
  ],
  "/api/integrations/teams/message": [
    "/api/okou/integrations/teams/message",
    "/api/zero/integrations/teams/message",
  ],
  "/api/integrations/teams/upload-file/complete": [
    "/api/okou/integrations/teams/upload-file/complete",
    "/api/zero/integrations/teams/upload-file/complete",
  ],
  "/api/integrations/teams/upload-file/init": [
    "/api/okou/integrations/teams/upload-file/init",
    "/api/zero/integrations/teams/upload-file/init",
  ],
  "/api/integrations/telegram/bots": [
    "/api/okou/integrations/telegram/bots",
    "/api/zero/integrations/telegram/bots",
  ],
  "/api/integrations/telegram/message": [
    "/api/okou/integrations/telegram/message",
    "/api/zero/integrations/telegram/message",
  ],
  "/api/integrations/telegram/upload-file/complete": [
    "/api/okou/integrations/telegram/upload-file/complete",
    "/api/zero/integrations/telegram/upload-file/complete",
  ],
  "/api/integrations/telegram/upload-file/init": [
    "/api/okou/integrations/telegram/upload-file/init",
    "/api/zero/integrations/telegram/upload-file/init",
  ],
  // #28460: the connector catalog, the connector connections and their
  // authorization starts, the custom connectors, the model provider
  // connections, and the user permission grants. Two surfaces hold these
  // branded paths. A released web or app build keeps calling the form it was
  // compiled against until it reloads, the ~2 day old-web-client window in
  // `docs/fallback.md` section 7; and a commit-addressed CLI package pinned by
  // an execution context's `CLI_PKG_URL` keeps calling it for that context's
  // queue lifetime plus claimed execution, bounded by the runner's 2h
  // `JOB_TIMEOUT`. Neither window is the removal condition on its own: a row
  // retires under the #26701 evidence gate above, like every other row here.
  "/api/connector-catalog": [
    "/api/okou/connector-catalog",
    "/api/zero/connector-catalog",
  ],
  "/api/connector-catalog/:connectorSlug": [
    "/api/okou/connector-catalog/:connectorSlug",
    "/api/zero/connector-catalog/:connectorSlug",
  ],
  "/api/connector-catalog/:connectorSlug/permissions": [
    "/api/okou/connector-catalog/:connectorSlug/permissions",
    "/api/zero/connector-catalog/:connectorSlug/permissions",
  ],
  "/api/connector-catalog/diagnostics": [
    "/api/okou/connector-catalog/diagnostics",
    "/api/zero/connector-catalog/diagnostics",
  ],
  "/api/connector-catalog/discovery": [
    "/api/okou/connector-catalog/discovery",
    "/api/zero/connector-catalog/discovery",
  ],
  "/api/connector-catalog/status": [
    "/api/okou/connector-catalog/status",
    "/api/zero/connector-catalog/status",
  ],
  "/api/connectors": ["/api/okou/connectors", "/api/zero/connectors"],
  "/api/connectors/:connectorSlug": [
    "/api/okou/connectors/:connectorSlug",
    "/api/zero/connectors/:connectorSlug",
  ],
  "/api/connectors/:connectorSlug/external-code/sessions": [
    "/api/okou/connectors/:connectorSlug/external-code/sessions",
    "/api/zero/connectors/:connectorSlug/external-code/sessions",
  ],
  "/api/connectors/:connectorSlug/external-code/sessions/:sessionId/complete": [
    "/api/okou/connectors/:connectorSlug/external-code/sessions/:sessionId/complete",
    "/api/zero/connectors/:connectorSlug/external-code/sessions/:sessionId/complete",
  ],
  "/api/connectors/:connectorSlug/manual-grant": [
    "/api/okou/connectors/:connectorSlug/manual-grant",
    "/api/zero/connectors/:connectorSlug/manual-grant",
  ],
  "/api/connectors/:connectorSlug/no-auth": [
    "/api/okou/connectors/:connectorSlug/no-auth",
    "/api/zero/connectors/:connectorSlug/no-auth",
  ],
  "/api/connectors/:connectorSlug/oauth/device/sessions": [
    "/api/okou/connectors/:connectorSlug/oauth/device/sessions",
    "/api/zero/connectors/:connectorSlug/oauth/device/sessions",
  ],
  "/api/connectors/:connectorSlug/oauth/device/sessions/:sessionId/poll": [
    "/api/okou/connectors/:connectorSlug/oauth/device/sessions/:sessionId/poll",
    "/api/zero/connectors/:connectorSlug/oauth/device/sessions/:sessionId/poll",
  ],
  "/api/connectors/:connectorSlug/oauth/start": [
    "/api/okou/connectors/:connectorSlug/oauth/start",
    "/api/zero/connectors/:connectorSlug/oauth/start",
  ],
  "/api/connectors/:connectorSlug/openid/start": [
    "/api/okou/connectors/:connectorSlug/openid/start",
    "/api/zero/connectors/:connectorSlug/openid/start",
  ],
  "/api/connectors/:connectorSlug/scope-diff": [
    "/api/okou/connectors/:connectorSlug/scope-diff",
    "/api/zero/connectors/:connectorSlug/scope-diff",
  ],
  "/api/connectors/diagnostics/check": [
    "/api/okou/connectors/diagnostics/check",
    "/api/zero/connectors/diagnostics/check",
  ],
  "/api/connectors/search": [
    "/api/okou/connectors/search",
    "/api/zero/connectors/search",
  ],
  "/api/connectors/steam/player": [
    "/api/okou/connectors/steam/player",
    "/api/zero/connectors/steam/player",
  ],
  "/api/custom-connectors": [
    "/api/okou/custom-connectors",
    "/api/zero/custom-connectors",
  ],
  "/api/custom-connectors/:id": [
    "/api/okou/custom-connectors/:id",
    "/api/zero/custom-connectors/:id",
  ],
  "/api/custom-connectors/:id/connection": [
    "/api/okou/custom-connectors/:id/connection",
    "/api/zero/custom-connectors/:id/connection",
  ],
  "/api/custom-connectors/:id/oauth2/start": [
    "/api/okou/custom-connectors/:id/oauth2/start",
    "/api/zero/custom-connectors/:id/oauth2/start",
  ],
  "/api/custom-connectors/:id/permissions": [
    "/api/okou/custom-connectors/:id/permissions",
    "/api/zero/custom-connectors/:id/permissions",
  ],
  "/api/custom-connectors/:id/values": [
    "/api/okou/custom-connectors/:id/values",
    "/api/zero/custom-connectors/:id/values",
  ],
  "/api/custom-connectors/oauth2/callback": [
    "/api/okou/custom-connectors/oauth2/callback",
    "/api/zero/custom-connectors/oauth2/callback",
  ],
  "/api/custom-connectors/proposals/save": [
    "/api/okou/custom-connectors/proposals/save",
    "/api/zero/custom-connectors/proposals/save",
  ],
  "/api/model-provider-connections": [
    "/api/okou/model-provider-connections",
    "/api/zero/model-provider-connections",
  ],
  "/api/model-provider-connections/:id": [
    "/api/okou/model-provider-connections/:id",
    "/api/zero/model-provider-connections/:id",
  ],
  "/api/user-permission-grants": [
    "/api/okou/user-permission-grants",
    "/api/zero/user-permission-grants",
  ],
  "/api/user-permission-grants/apply": [
    "/api/okou/user-permission-grants/apply",
    "/api/zero/user-permission-grants/apply",
  ],
  // #28464: the Slack, Teams, and Feishu connect and OAuth-start routes. The
  // eight paths a provider console holds stay branded and are not moved here —
  // they are listed in `FINAL_PROVIDER_CONSOLE_PATHS` above.
  //
  // These rows hold two surfaces open. A released web or app build keeps the
  // branded path it was compiled against until a refresh loads a build that
  // derives the neutral one, the ~2 day window in `docs/fallback.md` section 7.
  // The OAuth-start paths have a second holder that no client version bounds: a
  // connect or install link the API handed out earlier lives in a Slack, Teams,
  // or Feishu message a user can still click, and `/api/okou/slack/oauth/install`
  // is measured traffic listed in `LEGACY_ZERO_PATHS` above, which after this
  // move only these rows can serve. Removal follows the #26701 evidence gate
  // like every other row, not either clock.
  "/api/feishu/connect": [
    "/api/okou/feishu/connect",
    "/api/zero/feishu/connect",
  ],
  "/api/feishu/connect/status": [
    "/api/okou/feishu/connect/status",
    "/api/zero/feishu/connect/status",
  ],
  "/api/feishu/oauth/connect": [
    "/api/okou/feishu/oauth/connect",
    "/api/zero/feishu/oauth/connect",
  ],
  "/api/slack/channels": [
    "/api/okou/slack/channels",
    "/api/zero/slack/channels",
  ],
  "/api/slack/oauth/connect": [
    "/api/okou/slack/oauth/connect",
    "/api/zero/slack/oauth/connect",
  ],
  "/api/slack/oauth/install": [
    "/api/okou/slack/oauth/install",
    "/api/zero/slack/oauth/install",
  ],
  "/api/teams/connect": ["/api/okou/teams/connect", "/api/zero/teams/connect"],
  "/api/teams/oauth/connect": [
    "/api/okou/teams/oauth/connect",
    "/api/zero/teams/oauth/connect",
  ],
  // #28465: the stable desktop release page and DMG download.
  //
  // These two rows hold open a longer window than any other row in this table.
  // Their callers are installed macOS applications, not a web bundle or a
  // commit-addressed CLI artifact: the final Zero bridge release documented in
  // `apps/desktop/README.md` opens the `okou` DMG path from a constant compiled
  // into the shipped build, and `isTrustedZeroMigrationDownloadUrl` in that
  // build refuses any other path — so a user who never updates keeps asking for
  // the branded form indefinitely. The platform download button held the same
  // path until this slice moved it, and released tabs keep it for the ~2 day
  // old-web-client window. The `zero` form was reachable through the blanket
  // expansion until the contract moved, so both are owed.
  //
  // An installed desktop build has no drain window at all, so these rows must
  // not be removed on the #26701 evidence rules alone: retiring the branded
  // forms needs the Desktop-side drain gate tracked by #26364.
  //
  // Each key holds its path parameters verbatim, because the lookup below
  // matches `entry.route.path` exactly rather than an expanded request path.
  "/api/desktop/updates/:channel/:platform/:arch/dmg": [
    "/api/okou/desktop/updates/:channel/:platform/:arch/dmg",
    "/api/zero/desktop/updates/:channel/:platform/:arch/dmg",
  ],
  "/api/desktop/updates/:channel/:platform/:arch/release": [
    "/api/okou/desktop/updates/:channel/:platform/:arch/release",
    "/api/zero/desktop/updates/:channel/:platform/:arch/release",
  ],
  // #28462: feature switches, model policies, org-level model providers and
  // their device-auth sessions, the org profile and membership routes, and the
  // usage reads. Three surfaces hold these branded paths open, and the widest
  // one is why the rows matter more here than in most slices:
  //
  // - An installed desktop build, which hardcodes `/api/okou/org` and
  //   `/api/okou/feature-switches` rather than deriving them from a contract.
  //   It has no window at all: it holds those paths until its user updates.
  // - An open platform page, which keeps the bundle it loaded for about the
  //   ~2 day old-web-client window in `docs/fallback.md` section 7.
  // - A commit-addressed CLI package pinned by an execution context's
  //   `CLI_PKG_URL`, draining over that context's queue lifetime plus claimed
  //   execution bounded by the runner's 2h `JOB_TIMEOUT`.
  //
  // The CI bootstrap steps in `.github/workflows/turbo.yml` also call the
  // branded forms on purpose: they exercise the compatibility these rows
  // guarantee. None of those windows is the removal condition — a row retires
  // under #26701's evidence rules like every other row in this file.
  //
  // A key holds its path parameter verbatim, because the lookup below matches
  // `entry.route.path` exactly rather than an expanded request path.
  "/api/feature-switches": [
    "/api/okou/feature-switches",
    "/api/zero/feature-switches",
  ],
  "/api/model-policies": [
    "/api/okou/model-policies",
    "/api/zero/model-policies",
  ],
  "/api/model-providers": [
    "/api/okou/model-providers",
    "/api/zero/model-providers",
  ],
  "/api/model-providers/:type": [
    "/api/okou/model-providers/:type",
    "/api/zero/model-providers/:type",
  ],
  "/api/model-providers/claude-code/device-auth/sessions": [
    "/api/okou/model-providers/claude-code/device-auth/sessions",
    "/api/zero/model-providers/claude-code/device-auth/sessions",
  ],
  "/api/model-providers/claude-code/device-auth/sessions/cancel": [
    "/api/okou/model-providers/claude-code/device-auth/sessions/cancel",
    "/api/zero/model-providers/claude-code/device-auth/sessions/cancel",
  ],
  "/api/model-providers/claude-code/device-auth/sessions/complete": [
    "/api/okou/model-providers/claude-code/device-auth/sessions/complete",
    "/api/zero/model-providers/claude-code/device-auth/sessions/complete",
  ],
  "/api/model-providers/codex/device-auth/sessions": [
    "/api/okou/model-providers/codex/device-auth/sessions",
    "/api/zero/model-providers/codex/device-auth/sessions",
  ],
  "/api/model-providers/codex/device-auth/sessions/cancel": [
    "/api/okou/model-providers/codex/device-auth/sessions/cancel",
    "/api/zero/model-providers/codex/device-auth/sessions/cancel",
  ],
  "/api/model-providers/codex/device-auth/sessions/complete": [
    "/api/okou/model-providers/codex/device-auth/sessions/complete",
    "/api/zero/model-providers/codex/device-auth/sessions/complete",
  ],
  "/api/org": ["/api/okou/org", "/api/zero/org"],
  "/api/org/delete": ["/api/okou/org/delete", "/api/zero/org/delete"],
  "/api/org/invite": ["/api/okou/org/invite", "/api/zero/org/invite"],
  "/api/org/invite/purchase/:purchaseId/confirm": [
    "/api/okou/org/invite/purchase/:purchaseId/confirm",
    "/api/zero/org/invite/purchase/:purchaseId/confirm",
  ],
  "/api/org/invite/purchase/preview": [
    "/api/okou/org/invite/purchase/preview",
    "/api/zero/org/invite/purchase/preview",
  ],
  "/api/org/leave": ["/api/okou/org/leave", "/api/zero/org/leave"],
  "/api/org/logo": ["/api/okou/org/logo", "/api/zero/org/logo"],
  "/api/org/members": ["/api/okou/org/members", "/api/zero/org/members"],
  "/api/org/membership-requests": [
    "/api/okou/org/membership-requests",
    "/api/zero/org/membership-requests",
  ],
  "/api/usage/members": ["/api/okou/usage/members", "/api/zero/usage/members"],
  "/api/usage/record": ["/api/okou/usage/record", "/api/zero/usage/record"],
  // #28463: avatar video, banking, the browser authorization requests, inbound
  // email, the GitHub user-connect start, mail drafts, people search,
  // presentation templates, the Strapi webhook, uploads, video-io, voice-io and
  // the web file reads.
  //
  // Every surface this table protects is represented here at once. Published CLI
  // builds hold the `okou` form directly: `domains/web.ts` and `domains/banking.ts`
  // build ten of these URLs by hand rather than from the contract, so the path
  // they carry shipped independently of this table, and a run execution context
  // pins its commit-addressed `CLI_PKG_URL` at creation — the queue lifetime plus
  // claimed execution bounded by the runner's 2h `JOB_TIMEOUT`. A released
  // platform build holds `/api/okou/web/download-file`, `/api/okou/web/file-url`
  // and `/api/okou/voice-io/stt` until a refresh loads a build that derives the
  // neutral path (~2 days). The Strapi webhook URL sits in a customer's Strapi
  // console, and every `zero` form was reachable through the blanket expansion
  // until these contracts moved; neither has a window at all. Removal therefore
  // follows the #26701 evidence gate above rather than any of those clocks.
  "/api/avatar-video/avatars": [
    "/api/okou/avatar-video/avatars",
    "/api/zero/avatar-video/avatars",
  ],
  "/api/avatar-video/generate": [
    "/api/okou/avatar-video/generate",
    "/api/zero/avatar-video/generate",
  ],
  "/api/avatar-video/voices": [
    "/api/okou/avatar-video/voices",
    "/api/zero/avatar-video/voices",
  ],
  "/api/banking/accounts": [
    "/api/okou/banking/accounts",
    "/api/zero/banking/accounts",
  ],
  "/api/banking/balances": [
    "/api/okou/banking/balances",
    "/api/zero/banking/balances",
  ],
  "/api/banking/transactions": [
    "/api/okou/banking/transactions",
    "/api/zero/banking/transactions",
  ],
  "/api/browser/authorization-requests": [
    "/api/okou/browser/authorization-requests",
    "/api/zero/browser/authorization-requests",
  ],
  "/api/browser/authorization-requests/:requestToken": [
    "/api/okou/browser/authorization-requests/:requestToken",
    "/api/zero/browser/authorization-requests/:requestToken",
  ],
  "/api/browser/authorization-requests/:requestToken/apply": [
    "/api/okou/browser/authorization-requests/:requestToken/apply",
    "/api/zero/browser/authorization-requests/:requestToken/apply",
  ],
  "/api/email/inbound": ["/api/okou/email/inbound", "/api/zero/email/inbound"],
  "/api/github/oauth/connect": [
    "/api/okou/github/oauth/connect",
    "/api/zero/github/oauth/connect",
  ],
  "/api/mail/drafts/:mailDraftId": [
    "/api/okou/mail/drafts/:mailDraftId",
    "/api/zero/mail/drafts/:mailDraftId",
  ],
  "/api/mail/drafts/:mailDraftId/attachments/:partId": [
    "/api/okou/mail/drafts/:mailDraftId/attachments/:partId",
    "/api/zero/mail/drafts/:mailDraftId/attachments/:partId",
  ],
  "/api/mail/drafts/:mailDraftId/send": [
    "/api/okou/mail/drafts/:mailDraftId/send",
    "/api/zero/mail/drafts/:mailDraftId/send",
  ],
  "/api/mail/drafts/link": [
    "/api/okou/mail/drafts/link",
    "/api/zero/mail/drafts/link",
  ],
  "/api/people-search": ["/api/okou/people-search", "/api/zero/people-search"],
  "/api/presentation-templates": [
    "/api/okou/presentation-templates",
    "/api/zero/presentation-templates",
  ],
  "/api/presentation-templates/:templateId": [
    "/api/okou/presentation-templates/:templateId",
    "/api/zero/presentation-templates/:templateId",
  ],
  "/api/strapi/events/:integrationId": [
    "/api/okou/strapi/events/:integrationId",
    "/api/zero/strapi/events/:integrationId",
  ],
  "/api/uploads/complete": [
    "/api/okou/uploads/complete",
    "/api/zero/uploads/complete",
  ],
  "/api/uploads/multipart/abort": [
    "/api/okou/uploads/multipart/abort",
    "/api/zero/uploads/multipart/abort",
  ],
  "/api/uploads/multipart/complete": [
    "/api/okou/uploads/multipart/complete",
    "/api/zero/uploads/multipart/complete",
  ],
  "/api/uploads/prepare": [
    "/api/okou/uploads/prepare",
    "/api/zero/uploads/prepare",
  ],
  "/api/video-io/generate": [
    "/api/okou/video-io/generate",
    "/api/zero/video-io/generate",
  ],
  "/api/voice-io/quota": [
    "/api/okou/voice-io/quota",
    "/api/zero/voice-io/quota",
  ],
  "/api/voice-io/speech": [
    "/api/okou/voice-io/speech",
    "/api/zero/voice-io/speech",
  ],
  "/api/voice-io/stt": ["/api/okou/voice-io/stt", "/api/zero/voice-io/stt"],
  "/api/web/download-file": [
    "/api/okou/web/download-file",
    "/api/zero/web/download-file",
  ],
  "/api/web/file-url": ["/api/okou/web/file-url", "/api/zero/web/file-url"],
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
