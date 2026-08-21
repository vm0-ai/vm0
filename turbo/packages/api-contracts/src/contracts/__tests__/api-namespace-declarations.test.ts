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
 * `POST /api/okou/slack/events` is one of the six
 * `FINAL_PROVIDER_CONSOLE_PATHS` in `apps/api`. A third-party provider console
 * holds each of those URLs, which is why #28278 excludes them and why they stay
 * branded under #26701: they keep their branded form after every migrating path
 * has left, making them the most stable branded declarations in the package.
 * Any of the six works here.
 *
 * The set is not permanent — #28544 dropped it from eight by moving the two
 * Feishu paths that no console actually held. If the remaining six ever move as
 * well, re-anchor this on a path the package still declares — do not delete the
 * sentinel. Without it, the legacy-namespace guard below passes vacuously the
 * moment the walk returns nothing.
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
});
