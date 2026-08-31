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
 *   `routes/teams-oauth.ts` still emits its `zero` form for the VM0 brand, so
 *   the row is an active producer target. No window can drain it and no count
 *   can retire it; see the comment on the row itself.
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
  // among the nine: it carried measured traffic when #28701 dropped its
  // `LEGACY_ZERO_PATHS` row and these rows are what served it afterwards, but
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
  // until the contract moved. Both are owed on all seven remaining paths.
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
  // and `hosts/start` — were served by `LEGACY_ZERO_PATHS` before this move and
  // are served by these rows after it: the contract no longer declares a
  // branded path for the expansion to derive. #28701 dropped their rows from
  // that table once it was clear these rows are what serve them. Removal of
  // these follows #26701's evidence rules like every other row here.
  //
  // #28916 listed `audit-events` and `host/commands/:commandId/complete` for
  // removal and both were kept, for the mirror image of #28917's reason. All of
  // their branded traffic came from the desktop host loop, which sends no
  // client headers and shows up as `user_agent: node` with a null
  // `x_client_type` — the same installed build this comment names, not the
  // anonymous caller an `x_client_type`-only grouping reported. `complete` is
  // worse than quiet: it is only called when a write command finishes, so its
  // silence measures how often that happened while `host/commands/next`, which
  // this table still holds for the same build, kept being polled. Removing it
  // would 404 the completion half of a loop whose polling half is kept on
  // purpose, which is the same failure `hosts/start` and `host/stop` avoid.
  //
  // A key holds its path parameter verbatim, because the lookup below matches
  // `entry.route.path` exactly rather than an expanded request path.
  "/api/computer-use/audit-events": [
    "/api/okou/computer-use/audit-events",
    "/api/zero/computer-use/audit-events",
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
  // usage reads, of which only feature switches, model policies and the org
  // profile are still owed. Three surfaces hold these branded paths open, and
  // the widest one is why the rows matter more here than in most slices:
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
  // `/api/okou/feature-switches`, both kept — and every one was silent on both
  // branded forms across the retained window.
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
  "/api/feature-switches": [
    "/api/okou/feature-switches",
    "/api/zero/feature-switches",
  ],
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
  // #28545: the Microsoft console routes, the first rows whose branded forms a
  // provider console holds rather than a released client. The Azure Bot
  // messaging endpoint and the Microsoft identity platform redirect URIs now
  // hold the final paths, so the contracts declare them and both branded forms
  // are owed from here.
  //
  // What holds the branded forms open is not a released client but the
  // Microsoft consoles themselves, which have no drain window: they keep
  // sending to whatever URL is registered until an operator changes it.
  // Removal follows #26701's evidence rules, and for the `zero` callback the
  // ordering constraint recorded there.
  //
  // #28917 removed the slice's `webhooks/teams/bot` row. #28545 records that an
  // operator had already repointed the Azure Bot messaging endpoint at the
  // neutral path before that slice landed, so nothing on the Microsoft side
  // still holds either branded bot URL, and the retained window measured both
  // silent. The OAuth callback row below stays for the reason its own comment
  // gives, which is not a drain window and is not measurable in the log at all.
  "/api/integrations/teams/oauth/callback": [
    "/api/okou/teams/oauth/callback",
    // Not drain-window compatibility. `callbackRedirectUri` in
    // `routes/teams-oauth.ts` is brand-conditional and still emits this exact
    // path for the VM0 brand on purpose: it is registered in the Microsoft app
    // registration, and #26701 records that it retires together with the
    // `api.vm0.ai` brand host. So this row is an active producer target, not a
    // leftover — do not prune it merely for being an `/api/zero/` path, or
    // live VM0-brand connects lose the callback they were sent to.
    //
    // A traffic sweep cannot retire this row: a quiet window means nobody
    // connected Teams under the VM0 brand that week, and the next person who
    // does is sent here regardless. #28917 listed this row for removal on that
    // silence and it was held back for exactly this reason.
    "/api/zero/teams/oauth/callback",
  ],
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
