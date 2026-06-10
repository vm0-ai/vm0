import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi } from "./helpers/api-bdd";

// API-first BDD coverage for the health endpoints. Both are exercised purely
// through real HTTP requests — the public check has no dependencies, and the
// authenticated check's success paths are covered by the auth-probe suite. See
// `api.bdd.md` (CHAIN-HEALTH).
const context = testContext();

describe("health (API-first BDD)", () => {
  it("serves a lightweight public health check", async () => {
    const api = createBddApi(context);

    const response = await accept(api.health.check(), [200]);
    expect(response.body).toStrictEqual({ status: "ok" });
  });

  it("requires authentication for the authenticated health check", async () => {
    const api = createBddApi(context);

    const response = await accept(api.healthAuth.check(), [401]);
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});
