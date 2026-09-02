import { brandedApiNamespace } from "@okouai/api-contracts/contracts/api-namespaces";

import { ROUTES } from "../signals/route";
import {
  assertUniqueRouteRegistrations,
  type RouteEntry,
  withMigratedBrandedPaths,
} from "../signals/route-entry";

const CANONICAL_PREFIX = "/api/okou";
const LEGACY_PREFIX = "/api/zero";

// The legacy `/api/zero/**` paths this service still owes a caller, keyed by
// the canonical `/api/okou/**` path the same handler answers. #30667 deleted
// `LEGACY_ZERO_PATHS`, so none of them is derived any more: each is named
// directly by a `MIGRATED_BRANDED_PATHS` row. Restated here rather than
// imported from `route-entry.ts`, so narrowing that table fails this file
// instead of quietly agreeing with itself.
//
// #30668 took the list from six paths to two, because for four of them the
// producer that held the branded URL moved rather than a caller draining: the
// Slack app console now posts the three webhooks to `/api/webhooks/slack/*`,
// with `Slackbot 1.0` observed delivering to each, and `routes/slack-oauth.ts`
// emits the neutral `redirect_uri` since #30551.
//
// #30812 then took the Teams callback, leaving one. #30667 had unified
// `callbackRedirectUri` onto the canonical path, and a `redirect_uri` is
// computed per request rather than handed to a person, so that deploy bounded
// the branded form to authorizations already in flight — minutes, long past by
// the time the row went.
//
// The one that remains has no producer left to move and no deploy that can
// drain it either: the Slack install link was handed to people rather than
// computed per request, and its `zero` form was still answering browser and
// crawler requests ten hours after the deploy that was supposed to have drained
// it.
const SERVED_LEGACY_PATHS: Readonly<Record<string, string>> = {
  "/api/okou/slack/oauth/install": "/api/zero/slack/oauth/install",
};

// A row #28701 removed from `LEGACY_ZERO_PATHS` whose path did not retire with
// it: `MIGRATED_BRANDED_PATHS` names both branded forms of the neutral
// `/api/org` contract, so the removed row recorded that the path was owed
// rather than being what served it. Pinned here because it is why removing
// twenty-five rows changed nothing a caller can observe, and why #30667 could
// remove the remaining six the same way.
const MIGRATED_BRANDED_SUBJECT = {
  neutral: "/api/org",
  canonical: "/api/okou/org",
  legacy: "/api/zero/org",
} as const;

function routeKey(entry: RouteEntry): string {
  return `${entry.route.method} ${entry.route.path}`;
}

function canonicalPath(path: string): string {
  if (brandedApiNamespace(path) !== "zero") {
    return path;
  }
  return `${CANONICAL_PREFIX}${path.slice(LEGACY_PREFIX.length)}`;
}

// Both branded forms of every compatibility path, taken from the literal list
// above rather than from the production table.
function compatibilityPaths(): readonly string[] {
  return Object.entries(SERVED_LEGACY_PATHS).flat();
}

// Composed the way production registers routes, so a slice that moves a listed
// contract to its neutral path can satisfy this list by naming the two branded
// paths in the migrated-branded table. Keeping the path listed here is the
// point; which mechanism serves it is not.
function missingCompatibilityPaths(
  routes: readonly RouteEntry[],
): readonly string[] {
  const registeredPaths = new Set(
    withMigratedBrandedPaths(routes).map((entry) => {
      return entry.route.path;
    }),
  );
  return compatibilityPaths()
    .filter((path) => {
      return !registeredPaths.has(path);
    })
    .sort();
}

