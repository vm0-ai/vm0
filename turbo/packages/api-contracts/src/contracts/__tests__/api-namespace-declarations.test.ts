import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { brandedApiNamespace } from "../api-namespaces";
import * as feishuEvents from "../feishu-events";
import * as feishuOauth from "../feishu-oauth";
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
 * The modules this file walks: the package barrel, plus the contract modules
 * that declare a branded path without being re-exported from it.
 *
 * The barrel is the default, because walking it rather than the source files
 * means a route added to an already-exported contract is covered without
 * touching this test. It is not complete, though — `index.ts` re-exports by
 * name, and around seventy contracts are imported by module path instead — so
 * the two Feishu console contracts are named here to make the allowlist below
 * assertable in both directions. `contractSourcesDeclaringBrandedPath` keeps
 * that gap from growing silently.
 */
const WALKED_CONTRACT_MODULES: Readonly<Record<string, unknown>> = {
  index: apiContracts,
  "feishu-events": feishuEvents,
  "feishu-oauth": feishuOauth,
};

/**
 * Enumerates every route declared by a contract the walk above reaches.
 */
function declaredRoutes(): readonly DeclaredRoute[] {
  const routes: DeclaredRoute[] = [];
  for (const [moduleName, module] of Object.entries(WALKED_CONTRACT_MODULES)) {
    if (!isRecord(module)) {
      continue;
    }
    for (const [exportName, exported] of Object.entries(module)) {
      if (!isRecord(exported)) {
        continue;
      }
      for (const [routeName, route] of Object.entries(exported)) {
        const declared = toDeclaredRoute(
          `${moduleName}:${exportName}.${routeName}`,
          route,
        );
        if (declared) {
          routes.push(declared);
        }
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
 * `POST /api/okou/slack/events` is one of the six provider console paths listed
 * in `ALLOWED_BRANDED_DECLARATIONS` below. A third-party provider console holds
 * each of those URLs, which is why #28278 excludes them and why they stay
 * branded under #26701: they keep their branded form after every migrating path
 * has left, making them the most stable branded declarations in the package.
 * Any of the six works here.
 *
 * If those six ever move as well, re-anchor this on a path the package still
 * declares — do not delete the sentinel. Without it, the legacy-namespace
 * guard below passes vacuously the moment the walk returns nothing.
 */
const RETAINED_BRANDED_ROUTE = {
  method: "POST",
  path: "/api/okou/slack/events",
} as const;

function declaresRetainedBrandedRoute(
  routes: readonly DeclaredRoute[],
): boolean {
  return routes.some(({ method, path }) => {
    return (
      method === RETAINED_BRANDED_ROUTE.method &&
      path === RETAINED_BRANDED_ROUTE.path
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

/**
 * The only `/api/okou/**` paths a contract may declare: the six URLs a
 * third-party provider console holds, which #28278 therefore leaves branded
 * until each console is confirmed. Every other branded path has moved to a
 * neutral one, and this list is what keeps the namespace from refilling — six
 * new branded routes appeared in the two days before #28565 simply because
 * nothing rejected them.
 *
 * Restated literally rather than imported from `FINAL_PROVIDER_CONSOLE_PATHS`
 * in `apps/api`: an expectation read out of the code it guards asserts nothing,
 * and a migration that drops a console path there has to be a deliberate edit
 * here too. The packages are separate anyway.
 */
const ALLOWED_BRANDED_DECLARATIONS: readonly string[] = [
  "GET /api/okou/slack/oauth/callback",
  "GET /api/okou/feishu/oauth/callback",
  "POST /api/okou/slack/events",
  "POST /api/okou/slack/commands",
  "POST /api/okou/slack/interactive",
  "POST /api/okou/feishu/events/:installationId",
];

/**
 * The contract modules that declare one of the six allowlisted console paths,
 * and so the only files in the package whose source may contain a branded path
 * at all.
 *
 * Pairs with the walk above, which reaches the barrel's exports rather than
 * every file: a contract the barrel does not re-export could declare a branded
 * path that no assertion here would ever load. Scanning the source closes that
 * without importing seventy modules, and the two lists fail together, because a
 * new branded declaration has to be written into some file.
 */
const BRANDED_CONTRACT_SOURCES: readonly string[] = [
  "feishu-events.ts",
  "feishu-oauth.ts",
  "slack-commands.ts",
  "slack-events.ts",
  "slack-interactive.ts",
  "slack-oauth.ts",
];

const CONTRACTS_DIR = fileURLToPath(new URL("..", import.meta.url));

function contractSourcesDeclaringBrandedPath(): readonly string[] {
  return readdirSync(CONTRACTS_DIR)
    .filter((entry) => {
      return entry.endsWith(".ts");
    })
    .filter((entry) => {
      return /path:\s*"\/api\/okou\//.test(
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
    .map(({ method, path }) => {
      return `${method} ${path}`;
    });
}

function unallowedBrandedDeclarations(
  routes: readonly DeclaredRoute[],
): readonly string[] {
  return routes
    .filter(({ method, path }) => {
      return (
        brandedApiNamespace(path) === "okou" &&
        !ALLOWED_BRANDED_DECLARATIONS.includes(`${method} ${path}`)
      );
    })
    .map(({ declaration, method, path }) => {
      return `${declaration} declares ${method} ${path}`;
    });
}

describe("branded API namespace declarations", () => {
  const routes = declaredRoutes();

  it("enumerates contract routes through the package barrel", () => {
    expect(routes.length).toBeGreaterThan(MINIMUM_DECLARED_ROUTES);
    expect(declaresRetainedBrandedRoute(routes)).toBe(true);
  });

  it("declares every branded contract path in the Okou namespace", () => {
    expect(
      legacyNamespaceDeclarations(routes),
      "A declared contract path is the URL its ts-rest clients request, so a /api/zero/ declaration makes current clients produce legacy-namespace traffic. Declare branded paths as /api/okou/...; the /api/zero/ alias exists only for already-released clients.",
    ).toStrictEqual([]);
  });

  // Shows the floor above survives #28278 finishing, without waiting for it.
  // A migrating route does not disappear, it becomes neutral, so the routes
  // already neutral today are a lower bound on the total once the branded
  // count reaches the six retained paths. Clearing the floor on that subset
  // alone means draining the branded set cannot reach it.
  it("clears the floor on neutral routes alone", () => {
    const neutralRoutes = routes.filter(({ path }) => {
      return brandedApiNamespace(path) === undefined;
    });

    expect(neutralRoutes.length).toBeGreaterThan(MINIMUM_DECLARED_ROUTES);
  });

  it("declares no branded path outside the provider console allowlist", () => {
    expect(
      unallowedBrandedDeclarations(routes),
      "A new contract declares a neutral path — /api/<domain>/... — not a branded one. The allowlist beside this assertion exists only because a third-party provider console holds those URLs and cannot be repointed from this repository; every other branded path has already moved. See #28278 for the classification and the migration a branded route needs.",
    ).toStrictEqual([]);
  });

  // Pins the allowlist to the six console paths in both directions. Growing it
  // is the way a branded path gets past the assertion above, and a console path
  // that leaves the contracts without leaving this list would let a stale entry
  // keep permitting a path nothing declares any more.
  it("allowlists exactly the six provider console paths the package declares", () => {
    expect(ALLOWED_BRANDED_DECLARATIONS).toHaveLength(6);
    expect([...brandedNamespaceDeclarations(routes)].sort()).toStrictEqual(
      [...ALLOWED_BRANDED_DECLARATIONS].sort(),
    );
  });

  // The assertion above only sees what the walk loads, so this one covers the
  // files it does not: a branded path written into a contract the barrel never
  // re-exports fails here instead of shipping unnoticed.
  it("declares a branded path in no contract module outside the console six", () => {
    expect(
      contractSourcesDeclaringBrandedPath(),
      "Only the provider console contracts may declare a branded path. A new contract declares a neutral path — /api/<domain>/... — and #28278 records the classification. If a console contract really did move, drop it from this list and from the allowlist above together.",
    ).toStrictEqual([...BRANDED_CONTRACT_SOURCES].sort());
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
  // waiting for the next late contract: a branded declaration is reported, an
  // allowlisted console path is not, and a same-path-different-method neighbour
  // of an allowlisted entry is, because the console holds one URL and one verb.
  it("reports a contract that declares a non-allowlisted branded path", () => {
    expect(
      unallowedBrandedDeclarations([
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
          declaration: "slackEventsContract.read",
          method: "GET",
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
      "slackEventsContract.read declares GET /api/okou/slack/events",
    ]);
  });
});
