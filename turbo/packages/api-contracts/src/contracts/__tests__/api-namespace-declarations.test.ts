import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { brandedApiNamespace } from "../api-namespaces";
import * as apiContracts from "../index";

interface DeclaredRoute {
  readonly declaration: string;
  readonly method: string;
  readonly path: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toDeclaredRoute(
  declaration: string,
  value: unknown,
): DeclaredRoute | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { method, path } = value;
  if (typeof method !== "string" || typeof path !== "string") {
    return undefined;
  }
  return { declaration, method, path };
}

/**
 * Enumerates every route declared by a contract exported from the package
 * barrel. Walking the barrel rather than the source files means a route added
 * to an already-exported contract is covered without touching this test.
 */
function declaredRoutes(): readonly DeclaredRoute[] {
  const routes: DeclaredRoute[] = [];
  for (const [exportName, exported] of Object.entries(apiContracts)) {
    if (!isRecord(exported)) {
      continue;
    }
    for (const [routeName, route] of Object.entries(exported)) {
      const declared = toDeclaredRoute(`${exportName}.${routeName}`, route);
      if (declared) {
        routes.push(declared);
      }
    }
  }
  return routes;
}

/**
 * A lower bound on how many routes the barrel walk must find.
 *
 * It counts every declared route rather than only the branded ones. #28278 is
 * driving the branded count to zero deliberately, one slice at a time — the
 * billing slice #28457 alone dropped 34 routes — so a floor measured against
 * the set being removed is guaranteed to fail, first at the threshold and then
 * once more per merged slice. Lowering it again only buys another slice.
 *
 * Migrating a path rewrites its namespace without dropping the declaration, so
 * the total does not fall as that work lands, and it still proves the barrel
 * walk reaches a broad set of declarations rather than a handful of samples.
 */
const MINIMUM_DECLARED_ROUTES = 100;

/**
 * The known declaration proving the walk reached real routes rather than an
 * accidentally empty barrel.
 *
 * It used to be `POST /api/okou/slack/events`, anchored on the provider console
 * paths that stayed branded the longest. #28600 moved the last four of those,
 * so this is the same route at the path it declares now. Keep the sentinel
 * pointed at a path the package still declares — without it, the guards below
 * pass vacuously the moment the walk returns nothing.
 */
const SENTINEL_DECLARED_ROUTE = {
  method: "POST",
  path: "/api/webhooks/slack/events",
} as const;

function declaresSentinelRoute(routes: readonly DeclaredRoute[]): boolean {
  return routes.some(({ method, path }) => {
    return (
      method === SENTINEL_DECLARED_ROUTE.method &&
      path === SENTINEL_DECLARED_ROUTE.path
    );
  });
}

function legacyNamespaceDeclarations(
  routes: readonly DeclaredRoute[],
): readonly string[] {
  return routes
    .filter(({ path }) => {
      return brandedApiNamespace(path) === "zero";
    })
    .map(({ declaration, method, path }) => {
      return `${declaration} declares ${method} ${path}`;
    });
}

const CONTRACTS_DIR = fileURLToPath(new URL("..", import.meta.url));

/**
 * Pairs with the barrel walk above, which reaches what `index.ts` re-exports by
 * name rather than every file: around seventy contracts are imported by module
 * path instead, and one of those could declare a branded path that no assertion
 * here would ever load. Scanning the source closes that without importing
 * seventy modules, and both assertions fail together, because a new branded
 * declaration has to be written into some file.
 */
function contractSourcesDeclaringBrandedPath(): readonly string[] {
  return readdirSync(CONTRACTS_DIR)
    .filter((entry) => {
      return entry.endsWith(".ts");
    })
    .filter((entry) => {
      // Matches the namespace root as well as a path below it, because
      // `brandedApiNamespace` treats a bare `/api/okou` as branded too.
      return /path:\s*"\/api\/okou(?:\/|")/.test(
        readFileSync(`${CONTRACTS_DIR}${entry}`, "utf8"),
      );
    })
    .sort();
}

