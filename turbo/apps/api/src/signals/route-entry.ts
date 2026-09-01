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
 * True when the expansion may register `aliasPath` for a contract declaring
 * `declaredPath`. The declared path and the canonical `/api/okou/**` form
 * register; a derived `/api/zero/**` form never does.
 */
function servesNamespaceAliasPath(
  declaredPath: string,
  aliasPath: string,
): boolean {
  return (
    aliasPath === declaredPath || brandedApiNamespace(aliasPath) !== "zero"
  );
}

/**
 * Registers the canonical `/api/okou/**` form of every branded contract path.
 * The legacy `/api/zero/**` form is never derived.
 *
 * Until #28701 this expansion derived the legacy form unconditionally and
 * marked the registrations `LEGACY_ZERO_PATHS` did not list, so
 * `createAppWithRoutes` could report the first request that reached one. That
 * fallback existed because the request log retained about three days, which
 * cannot tell a drained caller apart from a weekly one. #28701 measured the
 * whole 6.3-day window instead, narrowed that table to the six paths a Slack or
 * Teams app configuration still held, and dropped both the derivation and the
 * reporting behind it.
 *
 * #30667 then removed the table itself. Each of its six paths is named directly
 * by a `MIGRATED_BRANDED_PATHS` row below, so none of them lost a registration,
 * and nothing in this repository produces a `/api/zero/**` URL any more — the
 * last producer was `callbackRedirectUri` in `routes/teams-oauth.ts`, unified
 * onto the canonical path in the same commit. A `/api/zero/**` path is now
 * served only where that table names it.
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
 * This is the only table left that registers a branded path, and since #30667
 * the only thing that registers a `/api/zero/**` path at all. It names branded
 * registrations for a contract that declares a neutral path, including the
 * `/api/okou/**` form the expansion above cannot derive.
 * `apiNamespaceAliasPaths` returns a neutral path unchanged, so once #28278
 * moves a contract off `/api/okou/**` the expansion produces no branded path
 * for it and neither branded path is registered any more — published CLI builds
 * still calling the branded path would get a 404 with nothing able to say
 * otherwise.
 *
 * A migrated route generally owes both branded forms, so a value is a list
 * rather than a single path.
 *
 * Each #28278 slice adds the rows for the paths it moves, so a move and the
 * compatibility it owes land in one commit.
 *
 * Every row is compatibility debt under #26701's removal gate: a row is removed
 * only under its evidence rules.
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
 *
 * #28711 then took forty-two of those forty-six traffic-bearing rows, leaving
 * 142. Their branded forms had gone quiet for longer than any window that can
 * hold their callers. Two facts about that evidence are worth keeping, because
 * the next removal will meet them again:
 *
 * - `x_client_version` does not separate CLI builds. The commit-addressed
 *   packages either side of a #28278 slice share one semver, so the same
 *   version reports both branded and neutral requests. Only the pinning window
 *   bounds the CLI tail; the version field proves nothing about migration.
 * - A row's caller mix decides which window applies, so it has to be measured
 *   per row rather than assumed per slice. #28711 was scoped as CLI-only work
 *   and twelve of its rows turned out to have a web-app caller too, which is
 *   the ~2 day bundle window rather than the two-hour one. Group the log by
 *   `x_client_type` before reading a silence as a drain.
 *
 * #28917 then took fifty-three of the 142, leaving 89. Every one of them was
 * silent on both branded forms across the whole retained window — 2026-08-20
 * 06:34Z to 2026-08-24 08:28Z, 4.1 days, all 685 distinct branded templates
 * pulled without truncation and matched with `:param` rewritten to `[^/]+`.
 * Three whole slices drained: #28417 (maps), #28357 (weather) and #28418
 * (browser, finance, SEO) no longer have a row here.
 *
 * Silence alone is weak for the rarer rows, so it was corroborated rather than
 * trusted: for thirty-five of the fifty-three the neutral path carried traffic
 * inside the same window while both branded forms stayed at zero, and no
 * shipped CLI, desktop or platform build emits a branded literal for any of
 * them. The desktop build's entire hardcoded surface is `auth/me`,
 * `computer-use/{heartbeat,host/*,hosts/start}`, `desktop/{updates,
 * migration-policy}`, `feature-switches` and `org`, and #28917 kept every one
 * of those rows; #30804 later retired the Computer Use host rows and
 * `feature-switches` from it.
 *
 * Three rows the #28917 inventory listed were held back, and each names a way
 * a zero-count reading fails:
 *
 * - `integrations/teams/oauth/callback`. `callbackRedirectUri` in
 *   `routes/teams-oauth.ts` still emitted its `zero` form for the VM0 brand
 *   then, so the row was an active producer target that no window could drain
 *   and no count could retire. #30667 unified that producer onto the canonical
 *   path; see the comment on the row itself.
 * - `computer-use/hosts/start` and `computer-use/host/stop`. Both are
 *   hardcoded in every Desktop build up to 0.38.53, and those builds were
 *   still sending branded `heartbeat` and `host/commands/next` inside this
 *   window. Start and stop fire once per session, so at the measured rate the
 *   branded count they should produce over four days is under one request.
 *   Zero is not a drain; it is the absence of statistical power.
 *
 * The general rule those three leave behind: a zero count retires a row only
 * when the row's caller both has a bounded window and would have been expected
 * to appear in the window at all. Check the call rate before reading a silence.
 *
 * #28916 then took twenty-six more. Its set is disjoint from #28917's: those
 * rows were silent, these were not. Each of these carried branded traffic early
 * in the same window and went to exactly zero once its producer cut over, with
 * the neutral path taking the same calls from the same callers on the same day.
 * Across the twenty-six the crossover is direct — branded 10/2415/27/0/0
 * against neutral 0/3425/6605/13822/3810 on 08-20 through 08-24. An observed
 * cutover is stronger than a silence, because it names the build that stopped
 * emitting the branded form rather than only the absence of a request. Two more
 * facts about reading this log:
 *
 * - `x_client_type` is absent on some released callers, so it cannot be the
 *   only field a caller is classified by. The desktop Computer Use host sends
 *   no client headers at all and appears as `user_agent: node`; classifying by
 *   `x_client_type` alone read it as an anonymous caller and put two rows of
 *   that family on this removal's list. Group by `user_agent` as well, and hold
 *   a row whose caller is an installed build under the exclusion above.
 * - A conditional endpoint is quiet for reasons that have nothing to do with a
 *   drain. `computer-use/host/commands/:commandId/complete` is called only when
 *   a write command finishes, so its silence measures how often that happened,
 *   not whether the caller of `host/commands/next` — which this table held at
 *   the time, and #30804 has since removed — is still there. Read a row against
 *   the traffic of the loop it belongs to, not only against its own. This is
 *   #28917's call-rate rule reached from the other direction.
 *
 * A production traffic sweep does not see this repository's own CI. E2E runs
 * against preview deployments, so a row called only by a workflow step or an
 * `e2e/` helper reads as zero-traffic in `vm0-request-log-prod` and looks
 * drained when it is not — the next E2E run after its removal is what finds
 * out. Six rows were held open by CI alone until #29169 moved those callers to
 * neutral paths. Before removing a row, grep `e2e/`, `.github/scripts/` and
 * `.github/workflows/` for both of its branded forms; treat a hit as a caller
 * to repoint in the same commit, not as evidence the row is still owed. That
 * grep returns nothing today, and this note is here so it stays that way.
 *
 * #30668 then took the four Slack rows whose producer moved, leaving 58. Every
 * removal before it waited for a caller to drain; these four retired because
 * the thing emitting the branded URL was repointed, which is a stronger reading
 * than either a silence or an observed cutover — the branded form has no
 * producer left rather than no recent caller. The Slack app console holds the
 * three webhook URLs and `routes/slack-oauth.ts` emits the callback's
 * `redirect_uri`; the rows they serve carry the detail.
 *
 * That distinction is the rule worth keeping, because the same sweep proposed
 * two more rows and neither survived it. A producer that emits a URL per
 * request is bounded by its own deploy; a producer that hands a URL to a person
 * is not, because the link outlives every deploy in a message, a bookmark or a
 * search index. `slack/oauth/install` and `slack/oauth/connect` are the second
 * kind, and `slack/oauth/install` proves it: its `zero` form was still taking
 * browser and crawler requests ten hours after the deploy that was supposed to
 * have drained it. Ask which of the two a producer is before reading a deploy
 * as a drain.
 *
 * #30804 then took the four Computer Use host rows and `feature-switches`,
 * leaving 53. Those five held the last branded traffic an installed Okou
 * Desktop build produced, and the reading that retired them is neither a
 * silence nor a repointed producer: every branded request in the window came
 * from a machine that was already running a current build on the neutral paths
 * on either side of it. Two addresses emitted all eighteen, one at
 * `x_client_version` 0.38.2 over thirty-four seconds on 08-30 and one at
 * 0.34.0 for a single `feature-switches` read on 09-01, and both addresses
 * report 0.40.4 by the end of the window. An old build launched briefly beside
 * a current one is not a caller with a window to wait out, which is why this
 * removal is an owner decision — recorded on #30804 — rather than a drain.
 *
 * What that leaves for the next sweep to reuse: read `x_client_version`
 * per address over the whole window, not only on the branded requests. A
 * version far below the current one looks like a stranded install until the
 * same address is seen on the current version an hour later. The host
 * inventory does not settle it either — the two `computer_use_hosts` rows below
 * 0.38.100 that were active in the same week sent no request in this window at
 * all, and the versions that did send one have no row.
 *
 * #30812 then took `integrations/teams/oauth/callback` and
 * `slack/oauth/connect`, leaving 51, and refines that rule in the direction the
 * two of them expose. Which kind a producer is turns out to be a property of
 * the link rather than of the function: `buildSlackConnectUrl` is the same
 * shape as `buildSlackInstallUrl` and hands the same kind of URL to the same
 * kind of person, and the difference between them is only that two marketing
 * landing pages publish an install `href` and nothing publishes a connect one.
 * So the second kind is retired by finding where the link was published rather
 * than by waiting, and the evidence that settles it is a differential in one
 * window: the crawler population that found `/api/zero/slack/oauth/install`
 * twenty times found no form of `slack/oauth/connect` at all. The Teams
 * callback is the first kind and drained on its deploy, `chat_teams_context`
 * holding zero rows over the whole life of the integration.
 *
 * The retained window is now 4.4 days, 2026-08-27 22:19Z to 2026-09-01 08:48Z.
 * It has not grown since #28917 measured 4.1, so the header's caution about
 * what a silence can carry has not loosened.
 */
