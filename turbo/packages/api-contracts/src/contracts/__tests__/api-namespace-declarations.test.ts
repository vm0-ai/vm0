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

describe("branded API namespace declarations", () => {
  const routes = declaredRoutes();

  it("enumerates branded contract routes through the package barrel", () => {
    const brandedRoutes = routes.filter(({ path }) => {
      return brandedApiNamespace(path) !== undefined;
    });

    // The guard here is that the barrel walk still finds routes at all: if
    // `toDeclaredRoute` stopped matching, or the barrel stopped re-exporting
    // the contracts, both counts would collapse and every assertion below
    // would pass vacuously. It is sized against the total rather than the
    // branded subset because #28278 is deliberately driving the branded count
    // to zero — it was 78 of 407 when this slice moved 22 routes, already
    // under the previous branded-only floor of 100. The total does not shrink
    // as routes migrate, so it keeps measuring what this assertion is for.
    expect(routes.length).toBeGreaterThan(100);
    // Still non-empty, so the branded filter itself stays exercised. This one
    // retires with the last branded contract path under #26701.
    expect(brandedRoutes.length).toBeGreaterThan(0);
    expect(
      brandedRoutes.some(({ method, path }) => {
        return (
          method === "POST" &&
          path === "/api/okou/billing/concurrency-checkout/preview"
        );
      }),
    ).toBe(true);
  });

  it("declares every branded contract path in the Okou namespace", () => {
    const legacyDeclarations = routes
      .filter(({ path }) => {
        return brandedApiNamespace(path) === "zero";
      })
      .map(({ declaration, method, path }) => {
        return `${declaration} declares ${method} ${path}`;
      });

    expect(
      legacyDeclarations,
      "A declared contract path is the URL its ts-rest clients request, so a /api/zero/ declaration makes current clients produce legacy-namespace traffic. Declare branded paths as /api/okou/...; the /api/zero/ alias exists only for already-released clients.",
    ).toStrictEqual([]);
  });
});
