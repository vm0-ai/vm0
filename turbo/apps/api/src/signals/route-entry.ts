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
 * migration-policy}`, `feature-switches` and `org`, and every one of those
 * rows is kept.
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
 *   not whether the caller of `host/commands/next` — which this table still
 *   holds — is still there. Read a row against the traffic of the loop it
 *   belongs to, not only against its own. This is #28917's call-rate rule
 *   reached from the other direction.
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
 * #30807 then took forty-three rows at once and left 15. It is the first
 * removal argued as a class rather than row by row, and it rests on two facts
 * that hold for the whole set. No live source emits a branded path: a sweep of
 * `turbo/` outside tests, this file and `api-namespaces.ts` finds no
 * `/api/okou/**` or `/api/zero/**` string literal, and `packages/api-contracts`
 * declares no branded contract path at all after #28984, so every caller in
 * every shipped build derives the neutral path from a contract. The exception
 * is a build that hardcodes the path instead of deriving it, and there is
 * exactly one: the installed macOS Desktop app. Its entire branded surface at
 * `6c2036fa`, the commit before #28487 moved it, is `auth/me`, `org`,
 * `feature-switches`, the stable `desktop/updates` DMG and the five
 * `computer-use` host endpoints — and every row those name is kept. The two
 * remaining holders recover on their own: `apps/platform/public/sw.js`
 * registers only `install`, `push` and `notificationclick`, has no `fetch`
 * handler and never touches the Cache API, so no service worker can pin an old
 * bundle and a stale tab recovers on reload; and the CLI resolves from
 * `CLI_PKG_URL`, which the API deploy rewrites, so it swaps with the API.
 *
 * Measured over the retained window 2026-08-27 22:19Z to 2026-09-01 08:32Z with
 * `user_agent` containing `curl` excluded — that field held nothing but this
 * migration's own probes — the log carries seventeen distinct branded templates
 * in total and fifteen once `curl` is dropped, pulled without truncation and
 * matched with `:param` rewritten to `[^/]+`. Not one of them matches any of
 * the forty-three. Thirty-seven of the removed rows also had live neutral
 * traffic in the same window against zero branded, which is the crossover
 * reading #28916 relied on. The other six — `computer-use/audit-events`,
 * `slack/channels` and the four `integrations/slack` rows that are not the
 * status read — were silent on the neutral path too, so they retire on the
 * producer sweep rather than on a count, which is the distinction #30668
 * recorded.
 *
 * That sweep's inventory also listed
 * `computer-use/host/commands/:commandId/complete`, and it was held back for
 * the third time; the comment on the row itself carries the reason.
 */
type MigratedBrandedPathTable = Readonly<Record<string, readonly string[]>>;

