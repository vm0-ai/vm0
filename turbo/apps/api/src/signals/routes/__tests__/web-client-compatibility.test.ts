import { webClientCompatibilityContract } from "@vm0/api-contracts/contracts/web-client-compatibility";
import { describe, expect, it } from "vitest";

import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import { webClientCompatibility$ } from "../web-client-compatibility";

const context = testContext();

function webClientCompatibilityClient() {
  return setupAppWithRoutes({
    context,
    routes: [
      {
        route: webClientCompatibilityContract.get,
        handler: webClientCompatibility$,
      },
    ],
  })(webClientCompatibilityContract);
}

describe("web client compatibility", () => {
  it("checks public web client compatibility from repo config", async () => {
    const response = await accept(
      webClientCompatibilityClient().get({ query: { version: "0.0.0" } }),
      [200],
    );

    expect(response.body).toStrictEqual({
      minimumSupportedVersion: "0.0.0",
      supported: true,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
