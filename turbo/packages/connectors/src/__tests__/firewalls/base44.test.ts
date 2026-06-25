import { describe, expect, it } from "vitest";

import { extractSecretNamesFromApis } from "../../firewall-types";
import {
  loadDefaultFirewallPolicies,
  loadRequiredConnectorFirewall,
} from "../firewall-test-helpers";

describe("base44 firewall", () => {
  it("registers the Base44 firewall with OAuth placeholder expansion", async () => {
    const firewall = await loadRequiredConnectorFirewall("base44");

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
    await expect(loadDefaultFirewallPolicies("base44")).resolves.toStrictEqual({
      policies: {},
      unknownPolicy: "allow",
    });
  });
});
