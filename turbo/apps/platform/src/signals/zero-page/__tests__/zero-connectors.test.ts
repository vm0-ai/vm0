import { describe, it, expect } from "vitest";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { allConnectorTypes$ } from "../settings/connectors.ts";

const context = testContext();

describe("connectors", () => {
  it("should show gmail connector without any feature switch", async () => {
    await setupPage({
      context,
      path: "/",
      user: {
        id: "test-user-123",
        fullName: "Test User",
        email: "testing@vm0.ai",
      },
      featureSwitches: {},
      withoutRender: true,
    });

    const connectorTypes = await context.store.get(allConnectorTypes$);
    const gmailConnector = connectorTypes.find((c) => c.type === "gmail");

    expect(gmailConnector).toBeDefined();
    if (!gmailConnector) {
      return;
    }
    expect(gmailConnector.connected).toBeFalsy();
  });
});
