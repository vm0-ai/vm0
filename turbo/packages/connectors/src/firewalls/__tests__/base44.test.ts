import { describe, expect, it } from "vitest";

import { extractSecretNamesFromApis } from "../../firewall-types";
import {
  getConnectorFirewall,
  getDefaultFirewallPolicies,
  isFirewallConnectorType,
} from "../index";

describe("base44 firewall", () => {
  it("registers the Base44 firewall with OAuth placeholder expansion", () => {
    expect(isFirewallConnectorType("base44")).toBe(true);
    const firewall = getConnectorFirewall("base44");

    expect(firewall.name).toBe("base44");
    expect(firewall.apis).toHaveLength(2);
    expect(firewall.apis[0]).toMatchObject({
      base: "https://app.base44.com/mcp",
      auth: {
        headers: {
          Authorization: "Bearer ${{ secrets.BASE44_TOKEN }}",
        },
      },
      permissions: [],
    });
    expect(firewall.apis[1]).toMatchObject({
      base: "https://app.base44.com/api/apps",
      auth: {
        headers: {
          Authorization: "Bearer ${{ secrets.BASE44_TOKEN }}",
        },
      },
      permissions: [],
    });
    expect(extractSecretNamesFromApis([...firewall.apis])).toStrictEqual([
      "BASE44_TOKEN",
    ]);
    expect(firewall.placeholders).toMatchObject({
      BASE44_TOKEN: "base44_placeholder_token",
      BASE44_ACCESS_TOKEN: "base44_placeholder_token",
    });
    expect(getDefaultFirewallPolicies("base44")).toStrictEqual({
      policies: {},
      unknownPolicy: "allow",
    });
  });
});
