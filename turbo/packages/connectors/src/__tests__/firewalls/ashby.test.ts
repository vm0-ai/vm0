import { describe, expect, it } from "vitest";

import { extractSecretNamesFromApis } from "../../firewall-types";
import { loadRequiredConnectorFirewall } from "../firewall-test-helpers";

describe("ashby firewall", () => {
  it("registers the Ashby firewall with Basic auth over the raw API key", async () => {
    const firewall = await loadRequiredConnectorFirewall("ashby");

    expect(firewall.name).toBe("ashby");
    expect(firewall.apis).toHaveLength(1);
    expect(firewall.apis[0]).toMatchObject({
      base: "https://api.ashbyhq.com",
      auth: {
        headers: {
          Authorization: "${{ basic(secrets.ASHBY_TOKEN, ) }}",
        },
      },
    });
    expect(extractSecretNamesFromApis([...firewall.apis])).toStrictEqual([
      "ASHBY_TOKEN",
    ]);
    expect(firewall.placeholders).toStrictEqual({
      ASHBY_TOKEN: "CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocal",
    });
  });

  it("does not declare provider-specific permissions yet", async () => {
    const firewall = await loadRequiredConnectorFirewall("ashby");
    expect(firewall.apis[0]?.permissions).toStrictEqual([]);
  });
});
