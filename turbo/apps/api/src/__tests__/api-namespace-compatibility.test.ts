import {
  apiNamespaceAliasPaths,
  brandedApiNamespace,
} from "@okouai/api-contracts/contracts/api-namespaces";

import { ROUTES } from "../signals/route";
import {
  assertUniqueRouteRegistrations,
  type RouteEntry,
  withApiNamespaceAliases,
} from "../signals/route-entry";

const CANONICAL_PREFIX = "/api/okou";
const LEGACY_PREFIX = "/api/zero";

// The legacy `/api/zero/**` paths #28356 owes callers, keyed by the canonical
// `/api/okou/**` path. Restated here so registration is asserted against the
// issue's measured table rather than against the map the production code
// reads: the first group is the traffic measured in `vm0-request-log-prod`,
// the second is seeded because a provider console holds the URL.
//
// This literal list is the only non-tautological expectation in this file. The
// mechanism tests below derive their expectation from `apiNamespaceAliasPaths`,
// the same function that produces the registration, so they cannot notice a
// path disappearing: when #28278 migrates a contract from `/api/okou/x` to a
// neutral path, `apiNamespaceAliasPaths` returns the neutral path unchanged,
// every mechanism assertion still holds, and both branded registrations vanish
// silently. Only a literal list catches that, and editing this list is meant to
// be the friction that forces the migration to be a conscious decision.
const LEGACY_ZERO_PATHS: Readonly<Record<string, string>> = {
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
  "/api/okou/github/oauth/connect/callback":
    "/api/zero/github/oauth/connect/callback",
  "/api/okou/computer-use/hosts/start": "/api/zero/computer-use/hosts/start",
  "/api/okou/logs/:id": "/api/zero/logs/:id",
  "/api/okou/mail/drafts/:mailDraftId": "/api/zero/mail/drafts/:mailDraftId",

  "/api/okou/teams/oauth/callback": "/api/zero/teams/oauth/callback",
  "/api/okou/slack/oauth/callback": "/api/zero/slack/oauth/callback",
  "/api/okou/feishu/oauth/callback": "/api/zero/feishu/oauth/callback",
  "/api/okou/slack/commands": "/api/zero/slack/commands",
  "/api/okou/slack/interactive": "/api/zero/slack/interactive",
};

function routeKey(entry: RouteEntry): string {
  return `${entry.route.method} ${entry.route.path}`;
}

function canonicalPath(path: string): string {
  if (brandedApiNamespace(path) !== "zero") {
    return path;
  }
  return `${CANONICAL_PREFIX}${path.slice(LEGACY_PREFIX.length)}`;
}

function legacyPath(path: string): string {
  if (brandedApiNamespace(path) !== "okou") {
    return path;
  }
  return `${LEGACY_PREFIX}${path.slice(CANONICAL_PREFIX.length)}`;
}

// Both branded forms of every compatibility path, taken from the literal list
// above rather than from `apiNamespaceAliasPaths` or the production table.
function compatibilityPaths(): readonly string[] {
  return Object.entries(LEGACY_ZERO_PATHS).flat();
}

function missingCompatibilityPaths(
  routes: readonly RouteEntry[],
): readonly string[] {
  const registeredPaths = new Set(
    withApiNamespaceAliases(routes).map((entry) => {
      return entry.route.path;
    }),
  );
  return compatibilityPaths()
    .filter((path) => {
      return !registeredPaths.has(path);
    })
    .sort();
}

function requireBrandedRoute(): RouteEntry {
  const entry = ROUTES.find(({ route }) => {
    return route.path.startsWith("/api/okou/");
  });
  if (!entry) {
    throw new Error("Expected at least one branded API route");
  }
  return entry;
}

