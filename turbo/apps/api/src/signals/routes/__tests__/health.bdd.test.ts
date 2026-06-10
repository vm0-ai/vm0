import {
  healthAuthContract,
  healthContract,
} from "@vm0/api-contracts/contracts";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";

const context = testContext();

describe("BDD GET /api/health + GET /api/health/auth — 200/401 chain", () => {
  it("gwt-wt-wt: 200 health check → 401 authed health check without auth header", async () => {
    const createClient = setupApp({ context });

    // When + Then: 200 lightweight health check.
    const publicHealth = await accept(
      createClient(healthContract).check(),
      [200],
    );
    expect(publicHealth.body).toStrictEqual({ status: "ok" });

    // When + Then: 401 authed health check without auth header.
    const authHealth = await accept(
      createClient(healthAuthContract).check(),
      [401],
    );
    expect(authHealth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});