const MIGRATED_BRANDED_PATHS: Readonly<Record<string, readonly string[]>> = {
  // #28422: all that is left of the logs, artifact catalog, push subscription
  // and run rows the slice moved. #28917 removed the per-artifact catalog read
  // and every run row but the agent telemetry read; #28916 then removed the
  // catalog collection, push subscriptions and that agent telemetry read on
  // cutover evidence; and #30807 removed `realtime/token`, whose neutral path
  // took 40,982 requests from the platform bundle in the same window its
  // branded forms took none. `/api/zero/logs/:id` was not in that removal: it
  // took two requests inside the window from a caller reporting no client type.
  "/api/logs/:id": ["/api/okou/logs/:id", "/api/zero/logs/:id"],
  // #28466: the desktop Computer Use family, and the one place left in this
  // table where an installed build hardcodes a branded path rather than
  // deriving it from a contract. `computer-use-host.ts` at `6c2036fa`, the
  // commit before #28487 moved it, spells out the `okou` form of
  // `computer-use/hosts/start`, `heartbeat`, `host/commands/next`,
  // `host/commands/${commandId}/complete` and `host/stop`, and an installed
  // build updates on its owner's schedule rather than on a deploy, so it has no
  // window at all. Both branded forms are owed on all five.
  //
  // The slice had sixteen rows. #28709 removed the three authorization-request
  // rows, `commands/:commandId/plugin-content` and `plugin-commands` on
  // zero-traffic evidence, and #28711 removed `commands`, `commands/:commandId`,
  // `commands/:commandId/screenshot` and `write-commands`: those four are the
  // agent side of the family, called by the CLI rather than by an installed
  // Desktop build. #30807 then removed `audit-events` and the `hosts`
  // collection, the two the Desktop build does not hardcode — `hosts` is a
  // platform read that took 17,293 neutral requests from 397 addresses against
  // zero branded, and `audit-events` has no caller in this repository at all,
  // which is why its neutral path is silent too.
  //
  // #28917 measured `hosts/start` and `host/stop` silent on both branded forms
  // and kept them anyway, because for this family silence is not drain
  // evidence. Both are hardcoded in every Desktop build up to 0.38.53, and
  // those builds were still sending branded `heartbeat` and
  // `host/commands/next` inside that window. Start and stop fire once per
  // session, so at the measured rate the branded count they should produce is
  // under one request: zero is what a fully live caller looks like there.
  // Removing them would also strand a build that can still poll and heartbeat
  // but can no longer open or close a session.
  //
  // `host/commands/:commandId/complete` is that reading reached from the other
  // direction, and it has now been held back three times — by #28916, by #28917
  // and by #30807, whose class argument reaches every other row it listed. It
  // is called only when a write command finishes, so its silence measures how
  // often that happened rather than whether its caller is gone. The #30807
  // window puts a number on it: 239 neutral completions against 156,270 neutral
  // `host/commands/next`, so the four branded polls Desktop `okou` 0.38.2 sent
  // in that window should produce 0.006 branded completions. Removing it would
  // 404 the completion half of a loop whose polling half is kept on purpose,
  // which is the failure `hosts/start` and `host/stop` avoid; #30804 is what
  // retires the loop as a whole.
  //
  // Four of these paths were served by the legacy-path table #30667 deleted
  // before this move and are served by these rows after it: the contract no
  // longer declares a branded path for the expansion to derive. Removal of them
  // follows #26701's evidence rules like every other row here.
  //
  // A key holds its path parameter verbatim, because the lookup below matches
  // `entry.route.path` exactly rather than an expanded request path.
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
  "/api/computer-use/hosts/start": [
    "/api/okou/computer-use/hosts/start",
    "/api/zero/computer-use/hosts/start",
  ],
  // #28464: the Slack, Teams, and Feishu connect and OAuth-start routes, of
  // which #28709 kept only the Slack rows and #30807 then removed
  // `slack/channels`, whose branded forms took nothing while every caller in
  // every shipped build derives the neutral path from the contract. The paths a
  // provider console holds were not in this slice; they moved in #28600, and
  // #30668 retired every one of those rows.
  //
  // What is left has a holder that no client version bounds:
  // `buildSlackInstallUrl` and `buildSlackConnectUrl` in
  // `services/slack-data.service.ts` hand a link to a user, and that link lives
  // in a Slack message, a bookmark or a search index for as long as its holder
  // keeps it. Both producers emit the neutral path today, which bounds the
  // links minted from now on and nothing about the ones already out there.
  // `/api/okou/slack/oauth/install` is also the measured traffic the
  // legacy-path table #30667 deleted listed, which only these rows can serve.
  //
  // #30668 measured that holder directly rather than reasoning about it.
  // `/api/zero/slack/oauth/install` took 24 requests across the retained
  // window on `api.vm0.ai`, the last at 2026-09-01 01:05:54Z — ten hours after
  // the #30551 deploy that was supposed to have drained it — from search
  // crawlers, the `vm0-seo-health` monitor and browser user agents on distinct
  // addresses, every one answered 307. The branded install URL is published
  // somewhere a crawler can reach, so it has no drain window at all, and the
  // #30807 window measured 21 more of them from 19 addresses.
  //
  // `slack/oauth/connect` took no request on any of its three forms in either
  // window, the neutral one included, so its branded silence measures a call
  // rate rather than a drain and cannot retire it — the rule the table header
  // states, reached the same way `computer-use/host/commands/:commandId/
  // complete` reaches it. It also shares a producer with `slack/oauth/install`,
  // whose landing-page buttons were only repointed at 07:04 on 2026-09-01 in
  // `vm0-marketing#523`, so the #30807 window spans its fix and has no clean
  // baseline.
  //
  // Removal follows the #26701 evidence gate like every other row, not either
  // clock.
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
  // forms needs the Desktop-side drain gate tracked by #26364. That is why
  // #28715 held them back, and why #30807's class argument does not reach them
  // either — an installed application has no equivalent of a page refresh.
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
  // usage reads, of which only feature switches and the org profile are still
  // owed. What holds them is an installed desktop build, which hardcodes
  // `/api/okou/org` and `/api/okou/feature-switches` rather than deriving them
  // from a contract, and so has no window at all: it holds those paths until its
  // user updates. Both were still taking branded requests from Desktop `okou`
  // 0.38.2 and 0.34.0 through 2026-09-01, which is why #30807 left them here
  // and #30804 handles `feature-switches` on its own evidence.
  //
  // #28917 removed the three `model-providers/codex/device-auth/sessions` rows,
  // the three `org/invite` rows, and `usage/members`; #28916 removed the
  // `model-providers` collection, `org/logo`, `org/members` and `usage/record`,
  // all four platform-held and cut over on 08-21; and #30807 removed
  // `model-policies`, which has no desktop caller and whose neutral path took
  // 2,104 requests from the platform bundle and the CLI against zero branded.
  //
  // The CI bootstrap steps in `.github/workflows/turbo.yml` used to call
  // `/api/okou/model-providers` on purpose, to exercise the compatibility these
  // rows guarantee; #28916 repointed them at the neutral path along with the
  // row itself, so no check depends on a row this table may retire. None of
  // those windows is the removal condition — a row retires under #26701's
  // evidence rules like every other row in this file.
  "/api/feature-switches": [
    "/api/okou/feature-switches",
    "/api/zero/feature-switches",
  ],
  "/api/org": ["/api/okou/org", "/api/zero/org"],
  // #28461: the agent reads and writes and the workflow and
  // workflow-automation management routes, of which only the workflow
  // collection is still owed. #28711 removed `agents/:id/instructions`,
  // `workflow-automations`, `workflows/:workflowId`,
  // `workflows/:workflowId/automations` and `workflows/:workflowId/run` on
  // drained-traffic evidence; #28917 removed `workflow-automations/:id/enable`
  // and `workflow-automations/:id/disable`; #28916 removed the `agents`
  // collection and `workflow-automations/:id` on cutover evidence; and #30807
  // removed the four per-agent rows, whose neutral paths took traffic from the
  // platform bundle and the CLI throughout its window while both branded forms
  // stayed at zero.
  //
  // `/api/zero/workflows` took four requests inside that window from a caller
  // reporting no client type, so this row is not in that removal. Every caller
  // in this repository derives its URL from the contract; released builds are
  // what still hold the branded form, and two surfaces do.
  //
  // A published CLI package embeds the contract path it was built from and
  // stays pinned by an execution context's `CLI_PKG_URL` — `okou workflow` and
  // `okou workflow automation` are the commands behind this path. That artifact
  // drains over the maximum queue lifetime plus the maximum claimed execution
  // and finalization lifetime, with execution bounded by the runner's 2h
  // `JOB_TIMEOUT`, as `docs/deployment-compatibility.md` describes for
  // commit-addressed CLI artifacts.
  //
  // A browser tab holding already-loaded platform code keeps calling the `okou`
  // path it was built against until it navigates or reloads: the ~2 day
  // old-web-client window in `docs/fallback.md` section 7, and the longer of
  // the two. The `zero` form was reachable through the blanket expansion until
  // the contract moved. Both forms are owed, and both retire under #26701's
  // evidence rules rather than on either clock.
  "/api/workflows": ["/api/okou/workflows", "/api/zero/workflows"],
  // #28545: the Microsoft console routes, the first rows whose branded forms a
  // provider console holds rather than a released client. The Azure Bot
  // messaging endpoint and the Microsoft identity platform redirect URIs now
  // hold the final paths, so the contracts declare them and both branded forms
  // are owed from here.
  //
  // What holds the branded forms open is not a released client but the
  // Microsoft consoles themselves, which have no drain window: they keep
  // sending to whatever URL is registered until an operator changes it.
  // Removal follows #26701's evidence rules.
  //
  // #28917 removed the slice's `webhooks/teams/bot` row. #28545 records that an
  // operator had already repointed the Azure Bot messaging endpoint at the
  // neutral path before that slice landed, so nothing on the Microsoft side
  // still holds either branded bot URL, and the retained window measured both
  // silent. The OAuth callback row below stays for the reason its own comment
  // gives.
  "/api/integrations/teams/oauth/callback": [
    "/api/okou/teams/oauth/callback",
    // `callbackRedirectUri` in `routes/teams-oauth.ts` was brand-conditional
    // and emitted this exact path for the VM0 brand, which made the row an
    // active producer target no traffic sweep could retire: a quiet window
    // meant nobody connected Teams under the VM0 brand that week, and the next
    // person who did was sent here regardless. #28917 listed the row for
    // removal on that silence and it was held back for exactly that reason.
    //
    // #30667 unified the producer onto the canonical path, so what this row
    // now holds open is an authorization that started before that deploy and
    // carries the legacy `redirect_uri` in its state. #30807 kept it out of its
    // class removal because its window spans that unification and so has no
    // clean baseline; the single branded request it did measure came from this
    // migration's own `curl` probe. Removal follows #26701's evidence rules
    // like every other row.
    "/api/zero/teams/oauth/callback",
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
  // the installation was quiet, not that its console moved. It is also why
  // #30807's class argument does not reach this row: the producer is a console
  // we cannot edit rather than a build we ship.
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
  // The key holds its path parameter verbatim, because the lookup below matches
  // `entry.route.path` exactly rather than an expanded request path.
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
  // What is left of the Slack surface in this table is the two OAuth-start
  // paths whose links a user still holds. #30807 removed the messaging and file
  // rows and `slack/channels`: every caller of those derives its URL from the
  // contract, and no shipped build hardcodes one.
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
