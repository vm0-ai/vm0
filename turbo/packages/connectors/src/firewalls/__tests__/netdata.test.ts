import { describe, expect, it } from "vitest";

import { extractSecretNamesFromApis } from "../../firewall-types";
import {
  getConnectorFirewall,
  getDefaultFirewallPolicies,
  isFirewallConnectorType,
} from "../index";

describe("netdata firewall", () => {
  it("registers the Netdata Cloud firewall with Bearer token auth", () => {
    expect(isFirewallConnectorType("netdata")).toBe(true);
    const firewall = getConnectorFirewall("netdata");

    expect(firewall.name).toBe("netdata");
    expect(firewall.apis).toHaveLength(1);
    expect(firewall.apis[0]).toMatchObject({
      base: "https://app.netdata.cloud",
      auth: {
        headers: {
          Authorization: "Bearer ${{ secrets.NETDATA_TOKEN }}",
        },
      },
      permissions: [],
    });
    expect(extractSecretNamesFromApis([...firewall.apis])).toStrictEqual([
      "NETDATA_TOKEN",
    ]);
    expect(firewall.placeholders).toHaveProperty("NETDATA_TOKEN");
    expect(getDefaultFirewallPolicies("netdata")).toStrictEqual({
      policies: {},
      unknownPolicy: "allow",
    });
  });
});