// Per-endpoint behaviour is covered through the endpoints themselves. This
// file asserts the properties no single endpoint can express: over the whole
// route table, which paths are registered and which legacy paths are still
// served on purpose.
describe("API namespace compatibility", () => {
  // Composed the way production registers routes: the declared paths plus the
  // branded rows. This is what a caller actually reaches, and it is the only
  // composition that finds a #28278-migrated contract at the branded paths its
  // released callers hold.
  const servedRoutes = withMigratedBrandedPaths(ROUTES);

  function registrationsFor(path: string): readonly RouteEntry[] {
    return servedRoutes.filter((entry) => {
      return entry.route.path === path;
    });
  }

  // The issue that narrowed the table proposed `/api/zero/org` as the retired
  // subject, from a request-log window where its traffic had stopped. It is not
  // retired, and this pins why: the row removed from the compatibility table is
  // not what served the path.
  it("keeps a removed row's path served by the migrated branded table", () => {
    for (const path of Object.values(MIGRATED_BRANDED_SUBJECT)) {
      expect(
        registrationsFor(path).length,
        `Expected ${path} to stay served`,
      ).toBeGreaterThan(0);
    }
  });

  it("rejects duplicate method and path registrations", () => {
    const source = ROUTES[0];
    if (!source) {
      throw new Error("Expected a route to duplicate");
    }

    expect(() => {
      assertUniqueRouteRegistrations([source, source]);
    }).toThrow(`Duplicate API route registration: ${routeKey(source)}`);
  });

  it("serves every listed legacy path with the handler that serves its canonical path", () => {
    for (const [canonical, legacy] of Object.entries(SERVED_LEGACY_PATHS)) {
      const sources = registrationsFor(canonical);
      expect(
        sources.length,
        `Expected at least one route serving ${canonical}`,
      ).toBeGreaterThan(0);

      for (const source of sources) {
        const key = `${source.route.method} ${legacy}`;
        const matches = servedRoutes.filter((entry) => {
          return routeKey(entry) === key;
        });
        expect(matches, `Missing registration for ${key}`).toHaveLength(1);
        const match = matches[0];
        if (!match) {
          throw new Error(`Missing registration for ${key}`);
        }
        expect(match.handler).toBe(source.handler);
        expect(match.route).toStrictEqual({ ...source.route, path: legacy });
      }
    }
  });

  it("registers both branded forms of every listed compatibility path", () => {
    expect(missingCompatibilityPaths(ROUTES)).toStrictEqual([]);
  });

  // The regression #28278 hit ~354 times: a contract moves off `/api/okou/**`
  // to a neutral path, both branded registrations disappear, and every
  // mechanism assertion in this file still passes. This pins that the literal
  // list is what fails, so such a migration cannot go green and then 404 in
  // production. Removing the path from the list is the way out, and it has to
  // be deliberate.
  //
  // #28600 moved the last branded contract, so the subject is now a route that
  // has already migrated, moved a second time to a path no
  // `MIGRATED_BRANDED_PATHS` row names. That is the same failure: a slice edits
  // the contract and forgets the rows the branded paths depend on. #30668 took
  // the Slack events row this used to drive and repointed it at the Slack
  // install link, whose branded forms that PR measured still in use.
  it("reports the branded registrations a neutral contract migration would drop", () => {
    const canonical = "/api/okou/slack/oauth/install";
    const legacy = "/api/zero/slack/oauth/install";
    const declared = "/api/slack/oauth/install";
    const neutral = "/api/slack/install";
    expect(
      SERVED_LEGACY_PATHS[canonical],
      `${canonical} must stay in the served-legacy list for this guard to mean anything`,
    ).toBe(legacy);
    expect(
      ROUTES.filter((entry) => {
        return entry.route.path === declared;
      }),
      `Expected a contract declaring ${declared} for this guard to move something`,
    ).not.toHaveLength(0);

    const migratedRoutes = ROUTES.map((entry): RouteEntry => {
      if (entry.route.path !== declared) {
        return entry;
      }
      return {
        route: { ...entry.route, path: neutral },
        handler: entry.handler,
      };
    });
    const migratedRegistrations = withMigratedBrandedPaths(migratedRoutes);

    // The mechanism stays internally consistent, which is exactly why it cannot
    // be the thing that catches this.
    expect(
      migratedRegistrations.map((entry) => {
        return entry.route.path;
      }),
    ).toContain(neutral);
    expect(() => {
      assertUniqueRouteRegistrations(migratedRegistrations);
    }).not.toThrow();

    // The literal list is what notices.
    expect(missingCompatibilityPaths(migratedRoutes)).toStrictEqual(
      [canonical, legacy].sort(),
    );
  });

  // A row whose canonical path nothing answers is a row no caller can use. Read
  // from the served composition rather than from `ROUTES`: once a #28278 slice
  // moves a contract to its neutral path, the canonical branded path is served
  // by the migrated-branded table instead of being declared by the contract.
  it("keeps every listed legacy path backed by a served canonical path", () => {
    const servedCanonicalPaths = new Set(
      servedRoutes.map(({ route }) => {
        return canonicalPath(route.path);
      }),
    );

    expect(
      Object.keys(SERVED_LEGACY_PATHS).filter((path) => {
        return !servedCanonicalPaths.has(path);
      }),
    ).toStrictEqual([]);
  });
});
