import { describe, expect, it } from "vitest";

import { extractSecretNamesFromApis } from "../../firewall-types";
import {
  getConnectorFirewall,
  isFirewallConnectorType,
} from "../../firewalls/index";

describe("ashby firewall", () => {
  it("registers the Ashby firewall with Basic auth over the raw API key", () => {
    expect(isFirewallConnectorType("ashby")).toBe(true);
    const firewall = getConnectorFirewall("ashby");

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

  it("does not declare provider-specific permissions yet", () => {
    const firewall = getConnectorFirewall("ashby");
    expect(firewall.apis[0]?.permissions).toStrictEqual([]);
  });
});
