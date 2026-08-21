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

    // A floor, not an inventory. #28278 moves product routes off the brand
    // namespace one slice at a time, so this count only ever falls — it was
    // over 100 when this test was written and is 83 once #28462 lands. Any
    // specific number is a snapshot that a later slice turns red for reasons
    // that have nothing to do with the enumeration this test covers, so the
    // floor is what proves the barrel walk still finds branded routes at all.
    // The declaration asserted below is what gives the test its teeth.
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
