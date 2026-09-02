import { brandedApiNamespace } from "@okouai/api-contracts/contracts/api-namespaces";

import { ROUTES } from "../signals/route";
import { assertUniqueRouteRegistrations } from "../signals/route-entry";

// Per-endpoint behaviour is covered through the endpoints themselves. This
// file asserts the two properties no single endpoint can express, over the
// whole route table: that it holds no branded path, and that no two of its
// registrations collide.
//
// Two stages used to sit between a contract and its registration. One
// registered the branded paths a #28278-migrated contract owed its released
// callers; #31088 emptied its table and #31090 removed it. The other derived
// the canonical `/api/okou/**` form of a branded declaration; #28984 moved the
// last contract off the brand namespace, which left it deriving nothing, and
// #31094 removed it. A route is now registered at the path its contract
// declares, so the declared table is the registered table.
describe("API namespace compatibility", () => {
  // Why `/api/okou/**` and `/api/zero/**` are 404 in production, and what
  // fails if a contract starts declaring a branded path again. Read off
  // `ROUTES`, because that is now exactly what `createAppWithRoutes`
  // registers.
  it("registers no branded path for any route in the production table", () => {
    expect(
      ROUTES.map(({ route }) => {
        return route.path;
      })
        .filter((path) => {
          return brandedApiNamespace(path) !== undefined;
        })
        .sort(),
    ).toStrictEqual([]);
  });

  // Hono keeps both registrations for a duplicated path and answers with the
  // first, so a collision takes a handler over instead of failing. Asserted
  // over the route table rather than inside `createAppWithRoutes`, because
  // test apps deliberately compose overlapping route slices and would fail an
  // app-wide assertion for reasons that have nothing to do with the table.
  it("keeps the production route table free of colliding registrations", () => {
    expect(() => {
      assertUniqueRouteRegistrations(ROUTES);
    }).not.toThrow();
  });
});
