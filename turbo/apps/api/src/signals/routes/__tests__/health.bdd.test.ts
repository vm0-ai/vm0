import {
  healthAuthContract,
  healthContract,
} from "@vm0/api-contracts/contracts";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";

const context = testContext();

describe("api health route BDD", () => {
  const createClient = setupApp({ context });

  it("serves public health and rejects unauthenticated auth health", async () => {
    const healthClient = createClient(healthContract);
    const authHealthClient = createClient(healthAuthContract);

    const healthResponse = await accept(healthClient.check(), [200]);

    expect(healthResponse.body).toStrictEqual({ status: "ok" });

    const authHealthResponse = await accept(authHealthClient.check(), [401]);

    expect(authHealthResponse.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});