function brandedNamespaceDeclarations(
  routes: readonly DeclaredRoute[],
): readonly string[] {
  return routes
    .filter(({ path }) => {
      return brandedApiNamespace(path) === "okou";
    })
    .map(({ declaration, method, path }) => {
      return `${declaration} declares ${method} ${path}`;
    });
}

describe("branded API namespace declarations", () => {
  const routes = declaredRoutes();

  it("enumerates contract routes through the package barrel", () => {
    expect(routes.length).toBeGreaterThan(MINIMUM_DECLARED_ROUTES);
    expect(declaresSentinelRoute(routes)).toBe(true);
  });

  it("declares every branded contract path in the Okou namespace", () => {
    expect(
      legacyNamespaceDeclarations(routes),
      "A declared contract path is the URL its ts-rest clients request, so a /api/zero/ declaration makes current clients produce legacy-namespace traffic. Declare branded paths as /api/okou/...; the /api/zero/ alias exists only for already-released clients.",
    ).toStrictEqual([]);
  });

  // Kept after #28278 drained the branded set in #28600: the floor is measured
  // over every declaration, and this shows the neutral ones alone already clear
  // it, so the total can never be propped up by a branded straggler.
  it("clears the floor on neutral routes alone", () => {
    const neutralRoutes = routes.filter(({ path }) => {
      return brandedApiNamespace(path) === undefined;
    });

    expect(neutralRoutes.length).toBeGreaterThan(MINIMUM_DECLARED_ROUTES);
  });

  it("declares no branded path at all", () => {
    expect(
      brandedNamespaceDeclarations(routes),
      "A contract declares a neutral path — /api/<domain>/... — never a branded one. #28600 moved the last four, which were branded only because the Slack app configuration held those URLs; #31090 removed the compatibility mechanism in apps/api that used to keep such a URL reachable, so a provider console is repointed at the neutral path rather than served a branded one. See #28278 for the classification and the migration a branded route needs.",
    ).toStrictEqual([]);
  });

  // The assertion above only sees what the barrel walk loads, so this one
  // covers the files it does not: a branded path written into a contract
  // `index.ts` never re-exports fails here instead of shipping unnoticed.
  it("declares a branded path in no contract module", () => {
    expect(
      contractSourcesDeclaringBrandedPath(),
      "No contract module may declare a branded path. A new contract declares a neutral path — /api/<domain>/... — and #28278 records the classification; nothing has served a branded path since #31090 removed the compatibility mechanism, so a URL a third-party console holds is repointed at the neutral path rather than declared here.",
    ).toStrictEqual([]);
  });

  it("reports a contract that declares a legacy namespace path", () => {
    expect(
      legacyNamespaceDeclarations([
        {
          declaration: "legacyContract.get",
          method: "GET",
          path: "/api/zero/health",
        },
      ]),
    ).toStrictEqual(["legacyContract.get declares GET /api/zero/health"]);
  });

  // The regression the guard exists to catch, driven by a fixture rather than
  // waiting for the next late contract: every branded declaration is reported
  // now that nothing is exempt, including one on a path a provider console
  // holds, and a neutral declaration beside it is not.
  it("reports a contract that declares a branded path", () => {
    expect(
      brandedNamespaceDeclarations([
        {
          declaration: "lateContract.create",
          method: "POST",
          path: "/api/okou/late-feature",
        },
        {
          declaration: "slackEventsContract.handle",
          method: "POST",
          path: "/api/okou/slack/events",
        },
        {
          declaration: "lateContract.list",
          method: "GET",
          path: "/api/late-feature",
        },
      ]),
    ).toStrictEqual([
      "lateContract.create declares POST /api/okou/late-feature",
      "slackEventsContract.handle declares POST /api/okou/slack/events",
    ]);
  });
});
