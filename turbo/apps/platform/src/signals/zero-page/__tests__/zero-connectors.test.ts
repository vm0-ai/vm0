import { describe, it, expect } from "vitest";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { allConnectorTypes$ } from "../settings/connectors.ts";

const context = testContext();

describe("connectors", () => {
  it("should show gmail connector when feature switch is enabled for user with email", async () => {
    await setupPage({
      context,
      path: "/",
      user: {
        id: "test-user-123",
        fullName: "Test User",
        email: "testing@vm0.ai",
      },
      featureSwitches: { gmailConnector: true },
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

  it("should not show gmail connector when feature switch is disabled", async () => {
    await setupPage({
      context,
      path: "/",
      user: {
        id: "test-user-123",
        fullName: "Test User",
        email: "testing@vm0.ai",
      },
      featureSwitches: { gmailConnector: false },
      withoutRender: true,
    });

    const connectorTypes = await context.store.get(allConnectorTypes$);
    const gmailConnector = connectorTypes.find((c) => c.type === "gmail");

    expect(gmailConnector).toBeUndefined();
  });
});
