import {
  healthAuthContract,
  healthContract,
} from "@vm0/api-contracts/contracts";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";

const context = testContext();

describe("api health routes", () => {
  it("serves a lightweight health check", async () => {
    const client = setupApp({ context, contract: healthContract });
    const response = await accept(client.check(), [200]);

    expect(response.body).toEqual({ status: "ok" });
  });

  it("requires auth for the authenticated health check", async () => {
    const client = setupApp({ context, contract: healthAuthContract });
    const response = await accept(client.check(), [401]);

    expect(response.body).toEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});
