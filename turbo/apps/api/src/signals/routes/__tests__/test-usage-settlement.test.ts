import { testUsageSettlementContract } from "@vm0/api-contracts/contracts/test-usage-settlement";

import { createAppWithRoutes } from "../../../app-factory-core";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { testUsageSettlementRoutes } from "../test-usage-settlement";

const context = testContext();

describe("POST /api/test/usage-settlement/process", () => {
  it("returns 404 when the test endpoint is not allowed", async () => {
    mockEnv("ENV", "production");
    const app = createAppWithRoutes({
      signal: context.signal,
      routes: testUsageSettlementRoutes,
    });

    const response = await app.request(
      testUsageSettlementContract.process.path,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ org_id: "org_test" }),
      },
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });
});
