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
 * The legacy `/api/zero/**` paths this service owes callers, keyed by the
 * canonical `/api/okou/**` path of the contract that serves them. This table
 * is the source of truth for Phase A compatibility from #26487: an entry here
 * is compatibility kept deliberately, rather than a derivation nobody can
 * audit.
 *
 * The table is exhaustive. #28701 removed the blanket expansion that used to
 * keep every other `/api/zero/**` path resolving behind it, so a `/api/zero/**`
 * path is served only when this table or `MIGRATED_BRANDED_PATHS` names it, and
 * removing a row now retires the path rather than downgrading it to a reported
 * one.
 *
 * Keyed by path alone rather than by `METHOD path`: the evidence below is a
 * path template with no method attached, so restricting an entry to the single
 * method that happened to appear inside the retained window would 404 a
 * caller's other methods on the same path.
 *
 * Every remaining row belongs to a provider console — a Slack or Teams app
 * configuration holds the URL, not a client we control — so no deploy and no
 * client release drains it. #28701 narrowed the table to these six against the
 * 6.3 days `vm0-request-log-prod` retains, 2026-08-17 to 2026-08-23:
 *
 * - `slack/events`, `slack/oauth/install`, and `slack/oauth/callback` were
 *   still taking requests on the last day of the window, from 33 and 17
 *   distinct source addresses inside Slack's own infrastructure. That is what
 *   proves the Slack app configuration still points at the legacy paths.
 * - `slack/commands` and `slack/interactive` saw no traffic in the window and
 *   stay anyway: they live in the same Slack app configuration as the Event
 *   Subscriptions URL that is demonstrably still legacy, so their silence says
 *   nobody used a slash command that week, not that the configuration moved.
 * - `slack/oauth/callback` and `teams/oauth/callback` are also produced inside
 *   this repository, as `redirect_uri` values in `routes/slack-oauth.ts` and
 *   `routes/teams-oauth.ts`. The Teams row is held deliberately so that
 *   `api.vm0.ai` and `/api/zero/**` retire together, as recorded on #26701.
 *
 * The rows #28701 removed are still served, by `MIGRATED_BRANDED_PATHS`: each
 * of those contracts moved to a neutral path in a #28278 slice, and a row there
 * names both branded forms. A row here records that a path is owed rather than
 * which table serves it, which is why removing these twenty-five changed
 * nothing a caller can observe.
 */