type MigratedBrandedPathTable = Readonly<Record<string, readonly string[]>>;

const MIGRATED_BRANDED_PATHS: Readonly<Record<string, readonly string[]>> = {
  // #28421: personal model providers, onboarding, team, and user preferences.
  // #28917 removed `me/model-provider-accounts/:id/activate` and
  // `onboarding/complete`: both branded forms were silent across the whole
  // retained window while their neutral paths carried traffic.
  "/api/me/model-providers": [
    "/api/okou/me/model-providers",
    "/api/zero/me/model-providers",
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
  // #28420. Every caller of these derives its URL from the contract, so
  // nothing in this repository still asks for a branded form. Released builds
  // do: a browser tab holding already-loaded platform code keeps calling the
  // `okou` path it was built against until it navigates or reloads, which is
  // the ~2 day old-web-client window in `docs/fallback.md` section 7. The
  // `zero` form was reachable through the blanket expansion until the contract
  // moved. Both are owed, and both are removable only under #26701's evidence
  // rules, like every other row in this table. #28917 removed
  // `chat-thread-unreads/mark-read` on zero-traffic evidence.
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
  "/api/indicators": ["/api/okou/indicators", "/api/zero/indicators"],
  // #28422: logs and the platform realtime token, all that is left of the
  // artifact catalog, push subscription and run rows the slice moved. #28917
  // removed the per-artifact catalog read and every run row but the agent
  // telemetry read — `runs/:id`, its `context`, `network` and `runner` reads,
  // and `runs/queue` — because their branded forms were silent across the whole
  // retained window while the neutral paths carried the same callers. #28916
  // then removed the three that were not silent — the catalog collection, push
  // subscriptions and that agent telemetry read — because the platform build
  // holding their branded forms cut over mid-window and the branded traffic
  // stopped dead.
  "/api/logs/:id": ["/api/okou/logs/:id", "/api/zero/logs/:id"],
  "/api/realtime/token": [
    "/api/okou/realtime/token",
    "/api/zero/realtime/token",
  ],
  // #28459: the chat threads themselves, the chat event reader, the per-thread
  // browser read, and workflow automations.
  // The slice also covered shared threads, queue position and the X image
  // share; #28709 removed those rows on zero-traffic evidence, which is why the
  // `okou-app` share worker no longer appears among the holders below. #28711
  // removed the search reader, `chat-threads/:id/metadata` and
  // `chat-threads/:id/rename` on drained-traffic evidence, and #28917 removed
  // `chat-threads/:id/computer-use-host`, `chat-threads/:id/unpin` and both
  // per-thread goal rows, which is why goals no longer appear below. #28916
  // removed `chat-threads/:id/model-selection` and the three browser-session
  // writes (`browser/open`, `browser/lease`, `browser/close`) on cutover
  // evidence: their branded forms carried platform traffic through 08-22 and
  // then stopped while the neutral forms picked the same calls up. Every
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
  "/api/chat-threads/:id/draft": [
    "/api/okou/chat-threads/:id/draft",
    "/api/zero/chat-threads/:id/draft",
  ],
  "/api/chat-threads/:id/mark-read": [
    "/api/okou/chat-threads/:id/mark-read",
    "/api/zero/chat-threads/:id/mark-read",
  ],
  "/api/chat-threads/:id/pin": [
    "/api/okou/chat-threads/:id/pin",
    "/api/zero/chat-threads/:id/pin",
  ],
  "/api/chat-threads/:threadId/artifacts": [
    "/api/okou/chat-threads/:threadId/artifacts",
    "/api/zero/chat-threads/:threadId/artifacts",
  ],
  "/api/chat-threads/:threadId/browser": [
    "/api/okou/chat-threads/:threadId/browser",
    "/api/zero/chat-threads/:threadId/browser",
  ],
  "/api/chat-threads/:threadId/event-rows": [
    "/api/okou/chat-threads/:threadId/event-rows",
    "/api/zero/chat-threads/:threadId/event-rows",
  ],
  "/api/chat-threads/:threadId/event-snapshot": [
    "/api/okou/chat-threads/:threadId/event-snapshot",
    "/api/zero/chat-threads/:threadId/event-snapshot",
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
  // #28457: the billing surface — plan and usage-pack checkout, concurrency
  // subscriptions, credit purchase, the Stripe portal, invoices, and code
  // redemption, of which only the status read is still owed. Every caller
  // derives its URL from the contract, so nothing in
  // this repository asks for a branded form, but released builds still do: an
  // already-loaded platform tab keeps calling the `okou` path it was built
  // against for the ~2 day old-web-client window in `docs/fallback.md` section
  // 7, and a CLI package pinned by an execution context's `CLI_PKG_URL` embeds
  // the contract path it was built from for that context's queue and claimed-run
  // lifetime. The `zero` form was reachable through the blanket expansion until
  // the contract moved. Both forms are removable only under #26701's evidence
  // rules, like every other row here.
  //
  // #28917 removed nine of these rows — both concurrency-checkout rows, the
  // concurrency subscription change preview, the credit-checkout confirm, the
  // Stripe portal, code redemption, purchase restore, the usage-pack checkout,
  // and both usage-pack subscription-change rows. Several of them fire only on
  // a user action that need not occur inside a four-day window, so the reading
  // rests on the corroborating sweep as much as on the silence: no shipped CLI,
  // desktop, or platform build emits a branded literal for any of them, and
  // every caller derives its URL from a contract that has declared the neutral
  // path since #28457. `/api/zero/billing/concurrency-checkout/preview` was
  // among the nine: it carried measured traffic when #28701 dropped its row
  // from the legacy-path table, and these rows are what served it after, but
  // the retained window recorded no request on either branded form.
  //
  // #28916 then removed the six that were not silent — plan checkout, invoices,
  // `usage-pack-catalog`, `usage-pack-credits`, `usage-pack-migration` and
  // `usage-pack-subscription`. Those did carry branded traffic, and it stopped
  // when the platform build holding the branded forms cut over; the last
  // branded request on any of the six was `billing/checkout` at 2026-08-22
  // 20:08 UTC, with the neutral paths taking the same callers from 08-23 on.
  "/api/billing/status": [
    "/api/okou/billing/status",
    "/api/zero/billing/status",
  ],
  // #28466: the desktop Computer Use family. The highest-traffic branded family
  // in the repository — about 716,000 requests over the retained request-log
  // window — and the one with the longest-lived callers: `computer-use-host.ts`
  // in an installed Desktop build hardcodes the `okou` form of the host
  // endpoints, and an installed build updates on its owner's schedule rather
  // than on a deploy, so it has no window at all. The `zero` form carried
  // measured traffic of its own and was reachable through the blanket expansion
  // until the contract moved. Both are owed on all three remaining paths.
  //
  // The slice had sixteen. #28709 removed the three authorization-request rows,
  // `commands/:commandId/plugin-content` and `plugin-commands` on zero-traffic
  // evidence, and #28711 removed `commands`, `commands/:commandId`,
  // `commands/:commandId/screenshot` and `write-commands`: those four are the
  // agent side of the family, called by the CLI rather than by an installed
  // Desktop build, and the log measured no Desktop caller on their branded
  // forms at all. The host endpoints the Desktop build hardcodes are untouched.
  //
  // #28917 measured `hosts/start` and `host/stop` silent on both branded forms
  // and kept them anyway, because for this family silence is not drain
  // evidence. Both are hardcoded — see `computer-use-host.ts` at 5edd3c9c^ —
  // in every Desktop build up to 0.38.53, and those builds were still sending
  // `/api/okou/computer-use/heartbeat` and `/api/okou/computer-use/host/
  // commands/next` inside the same window. Start and stop fire once per
  // session, so the branded count they should produce over four days is under
  // one request: the neutral paths took ~70 each against ~130,000 neutral
  // `host/commands/next`. Zero is what a fully live caller looks like at that
  // rate. Removing them would also strand a build that can still poll and
  // heartbeat but can no longer open or close a session.
  //
  // Four of these paths — `host/commands/next`, `audit-events`, `heartbeat`,
  // and `hosts/start` — were served by the legacy-path table #30667 deleted
  // before this move and are served by these rows after it: the contract no
  // longer declares a branded path for the expansion to derive. #28701 dropped
  // their rows from that table once it was clear these rows are what serve
  // them. Removal of these follows #26701's evidence rules like every other row
  // here.
  //
  // #30804 removed `heartbeat`, `host/commands/next`, `hosts/start` and
  // `host/stop` together, so #28917's reason for holding start and stop no
  // longer applies: the loop they open and close is not registered on a branded
  // form any more either. All four were still measured, and what retired them is
  // what the measurement said about the caller rather than its size. Every
  // branded request in the 2026-08-27 22:19Z to 2026-09-01 08:26Z window came
  // from one address at `x_client_version` 0.38.2 inside thirty-four seconds
  // on 08-30 — `feature-switches` 09:17:31, `hosts/start` 09:17:42, `heartbeat`
  // and `host/commands/next` through 09:18:04, `host/stop` 09:18:05 — and that
  // same address ran 0.38.106 through 0.40.4 on the neutral paths continuously
  // either side of it, including 0.38.121 at that minute. It is an old build
  // launched next to a current one, not an install that never updated, so there
  // is no drain to wait for; the two colleagues who can launch it were told
  // directly. The neutral paths carried 329,913 heartbeats and 155,949 command
  // polls in the same window.
  //
  // #28916 listed `audit-events` and `host/commands/:commandId/complete` for
  // removal and both were kept, for the mirror image of #28917's reason. All of
  // their branded traffic came from the desktop host loop, which sends no
  // client headers and shows up as `user_agent: node` with a null
  // `x_client_type` — the same installed build this comment names, not the
  // anonymous caller an `x_client_type`-only grouping reported. `complete` is
  // worse than quiet: it is only called when a write command finishes, so its
  // silence measures how often that happened rather than whether its caller is
  // there. #30804 did not list either one, so both stay; over-retention is the
  // safe direction, and neither has been measured under the reading that
  // retired the four rows above. `hosts` stays for a different caller
  // altogether — the platform host list, 17,207 neutral requests in the same
  // window, not the desktop host loop.
  //
  // A key holds its path parameter verbatim, because the lookup below matches
  // `entry.route.path` exactly rather than an expanded request path.
  "/api/computer-use/audit-events": [
    "/api/okou/computer-use/audit-events",
    "/api/zero/computer-use/audit-events",
  ],
  "/api/computer-use/host/commands/:commandId/complete": [
    "/api/okou/computer-use/host/commands/:commandId/complete",
    "/api/zero/computer-use/host/commands/:commandId/complete",
  ],
  "/api/computer-use/hosts": [
    "/api/okou/computer-use/hosts",
    "/api/zero/computer-use/hosts",
  ],
  // #28423: the integration control plane and the CLI messaging and file
  // surfaces. The slice covered Feishu, Slack, Microsoft Teams, Telegram,
  // GitHub, AgentPhone and Strapi; #28709 removed the Telegram, GitHub,
  // AgentPhone and Feishu messaging and file rows on zero-traffic evidence, and
  // #28917 removed the Feishu and Strapi control-plane reads on the same
  // evidence. #28916 then removed `integrations/teams/connect`, the last Teams
  // row here, on cutover evidence, so what remains is the Slack messaging and
  // file surface plus the Slack control-plane read. The #28709 removal also
  // retired
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
  // #28460: the connector catalog, the connector connections and their
  // authorization starts, the custom connectors, the model provider
  // connections, and the user permission grants. #28711 removed the slice's
  // `connector-catalog/:connectorSlug/permissions`, `connectors`,
  // `connectors/:connectorSlug` and `connectors/diagnostics/check` rows once
  // the log showed their callers drained, and #28917 removed
  // `connector-catalog/diagnostics`, `connectors/:connectorSlug/manual-grant`,
  // `model-provider-connections` and `user-permission-grants/apply` on
  // zero-traffic evidence. #28916 removed `connector-catalog/discovery`,
  // `connectors/:connectorSlug/oauth/start` and the `user-permission-grants`
  // collection on cutover evidence. `/api/connector-catalog/status` stays: an
  // earlier pass batched these rows into one APL `case()`, which returns the
  // first match, so `connector-catalog/:connectorSlug` absorbed its seven
  // requests and hid them. Attribute a logged path to every row whose pattern
  // matches it.
  //
  // Two surfaces hold the branded paths
  // that remain. A released web or app build keeps calling the form it was
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
  "/api/connector-catalog/status": [
    "/api/okou/connector-catalog/status",
    "/api/zero/connector-catalog/status",
  ],
  "/api/custom-connectors": [
    "/api/okou/custom-connectors",
    "/api/zero/custom-connectors",
  ],
  // #28464: the Slack, Teams, and Feishu connect and OAuth-start routes, of
  // which #28709 kept only the Slack rows — the Teams and Feishu connect and
  // OAuth-start rows had no request on either branded form in the retained
  // window. The paths a provider console holds were not in this slice; they
  // moved in #28600, and #30668 retired every one of those rows.
  //
  // These rows hold two surfaces open. A released web or app build keeps the
  // branded path it was compiled against until a refresh loads a build that
  // derives the neutral one, the ~2 day window in `docs/fallback.md` section 7.
  // `slack/oauth/install` has a second holder that no client version bounds:
  // `buildSlackInstallUrl` in `services/slack-data.service.ts` hands a link to a
  // user, and that link lives in a Slack message, a bookmark or a search index
  // for as long as its holder keeps it. The producer emits the neutral path
  // today, which bounds the links minted from now on and nothing about the ones
  // already out there. `/api/okou/slack/oauth/install` is also the measured
  // traffic the legacy-path table #30667 deleted listed, which only this row
  // can serve.
  //
  // #30668 measured that holder directly rather than reasoning about it.
  // `/api/zero/slack/oauth/install` took 24 requests across the retained
  // window on `api.vm0.ai`, the last at 2026-09-01 01:05:54Z — ten hours after
  // the #30551 deploy that was supposed to have drained it — from search
  // crawlers, the `vm0-seo-health` monitor and browser user agents on distinct
  // addresses, every one answered 307. The branded install URL is published
  // somewhere a crawler can reach, so it has no drain window at all.
  //
  // #30812 removed `slack/oauth/connect`, the sibling row, and the two are why
  // "a producer hands a URL to a person" is a property of the link rather than
  // of the function that builds it. `buildSlackConnectUrl` is the same shape as
  // `buildSlackInstallUrl` and emits the same neutral path, but no page
  // publishes a connect link: the two hardcoded `href`s that kept the branded
  // install form alive are on the marketing landing pages, both
  // `/api/slack/oauth/install`, and neither has a connect equivalent. The
  // measurement is the differential rather than the silence — over the same
  // 4.4-day window and the same crawler population that found
  // `/api/zero/slack/oauth/install` twenty times, all three forms of
  // `slack/oauth/connect` took zero requests, the neutral one included. A
  // published branded link would have been found the same way.
  //
  // Removal follows the #26701 evidence gate like every other row, not either
  // clock.
  "/api/slack/channels": [
    "/api/okou/slack/channels",
    "/api/zero/slack/channels",
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
  // usage reads, of which only model policies and the org profile are still
  // owed. Three surfaces held these branded paths open, and the widest one is
  // why the rows matter more here than in most slices:
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
  // #28917 removed the three `model-providers/codex/device-auth/sessions`
  // rows, the three `org/invite` rows, and `usage/members`. None of them has a
  // desktop caller — the installed build hardcodes only `/api/okou/org` and
  // `/api/okou/feature-switches`, both kept then — and every one was silent on
  // both branded forms across the retained window.
  //
  // #30804 removed `feature-switches` and kept `org`, which is the whole point
  // of measuring the first surface per row rather than per slice. The desktop
  // build hardcodes both, and in the 2026-08-27 22:19Z to 2026-09-01 08:26Z
  // window both took branded requests from it — three on `feature-switches`,
  // four on `org` — but only `org` has a second producer. A `CLI_PKG_URL`-pinned
  // CLI at 9.279.3 read `/api/zero/org` on 08-31 03:58, 08-31 08:52 and 09-01
  // 02:10, each answered 200, so that row still serves a caller with a live
  // pinning window. The `feature-switches` requests came from the two desktop
  // addresses alone — 0.38.2 at 08-30 09:17:31 and 0.34.0 at 09-01 03:11:31 —
  // and both addresses were running 0.40.4 on the neutral path by the end of the
  // window, so what the row was holding open was a briefly launched old build
  // rather than an install still on its way to updating.
  //
  // #28916 removed the four that were not silent — the `model-providers`
  // collection, `org/logo`, `org/members` and `usage/record`. All four were
  // platform-held, and the build holding their branded forms cut over on 08-21.
  //
  // The CI bootstrap steps in `.github/workflows/turbo.yml` used to call
  // `/api/okou/model-providers` on purpose, to exercise the compatibility these
  // rows guarantee; #28916 repointed them at the neutral path along with the
  // row itself, so no check depends on a row this table may retire. None of
  // those windows is the removal condition — a row retires under #26701's
  // evidence rules like every other row in this file.
  //
  // A key holds its path parameter verbatim, because the lookup below matches
  // `entry.route.path` exactly rather than an expanded request path.
  "/api/model-policies": [
    "/api/okou/model-policies",
    "/api/zero/model-policies",
  ],
  "/api/org": ["/api/okou/org", "/api/zero/org"],
  // #28461: the agent reads and writes and the workflow and
  // workflow-automation management routes. #28711 removed
  // `agents/:id/instructions`, `workflow-automations`,
  // `workflows/:workflowId`, `workflows/:workflowId/automations` and
  // `workflows/:workflowId/run` on drained-traffic evidence; #28917 removed
  // `workflow-automations/:id/enable` and `workflow-automations/:id/disable`,
  // which were silent on both branded forms while the neutral paths served
  // them. #28916 removed the `agents` collection and `workflow-automations/:id`
  // on cutover evidence. The branded `agents` form was platform-held and
  // stopped on 08-21; the CLI took `workflow-automations/:id` to the neutral
  // form mid-window, and the only caller its branded form had left was two
  // ad-hoc `curl` requests out of a sandbox, which is not a released build with
  // a drain window. Every caller in
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
  "/api/agents/:id": ["/api/okou/agents/:id", "/api/zero/agents/:id"],
  "/api/agents/:id/custom-connectors": [
    "/api/okou/agents/:id/custom-connectors",
    "/api/zero/agents/:id/custom-connectors",
  ],
  "/api/agents/:id/draft": [
    "/api/okou/agents/:id/draft",
    "/api/zero/agents/:id/draft",
  ],
  "/api/agents/:id/user-connectors": [
    "/api/okou/agents/:id/user-connectors",
    "/api/zero/agents/:id/user-connectors",
  ],
  "/api/workflows": ["/api/okou/workflows", "/api/zero/workflows"],
  // #28545 added the Microsoft console routes, the first rows whose branded
  // forms a provider console held rather than a released client, and #30812
  // removed the last of them. #28917 took the slice's `webhooks/teams/bot` row
  // once an operator had repointed the Azure Bot messaging endpoint at the
  // neutral path, and #30812 took the OAuth callback.
  //
  // The callback is the one row in this table whose producer moved and whose
  // holder still had to drain, so it is worth keeping why both halves were
  // needed. `callbackRedirectUri` in `routes/teams-oauth.ts` was
  // brand-conditional and emitted `/api/zero/teams/oauth/callback` for the VM0
  // brand, which made the row an active producer target no traffic sweep could
  // retire — a quiet window meant nobody connected Teams under the VM0 brand
  // that week, and the next person who did was sent there regardless. #28917
  // listed the row for removal on that silence and it was held back for exactly
  // that reason. #30667 unified the producer onto the canonical path, leaving
  // only authorizations already in flight, and unlike a handed-out link a
  // `redirect_uri` is computed per request: the deploy bounds it to the minutes
  // an OAuth authorization stays valid, which had passed many times over by the
  // time this row was removed.
  //
  // The window then measured both branded forms at one request — `curl/8.5.0`
  // answered 400, which the table header's rules exclude and which carried no
  // authorization anyway — against zero on the neutral path. No Teams message
  // has ever been ingested: `chat_teams_context` holds zero rows, so no
  // authorization has ever completed on either brand. The Microsoft app
  // registration keeps both branded values, which costs nothing now that
  // nothing is sent there.
  // #28463: avatar video generation, the per-token browser authorization
  // requests, mail drafts, the per-template presentation read, uploads,
  // voice-io quota and speech, and the web file-url read. The slice also
  // covered banking, inbound email, the GitHub user-connect start, the Strapi
  // webhook and video-io; #28709 removed those rows on zero-traffic evidence,
  // which is why `domains/banking.ts` and the customer-held Strapi console URL
  // no longer appear among the holders below.
  //
  // #28711 removed nine more: the two avatar-video catalog reads,
  // `browser/authorization-requests`, `mail/drafts/link`, `people-search`, the
  // `presentation-templates` collection, `uploads/complete`, `voice-io/stt` and
  // `web/download-file`. The last two were platform-held alongside
  // `web/file-url`, so their gate was the ~2 day web-client window rather than
  // the CLI pinning window; the log measured both branded forms silent for
  // longer than that before the removal.
  //
  // #28917 removed five more on zero-traffic evidence: both per-token browser
  // authorization-request rows, `mail/drafts/:mailDraftId/send`, the
  // per-template presentation read, and `uploads/multipart/abort`.
  //
  // #28974 removed `uploads/prepare`. #28916 and #28917 had both excluded it
  // under "rows with a Desktop or CLI caller stay, because installed builds
  // have no expiry window", which misreads its callers: neither is an installed
  // build. The CLI caller runs under the pinned `CLI_PKG_URL` described below,
  // and the App caller is the browser bundle on its ~2 day refresh. Both had
  // visibly crossed over in the log — every App build up to `0.779.x` called
  // the branded form and every build from `0.780.0` called the neutral one,
  // with no version on both sides of the split.
  //
  // #28916 removed the three that were not silent — the mail draft read,
  // `uploads/multipart/complete` and `web/file-url` — on cutover evidence.
  // `web/file-url` was the largest branded producer in that removal at about
  // 2,000 requests, and the clearest crossover in it: the platform build cut
  // over on 08-22 and the neutral path took every call from the same browsers
  // from 08-23 on, which is why `domains/web.ts` no longer appears among the
  // holders below. What the slice still owns below is the two voice-io rows.
  //
  // Published CLI builds hold the `okou` form directly: they build some URLs by
  // hand rather than from the contract, so the path they carry shipped
  // independently of this table, and a run execution context pins its
  // commit-addressed `CLI_PKG_URL` at creation — the queue lifetime plus
  // claimed execution bounded by the runner's 2h `JOB_TIMEOUT`. A released
  // platform build holds the branded form until a refresh loads a build that
  // derives the neutral path (~2 days). Every `zero` form was reachable through
  // the blanket expansion until these contracts moved, which has no window at
  // all. Removal therefore follows the #26701 evidence gate above rather than
  // any of those clocks.
  "/api/voice-io/quota": [
    "/api/okou/voice-io/quota",
    "/api/zero/voice-io/quota",
  ],
  "/api/voice-io/speech": [
    "/api/okou/voice-io/speech",
    "/api/zero/voice-io/speech",
  ],
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
  // #28600 added the last branded contract paths — the Slack OAuth callback and
  // the three inbound Slack webhooks — and #30668 removed all four. They are
  // the first rows in this table to retire because their producer moved rather
  // than because a caller drained, and each producer is now the neutral path:
  //
  // - The Slack app console `A0AD6KS3D32` holds one URL per endpoint, so
  //   repointing Event Subscriptions, Interactivity and the `/okou` command at
  //   `api.okou.ai/api/webhooks/slack/*` left the branded forms with no holder
  //   at all. Slack returned `Verified` for the events URL, and the log shows
  //   the delivery arriving at the new one rather than only the old one going
  //   quiet: every neutral webhook path took requests from `user_agent:
  //   Slackbot 1.0`, Slack's own infrastructure, on 2026-08-31 — `events` from
  //   08:56:33Z and still every few minutes, `commands` at 09:02:28Z,
  //   `interactive` at 08:58:28Z. `/api/zero/slack/events` took its last of 53
  //   requests at 08:54:51Z. None of the three needs a silence argument: the
  //   holder was observed posting somewhere else.
  // - `callbackRedirectUri` in `routes/slack-oauth.ts` emits the callback as
  //   the `redirect_uri` sent to Slack, and #30551 deployed it emitting
  //   `/api/integrations/slack/oauth/callback` at 2026-08-31 15:01Z. The
  //   registered redirect URL was added to the console first, so no
  //   authorization was ever sent a URI the console did not hold. Unlike a
  //   handed-out link, a `redirect_uri` is computed per request, so the deploy
  //   bounds the branded form to authorizations already in flight; both branded
  //   forms took no request in the retained window.
  //
  // What is left of the Slack surface in this table is client-driven and stays:
  // the messaging and file rows above, `slack/channels`, and the two OAuth-start
  // paths whose links a user still holds.
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
