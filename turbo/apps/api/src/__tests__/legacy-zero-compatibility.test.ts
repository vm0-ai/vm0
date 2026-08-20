import { brandedApiNamespace } from "@okouai/api-contracts/contracts/api-namespaces";

import { ROUTES } from "../signals/route";
import {
  assertUniqueRouteRegistrations,
  type RouteEntry,
  withApiNamespaceAliases,
  withFinalProviderConsolePaths,
} from "../signals/route-entry";

const CANONICAL_PREFIX = "/api/okou";
const LEGACY_PREFIX = "/api/zero";

// The legacy `/api/zero/**` paths #28356 owes callers, keyed by the canonical
// `/api/okou/**` path. Restated here so registration is asserted against the
// issue's table rather than against the map the production code reads: the
// first group is the measured traffic, the second is seeded because a provider
// console holds the URL.
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

// The branded paths behind `FINAL_PROVIDER_CONSOLE_PATHS`. A provider console,
// not a client we control, decides when these stop being called, so none of
// them may depend on the fallback.
const PROVIDER_CONSOLE_BRANDED_PATHS: readonly string[] = [
  "/api/okou/slack/oauth/callback",
  "/api/okou/teams/oauth/callback",
  "/api/okou/feishu/oauth/callback",
  "/api/okou/slack/events",
  "/api/okou/slack/commands",
  "/api/okou/slack/interactive",
  "/api/okou/teams/bot",
  "/api/okou/feishu/events/:installationId",
];

const FINAL_PROVIDER_CONSOLE_PATHS: readonly string[] = [
  "/api/integrations/slack/oauth/callback",
  "/api/integrations/teams/oauth/callback",
  "/api/integrations/feishu/oauth/callback",
  "/api/webhooks/slack/events",
  "/api/webhooks/slack/commands",
  "/api/webhooks/slack/interactive",
  "/api/webhooks/teams/bot",
  "/api/webhooks/feishu/events/:installationId",
];

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

describe("legacy zero compatibility paths", () => {
  const registeredRoutes = withApiNamespaceAliases(
    withFinalProviderConsolePaths(ROUTES),
  );

  function registrationsFor(path: string): readonly RouteEntry[] {
    return registeredRoutes.filter((entry) => {
      return entry.route.path === path;
    });
  }

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
        // A listed path is compatibility we owe on purpose, so it must not be
        // reported as a gap the table missed.
        expect(match.viaNamespaceAliasFallback).toBeUndefined();
      }
    }
  });

  it("keeps every listed path backed by a declared contract", () => {
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

  it("keeps every registration unique across the table and the fallback", () => {
    expect(() => {
      assertUniqueRouteRegistrations(registeredRoutes);
    }).not.toThrow();
  });

  it("lists every branded path a provider console still holds", () => {
    for (const path of PROVIDER_CONSOLE_BRANDED_PATHS) {
      expect(LEGACY_ZERO_PATHS[path]).toBe(legacyPath(path));
    }
  });

  it("leaves the final provider console paths outside the fallback", () => {
    for (const path of FINAL_PROVIDER_CONSOLE_PATHS) {
      const matches = registrationsFor(path);
      expect(matches, `Missing registration for ${path}`).toHaveLength(1);
      expect(matches[0]?.viaNamespaceAliasFallback).toBeUndefined();
    }
  });
});