const LEGACY_ZERO_PATHS: Readonly<Record<string, string>> = {
  "/api/okou/slack/events": "/api/zero/slack/events",
  "/api/okou/slack/oauth/install": "/api/zero/slack/oauth/install",
  "/api/okou/slack/oauth/callback": "/api/zero/slack/oauth/callback",
  "/api/okou/slack/commands": "/api/zero/slack/commands",
  "/api/okou/slack/interactive": "/api/zero/slack/interactive",
  "/api/okou/teams/oauth/callback": "/api/zero/teams/oauth/callback",
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
 * True when the expansion may register `aliasPath` for a contract declaring
 * `declaredPath`. The declared path and the canonical `/api/okou/**` form
 * always register; a derived `/api/zero/**` path registers only when
 * `LEGACY_ZERO_PATHS` names it.
 */
function servesNamespaceAliasPath(
  declaredPath: string,
  aliasPath: string,
): boolean {
  if (aliasPath === declaredPath) {
    return true;
  }
  const forms = brandedPathForms(declaredPath);
  if (!forms || aliasPath !== forms.legacy) {
    return true;
  }
  return LEGACY_ZERO_PATHS[forms.canonical] === aliasPath;
}

/**
 * Registers the canonical `/api/okou/**` form of every branded contract path,
 * and the legacy `/api/zero/**` form only where `LEGACY_ZERO_PATHS` names it.
 *
 * Until #28701 this expansion derived the legacy form unconditionally and
 * marked the registrations the table did not list, so `createAppWithRoutes`
 * could report the first request that reached one. That fallback existed
 * because the request log retained about three days, which cannot tell a
 * drained caller apart from a weekly one, and narrowing on that evidence would
 * have silently 404ed a real client. The log retains 6.3 days now and #28701
 * measured the whole window, so the table names every legacy path still owed
 * and the derivation behind it is gone — the reporting was retired because it
 * had nothing left to find, not because it was unwanted.
 */
export function withApiNamespaceAliases(
  routes: readonly RouteEntry[],
): readonly RouteEntry[] {
  return routes.flatMap((entry) => {
    return apiNamespaceAliasPaths(entry.route.path)
      .filter((path) => {
        return servesNamespaceAliasPath(entry.route.path, path);
      })
      .map((path) => {
        return routeEntryWithPath(entry, path);
      });
  });
}

/**
 * The branded paths a migrated route still answers on, keyed by the neutral
 * canonical path its contract now declares.
 *
 * `LEGACY_ZERO_PATHS` cannot express this, which is why this is a second table
 * rather than more rows in that one. That table names the `/api/zero/**` form
 * the expansion above may derive for a contract that still declares a branded
 * path; this one names branded registrations for a contract that declares a
 * neutral one, including the `/api/okou/**` form the expansion cannot derive
 * either. `apiNamespaceAliasPaths` returns a neutral path unchanged, so once
 * #28278 moves a contract off `/api/okou/**` the expansion produces no branded
 * path for it and neither branded path is registered any more — published CLI
 * builds still calling the branded path would get a 404 with nothing in either
 * table able to say otherwise.
 *
 * A migrated route generally owes both branded forms, so a value is a list
 * rather than a single path.
 *
 * Each #28278 slice adds the rows for the paths it moves, so a move and the
 * compatibility it owes land in one commit.
 *
 * Every row is compatibility debt under the same removal gate as
 * `LEGACY_ZERO_PATHS`: a row is removed only under #26701's evidence rules.
 * `vm0-request-log-prod` retained 6.3 days when #28701 read it, which is long
 * enough to name a caller that is still there and not long enough to prove a
 * silent row has no caller that returns.
 *
 * The surfaces a row holds open, and the window each one bounds: an open web or
 * app page keeps the bundle it loaded for about two days, and an execution
 * context pins its commit-addressed CLI package at creation, so a run queued
 * before this deploy can still start the older CLI and hold it for the two-hour
 * `JOB_TIMEOUT` drain. An installed CLI or desktop build has no window at all,
 * which is why removal is gated on #26701's request-log evidence rather than on
 * a date.
 *
 * #28709 applied that gate to the whole table for the first time and took it
 * from 314 rows to 184. Each removed row had no request on either branded form
 * across the 6.3 days `vm0-request-log-prod` retained, measured per row rather
 * than from a truncated top-N summary — the log holds about 6,300 distinct
 * branded path templates, most of them scanner noise, so a ranked query that
 * stops short buries exactly the low-traffic rows this gate is deciding. The
 * check matched each row's branded forms as patterns rather than as literals,
 * because a CORS preflight is logged under its request path rather than the
 * route template it never matched.
 *
 * Two classes of row survived that check and are why the table is 184 rather
 * than 135. Forty-six rows took measured traffic on a branded form inside the
 * window, all of it from released App and CLI builds, so they are still serving
 * a caller. Three rows took none and stay anyway, because for them silence is
 * the expected reading rather than evidence: the two `desktop/updates` rows are
 * a one-shot download an installed macOS build asks for when its owner clicks
 * it, and the Feishu events row is delivered to by an app console we cannot
 * edit. None of those holders drains on a deploy, so a quiet week measures how
 * often the surface is used, not whether it is still owed.
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
  // #28421: personal model providers, onboarding, team, and user preferences.
  "/api/me/model-provider-accounts/:id/activate": [
    "/api/okou/me/model-provider-accounts/:id/activate",
    "/api/zero/me/model-provider-accounts/:id/activate",
  ],
  "/api/me/model-providers": [
    "/api/okou/me/model-providers",
    "/api/zero/me/model-providers",
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
  // #28418: the browser, finance, SEO, and MCP connector routes. The callers
  // these rows keep working are a released web or app client, which holds the
  // branded path until a refresh loads a build that derives the neutral one
  // (~2 days), and a CLI artifact pinned by an execution context's
  // `CLI_PKG_URL`, which holds it for that context's queue and claimed-run
  // lifetime. Neither window is the removal condition on its own: a row is
  // removed under #26701's evidence rules, because the request log retains
  // about three days and cannot tell a drained caller from a weekly one.
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
  // per-thread browser sessions, per-thread goals, and workflow automations.
  // The slice also covered shared threads, queue position and the X image
  // share; #28709 removed those rows on zero-traffic evidence, which is why the
  // `okou-app` share worker no longer appears among the holders below. Every
  // caller in this repository derives its URL from the contract, so nothing
  // here still asks for a branded form. Released builds do: a browser tab
  // holding already-loaded platform code keeps calling the `okou` path it was
  // built against until it navigates or reloads, the ~2 day old-web-client
  // window in `docs/fallback.md` section 7; and a commit-addressed CLI package
  // pinned by an execution context's `CLI_PKG_URL` holds it for that context's
  // queue and claimed-run lifetime. The `zero` form was reachable through the
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
  "/api/chat-threads/:id/draft": [
    "/api/okou/chat-threads/:id/draft",
    "/api/zero/chat-threads/:id/draft",
  ],
  "/api/chat-threads/:id/mark-read": [
    "/api/okou/chat-threads/:id/mark-read",
    "/api/zero/chat-threads/:id/mark-read",
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
  // #28457: the billing surface — plan and usage-pack checkout, concurrency
  // subscriptions, credit purchase, the Stripe portal, invoices, and code
  // redemption. Every caller derives its URL from the contract, so nothing in
  // this repository asks for a branded form, but released builds still do: an
  // already-loaded platform tab keeps calling the `okou` path it was built
  // against for the ~2 day old-web-client window in `docs/fallback.md` section
  // 7, and a CLI package pinned by an execution context's `CLI_PKG_URL` embeds
  // the contract path it was built from for that context's queue and claimed-run
  // lifetime. The `zero` form was reachable through the blanket expansion until
  // the contract moved, and `/api/zero/billing/concurrency-checkout/preview`
  // carried measured traffic of its own, so it is owed by evidence rather than
  // by symmetry — #28701 dropped its `LEGACY_ZERO_PATHS` row because these rows
  // are what serve it, not because the evidence expired. Both forms are
  // removable only under #26701's evidence rules, like every other row here.
  "/api/billing/checkout": [
    "/api/okou/billing/checkout",
    "/api/zero/billing/checkout",
  ],
  "/api/billing/concurrency-checkout": [
    "/api/okou/billing/concurrency-checkout",
    "/api/zero/billing/concurrency-checkout",
  ],
  "/api/billing/concurrency-checkout/preview": [
    "/api/okou/billing/concurrency-checkout/preview",
    "/api/zero/billing/concurrency-checkout/preview",
  ],
  "/api/billing/concurrency-subscriptions/:subscriptionId/changes/preview": [
    "/api/okou/billing/concurrency-subscriptions/:subscriptionId/changes/preview",
    "/api/zero/billing/concurrency-subscriptions/:subscriptionId/changes/preview",
  ],
  "/api/billing/credit-checkout/confirm": [
    "/api/okou/billing/credit-checkout/confirm",
    "/api/zero/billing/credit-checkout/confirm",
  ],
  "/api/billing/invoices": [
    "/api/okou/billing/invoices",
    "/api/zero/billing/invoices",
  ],
  "/api/billing/portal": [
    "/api/okou/billing/portal",
    "/api/zero/billing/portal",
  ],
  "/api/billing/redeem-code": [
    "/api/okou/billing/redeem-code",
    "/api/zero/billing/redeem-code",
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
  "/api/billing/usage-pack-credits": [
    "/api/okou/billing/usage-pack-credits",
    "/api/zero/billing/usage-pack-credits",
  ],
  "/api/billing/usage-pack-migration": [
    "/api/okou/billing/usage-pack-migration",
    "/api/zero/billing/usage-pack-migration",
  ],
  "/api/billing/usage-pack-subscription": [
    "/api/okou/billing/usage-pack-subscription",
    "/api/zero/billing/usage-pack-subscription",
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
  // Four of these paths — `host/commands/next`, `audit-events`, `heartbeat`,
  // and `hosts/start` — were served by `LEGACY_ZERO_PATHS` before this move and
  // are served by these rows after it: the contract no longer declares a
  // branded path for the expansion to derive. #28701 dropped their rows from
  // that table once it was clear these rows are what serve them. Removal of
  // these follows #26701's evidence rules like every other row here.
  //
  // A key holds its path parameter verbatim, because the lookup below matches
  // `entry.route.path` exactly rather than an expanded request path.
  "/api/computer-use/audit-events": [
    "/api/okou/computer-use/audit-events",
    "/api/zero/computer-use/audit-events",
  ],
  "/api/computer-use/commands": [
    "/api/okou/computer-use/commands",
    "/api/zero/computer-use/commands",
  ],
  "/api/computer-use/commands/:commandId": [
    "/api/okou/computer-use/commands/:commandId",
    "/api/zero/computer-use/commands/:commandId",
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
  "/api/computer-use/write-commands": [
    "/api/okou/computer-use/write-commands",
    "/api/zero/computer-use/write-commands",
  ],
  // #28423: the integration control plane and the CLI messaging and file
  // surfaces. The slice covered Feishu, Slack, Microsoft Teams, Telegram,
  // GitHub, AgentPhone and Strapi; #28709 removed the Telegram, GitHub,
  // AgentPhone and Feishu messaging and file rows on zero-traffic evidence, so
  // what remains is the Slack messaging and file surface plus the Feishu,
  // Slack, Teams and Strapi control-plane reads. That removal also retired
  // `downloadFeishuFile` and `downloadPhoneFile`, the two CLI callers that
  // built a branded URL by hand rather than from the contract. Every remaining
  // caller derives its URL from the contract, which a published CLI package
  // still embeds at the version it was built from, and the `zero` form was
  // reachable through the blanket expansion until the contract moved. Both are
  // owed.
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
  "/api/integrations/teams/connect": [
    "/api/okou/integrations/teams/connect",
    "/api/zero/integrations/teams/connect",
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
  "/api/connectors/:connectorSlug/manual-grant": [
    "/api/okou/connectors/:connectorSlug/manual-grant",
    "/api/zero/connectors/:connectorSlug/manual-grant",
  ],
  "/api/connectors/:connectorSlug/oauth/start": [
    "/api/okou/connectors/:connectorSlug/oauth/start",
    "/api/zero/connectors/:connectorSlug/oauth/start",
  ],
  "/api/connectors/diagnostics/check": [
    "/api/okou/connectors/diagnostics/check",
    "/api/zero/connectors/diagnostics/check",
  ],
  "/api/custom-connectors": [
    "/api/okou/custom-connectors",
    "/api/zero/custom-connectors",
  ],
  "/api/model-provider-connections": [
    "/api/okou/model-provider-connections",
    "/api/zero/model-provider-connections",
  ],
  "/api/user-permission-grants": [
    "/api/okou/user-permission-grants",
    "/api/zero/user-permission-grants",
  ],
  "/api/user-permission-grants/apply": [
    "/api/okou/user-permission-grants/apply",
    "/api/zero/user-permission-grants/apply",
  ],
  // #28464: the Slack, Teams, and Feishu connect and OAuth-start routes, of
  // which #28709 kept only the Slack rows — the Teams and Feishu connect and
  // OAuth-start rows had no request on either branded form in the retained
  // window. The paths a provider console holds were not in this slice; they
  // moved later, and their rows are at the end of this table.
  //
  // These rows hold two surfaces open. A released web or app build keeps the
  // branded path it was compiled against until a refresh loads a build that
  // derives the neutral one, the ~2 day window in `docs/fallback.md` section 7.
  // The OAuth-start paths have a second holder that no client version bounds: a
  // connect or install link the API handed out earlier lives in a Slack message
  // a user can still click, and `/api/okou/slack/oauth/install` is measured
  // traffic listed in `LEGACY_ZERO_PATHS` above, which after this move only
  // these rows can serve. Removal follows the #26701 evidence gate like every
  // other row, not either clock.
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
  "/api/org/invite": ["/api/okou/org/invite", "/api/zero/org/invite"],
  "/api/org/invite/purchase/:purchaseId/confirm": [
    "/api/okou/org/invite/purchase/:purchaseId/confirm",
    "/api/zero/org/invite/purchase/:purchaseId/confirm",
  ],
  "/api/org/invite/purchase/preview": [
    "/api/okou/org/invite/purchase/preview",
    "/api/zero/org/invite/purchase/preview",
  ],
  "/api/org/logo": ["/api/okou/org/logo", "/api/zero/org/logo"],
  "/api/org/members": ["/api/okou/org/members", "/api/zero/org/members"],
  "/api/usage/members": ["/api/okou/usage/members", "/api/zero/usage/members"],
  "/api/usage/record": ["/api/okou/usage/record", "/api/zero/usage/record"],
  // #28461: the agent reads and writes and the workflow and
  // workflow-automation management routes. The slice also covered the manual
  // Morning Brief trigger; #28709 removed that row on zero-traffic evidence.
  // Every caller in
  // this repository derives its URL from the contract, so nothing here still
  // asks for a branded form; released builds do. Two surfaces hold these paths,
  // and each has its own window.
  //
  // A published CLI package embeds the contract path it was built from and
  // stays pinned by an execution context's `CLI_PKG_URL` — `okou agent`,
  // `okou workflow`, and `okou workflow automation` are the commands behind
  // these paths. That artifact drains over the maximum queue lifetime plus the
  // maximum claimed execution and finalization lifetime, with execution bounded
  // by the runner's 2h `JOB_TIMEOUT`, as `docs/deployment-compatibility.md`
  // describes for commit-addressed CLI artifacts.
  //
  // A browser tab holding already-loaded platform code keeps calling the `okou`
  // path it was built against until it navigates or reloads: the ~2 day
  // old-web-client window in `docs/fallback.md` section 7, and the longer of
  // the two. The `zero` form was reachable through the blanket expansion until
  // the contract moved. Both forms are owed, and both retire under #26701's
  // evidence rules rather than on either clock.
  //
  // A key holds its path parameter verbatim, because the lookup below matches
  // `entry.route.path` exactly rather than an expanded request path.
  "/api/agents": ["/api/okou/agents", "/api/zero/agents"],
  "/api/agents/:id": ["/api/okou/agents/:id", "/api/zero/agents/:id"],
  "/api/agents/:id/custom-connectors": [
    "/api/okou/agents/:id/custom-connectors",
    "/api/zero/agents/:id/custom-connectors",
  ],
  "/api/agents/:id/draft": [
    "/api/okou/agents/:id/draft",
    "/api/zero/agents/:id/draft",
  ],
  "/api/agents/:id/instructions": [
    "/api/okou/agents/:id/instructions",
    "/api/zero/agents/:id/instructions",
  ],
  "/api/agents/:id/user-connectors": [
    "/api/okou/agents/:id/user-connectors",
    "/api/zero/agents/:id/user-connectors",
  ],
  "/api/workflow-automations": [
    "/api/okou/workflow-automations",
    "/api/zero/workflow-automations",
  ],
  "/api/workflow-automations/:id": [
    "/api/okou/workflow-automations/:id",
    "/api/zero/workflow-automations/:id",
  ],
  "/api/workflow-automations/:id/disable": [
    "/api/okou/workflow-automations/:id/disable",
    "/api/zero/workflow-automations/:id/disable",
  ],
  "/api/workflow-automations/:id/enable": [
    "/api/okou/workflow-automations/:id/enable",
    "/api/zero/workflow-automations/:id/enable",
  ],
  "/api/workflows": ["/api/okou/workflows", "/api/zero/workflows"],
  "/api/workflows/:workflowId": [
    "/api/okou/workflows/:workflowId",
    "/api/zero/workflows/:workflowId",
  ],
  "/api/workflows/:workflowId/automations": [
    "/api/okou/workflows/:workflowId/automations",
    "/api/zero/workflows/:workflowId/automations",
  ],
  "/api/workflows/:workflowId/run": [
    "/api/okou/workflows/:workflowId/run",
    "/api/zero/workflows/:workflowId/run",
  ],
  // #28545: the two Microsoft console routes, the first rows whose branded
  // forms a provider console holds rather than a released client. The Azure Bot
  // messaging endpoint and the Microsoft identity platform redirect URIs now
  // hold the final paths, so the contracts declare them and both branded forms
  // are owed from here.
  //
  // What holds the branded forms open is not a released client but the two
  // Microsoft consoles themselves, which have no drain window: they keep
  // sending to whatever URL is registered until an operator changes it.
  // Removal follows #26701's evidence rules, and for the `zero` callback the
  // ordering constraint recorded there.
  "/api/integrations/teams/oauth/callback": [
    "/api/okou/teams/oauth/callback",
    // Not drain-window compatibility. `callbackRedirectUri` in
    // `routes/teams-oauth.ts` is brand-conditional and still emits this exact
    // path for the VM0 brand on purpose: it is registered in the Microsoft app
    // registration, and #26701 records that it retires together with the
    // `api.vm0.ai` brand host. So this row is an active producer target, not a
    // leftover — do not prune it merely for being an `/api/zero/` path, or
    // live VM0-brand connects lose the callback they were sent to.
    "/api/zero/teams/oauth/callback",
  ],
  "/api/webhooks/teams/bot": ["/api/okou/teams/bot", "/api/zero/teams/bot"],
  // #28463: avatar video, the browser authorization requests, mail drafts,
  // people search, presentation templates, uploads, voice-io and the web file
  // reads. The slice also covered banking, inbound email, the GitHub
  // user-connect start, the Strapi webhook and video-io; #28709 removed those
  // rows on zero-traffic evidence, which is why `domains/banking.ts` and the
  // customer-held Strapi console URL no longer appear among the holders below.
  //
  // Published CLI builds hold the `okou` form directly: `domains/web.ts` builds
  // its URLs by hand rather than from the contract, so the path it carries
  // shipped independently of this table, and a run execution context pins its
  // commit-addressed `CLI_PKG_URL` at creation — the queue lifetime plus
  // claimed execution bounded by the runner's 2h `JOB_TIMEOUT`. A released
  // platform build holds `/api/okou/web/download-file`, `/api/okou/web/file-url`
  // and `/api/okou/voice-io/stt` until a refresh loads a build that derives the
  // neutral path (~2 days). Every `zero` form was reachable through the blanket
  // expansion until these contracts moved, which has no window at all. Removal
  // therefore follows the #26701 evidence gate above rather than any of those
  // clocks.
  "/api/avatar-video/avatars": [
    "/api/okou/avatar-video/avatars",
    "/api/zero/avatar-video/avatars",
  ],
  "/api/avatar-video/voices": [
    "/api/okou/avatar-video/voices",
    "/api/zero/avatar-video/voices",
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
  "/api/mail/drafts/:mailDraftId": [
    "/api/okou/mail/drafts/:mailDraftId",
    "/api/zero/mail/drafts/:mailDraftId",
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
  // #28544: the Feishu routes that were classified as console-held without a
  // Feishu console actually holding them — the console registers the
  // frontend-forwarding OAuth target from `feishuOAuthAppCallbackUrl()` rather
  // than the API callback, and #28338 already moved the events URL shown to
  // operators.
  //
  // The events row is the load-bearing one, and the reason it outlived the
  // #28709 sweep with no traffic behind it. Each Feishu installation registered
  // its event subscription URL in its own Feishu app console, which we cannot
  // edit, so an installation created before #28338 still posts to the branded
  // form it was given. That holder has no drain window at all — it changes when
  // its operator edits their own console — so a week without a delivery says
  // the installation was quiet, not that its console moved, which is the same
  // reading `slack/commands` and `slack/interactive` get above.
  //
  // The slice's other row, the OAuth callback, covered a time-boxed surface
  // instead: `feishu-oauth-callback-page.ts` forwards the code it received from
  // the Feishu console's `app.vm0.ai` target to whichever path the contract
  // declared when that bundle was built, so an already-loaded platform tab kept
  // posting the branded form for the ~2 day old-web-client window in
  // `docs/fallback.md` section 7, and the `oauthRedirectUri()` branch behind it
  // is reached only when `callbackTarget` is absent, which neither frontend
  // entry point does. That window closed long before the retained log began, so
  // #28709 removed it.
  //
  // Each key holds its path parameter verbatim, because the lookup below
  // matches `entry.route.path` exactly rather than an expanded request path.
  "/api/webhooks/feishu/events/:installationId": [
    "/api/okou/feishu/events/:installationId",
    "/api/zero/feishu/events/:installationId",
  ],
  // #28565, the closing slice: the managed SocialKit request. The slice also
  // covered the connector-account reads and writes, whose rows #28709 removed
  // on zero-traffic evidence — they had no caller in this repository at all, so
  // nothing but an external holder of a branded form could have reached them.
  // Both contracts were added by features that merged while #28278 was in
  // flight — #28066 and #28519 for the connector accounts, #28343 for
  // SocialKit — so no earlier slice's inventory contained them and they
  // declared the branded namespace by default. The guard in
  // `contracts/__tests__/api-namespace-declarations.test.ts` lands with this
  // slice so the next late contract is rejected rather than migrated later.
  //
  // Surface: a commit-addressed CLI package pinned by a run execution context
  // holds `/api/okou/social/request` for that context's queue and
  // claimed-execution lifetime, bounded by the runner's 2h `JOB_TIMEOUT`. That
  // is a floor rather than the removal condition: this row retires under
  // #26701's evidence rules like every other row in this file.
  "/api/social/request": [
    "/api/okou/social/request",
    "/api/zero/social/request",
  ],
  // #28600, the last branded contract paths: the Slack OAuth callback and the
  // three inbound Slack webhooks. They were the final entries of the console
  // table #28283 added, which this slice deletes — the set of registered paths
  // is unchanged by the move, because the contract now declares the path that
  // table used to add and these rows name the two branded forms it used to
  // declare and derive.
  //
  // The Slack app configuration holds one URL per endpoint and no drain window:
  // it keeps posting to whatever is registered until an operator edits it, so
  // all three forms stay served until #26701's evidence rules retire a row.
  // Nothing in this repository produces the three webhook URLs — they exist
  // only in that configuration — so the move needed no producer change.
  "/api/integrations/slack/oauth/callback": [
    "/api/okou/slack/oauth/callback",
    // Not drain-window compatibility. `callbackRedirectUri` in
    // `routes/slack-oauth.ts` emits this exact path as the `redirect_uri` sent
    // to Slack, and Slack rejects a token exchange whose redirect URI is not
    // registered in the app configuration. So this row is an active producer
    // target: it can only be retired together with the emitted value, once the
    // Slack app configuration is confirmed to hold the final path. Do not prune
    // it for looking like a stale `/api/zero/` alias, or every authorization
    // breaks the moment it lands.
    "/api/zero/slack/oauth/callback",
  ],
  "/api/webhooks/slack/events": [
    "/api/okou/slack/events",
    "/api/zero/slack/events",
  ],
  "/api/webhooks/slack/commands": [
    "/api/okou/slack/commands",
    "/api/zero/slack/commands",
  ],
  "/api/webhooks/slack/interactive": [
    "/api/okou/slack/interactive",
    "/api/zero/slack/interactive",
  ],
};

/**
 * Registers the branded paths named in `MIGRATED_BRANDED_PATHS`, so a contract
 * that has moved to its neutral path keeps serving the branded paths released
 * callers still hold.
 *
 * Applied after `withApiNamespaceAliases` and never before it: these paths are
 * finished registrations, and passing a row's `/api/zero/**` form back through
 * the expansion would derive its canonical sibling a second time and register
 * that path twice.
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