// Per-endpoint behaviour is covered through the endpoints themselves. This
// file asserts the properties no single endpoint can express: over the whole
// route table, which paths are registered, which of them the compatibility
// table owes on purpose, and which exist only because the fallback derived
// them.
describe("API namespace compatibility", () => {
  const registeredRoutes = withApiNamespaceAliases(ROUTES);

  function registrationsFor(path: string): readonly RouteEntry[] {
    return registeredRoutes.filter((entry) => {
      return entry.route.path === path;
    });
  }

  it("registers symmetric Zero and Okou paths with the same handler and schema", () => {
    const registrationCounts = new Map<string, number>();
    for (const entry of registeredRoutes) {
      const key = routeKey(entry);
      registrationCounts.set(key, (registrationCounts.get(key) ?? 0) + 1);
    }

    for (const source of ROUTES) {
      const paths = apiNamespaceAliasPaths(source.route.path);
      for (const path of paths) {
        const matches = registeredRoutes.filter(({ route }) => {
          return route.method === source.route.method && route.path === path;
        });
        expect(matches).toHaveLength(1);
        const match = matches[0];
        if (!match) {
          throw new Error(
            `Missing API namespace alias for ${routeKey(source)}`,
          );
        }
        expect(match.handler).toBe(source.handler);
        expect(match.route).toStrictEqual({ ...source.route, path });
      }
    }

    expect(
      [...registrationCounts.values()].filter((count) => {
        return count !== 1;
      }),
    ).toStrictEqual([]);
    expect(() => {
      assertUniqueRouteRegistrations(registeredRoutes);
    }).not.toThrow();
  });

  it("keeps neutral health, webhook, and product-scoped Desktop routes single", () => {
    const neutralPaths = [
      "/health",
      "/api/webhooks/clerk",
      "/api/desktop/updates/:product/:channel/:platform/:arch/RELEASES.json",
    ] as const;

    for (const path of neutralPaths) {
      const matches = registeredRoutes.filter((entry) => {
        return entry.route.path === path;
      });
      expect(matches).toHaveLength(1);
      expect(apiNamespaceAliasPaths(path)).toStrictEqual([path]);
    }
  });

  it("remains symmetric when the source contract uses the legacy Zero path", () => {
    const source = requireBrandedRoute();
    const zeroSource: RouteEntry = {
      route: {
        ...source.route,
        path: source.route.path.replace("/api/okou/", "/api/zero/"),
      },
      handler: source.handler,
    };

    expect(
      withApiNamespaceAliases([zeroSource]).map(({ route }) => {
        return route.path;
      }),
    ).toStrictEqual([source.route.path, zeroSource.route.path]);
  });

  it("rejects duplicate method and path registrations", () => {
    const source = requireBrandedRoute();
    const composedRouteSlice = withApiNamespaceAliases([source, source]);

    expect(composedRouteSlice).toHaveLength(4);
    expect(() => {
      assertUniqueRouteRegistrations(composedRouteSlice);
    }).toThrow(`Duplicate API route registration: ${routeKey(source)}`);
  });

  it("serves every listed legacy path with the handler that serves its canonical path", () => {
    for (const [canonical, legacy] of Object.entries(LEGACY_ZERO_PATHS)) {
      const sources = registrationsFor(canonical);
      expect(
        sources.length,
        `Expected at least one route serving ${canonical}`,
      ).toBeGreaterThan(0);

      for (const source of sources) {
        const key = `${source.route.method} ${legacy}`;
        const matches = registeredRoutes.filter((entry) => {
          return routeKey(entry) === key;
        });
        expect(matches, `Missing registration for ${key}`).toHaveLength(1);
        const match = matches[0];
        if (!match) {
          throw new Error(`Missing registration for ${key}`);
        }
        expect(match.handler).toBe(source.handler);
        expect(match.route).toStrictEqual({ ...source.route, path: legacy });
        // A listed path is compatibility owed on purpose, so it must not be
        // reported as a gap the table missed.
        expect(match.viaNamespaceAliasFallback).toBeUndefined();
      }
    }
  });

  it("registers both branded forms of every listed compatibility path", () => {
    expect(missingCompatibilityPaths(ROUTES)).toStrictEqual([]);
  });

  // The regression #28278 will hit ~354 times: a contract moves off
  // `/api/okou/**` to a neutral path, both branded registrations disappear, and
  // every mechanism assertion in this file still passes. This pins that the
  // literal list is what fails, so such a migration cannot go green and then
  // 404 in production. Removing the path from the list is the way out, and it
  // has to be deliberate.
  it("reports the branded registrations a neutral contract migration would drop", () => {
    const canonical = "/api/okou/realtime/token";
    const legacy = "/api/zero/realtime/token";
    const neutral = "/api/realtime/token";
    expect(
      LEGACY_ZERO_PATHS[canonical],
      `${canonical} must stay in the compatibility list for this guard to mean anything`,
    ).toBe(legacy);

    const migratedRoutes = ROUTES.map((entry): RouteEntry => {
      if (entry.route.path !== canonical) {
        return entry;
      }
      return {
        route: { ...entry.route, path: neutral },
        handler: entry.handler,
      };
    });
    const migratedRegistrations = withApiNamespaceAliases(migratedRoutes);

    // The mechanism stays internally consistent, which is exactly why it cannot
    // be the thing that catches this.
    expect(
      migratedRegistrations.map((entry) => {
        return entry.route.path;
      }),
    ).toContain(neutral);
    expect(apiNamespaceAliasPaths(neutral)).toStrictEqual([neutral]);
    expect(() => {
      assertUniqueRouteRegistrations(migratedRegistrations);
    }).not.toThrow();

    // The literal list is what notices.
    expect(missingCompatibilityPaths(migratedRoutes)).toStrictEqual(
      [canonical, legacy].sort(),
    );
  });

  it("keeps every listed legacy path backed by a declared contract", () => {
    const declaredCanonicalPaths = new Set(
      ROUTES.map(({ route }) => {
        return canonicalPath(route.path);
      }),
    );

    expect(
      Object.keys(LEGACY_ZERO_PATHS).filter((path) => {
        return !declaredCanonicalPaths.has(path);
      }),
    ).toStrictEqual([]);
  });

  it("marks exactly the unlisted legacy registrations as fallback", () => {
    const expectedFallbackKeys = ROUTES.flatMap(({ route }) => {
      if (brandedApiNamespace(route.path) === undefined) {
        return [];
      }
      const legacy = legacyPath(route.path);
      if (
        route.path === legacy ||
        LEGACY_ZERO_PATHS[canonicalPath(route.path)] === legacy
      ) {
        return [];
      }
      return [`${route.method} ${legacy}`];
    }).sort();

    const markedKeys = registeredRoutes
      .filter((entry) => {
        return entry.viaNamespaceAliasFallback === true;
      })
      .map(routeKey)
      .sort();

    expect(markedKeys).toStrictEqual(expectedFallbackKeys);
    // The fallback still carries the bulk of the branded surface; #26701
    // removes it only once the fallback log has gone quiet for long enough.
    expect(markedKeys.length).toBeGreaterThan(0);
  });
});
