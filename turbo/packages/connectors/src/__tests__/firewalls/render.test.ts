import { describe, expect, it } from "vitest";

import { extractSecretNamesFromApis } from "../../firewall-types";
import {
  getConnectorFirewall,
  getDefaultFirewallPolicies,
  isFirewallConnectorType,
} from "../../firewalls/index";

describe("render firewall", () => {
  it("registers the Render public API firewall with API key auth", () => {
    expect(isFirewallConnectorType("render")).toBe(true);
    const firewall = getConnectorFirewall("render");

    expect(firewall.name).toBe("render");
    expect(firewall.apis).toHaveLength(1);
    expect(firewall.apis[0]).toMatchObject({
      base: "https://api.render.com/v1",
      auth: {
        headers: {
          Authorization: "Bearer ${{ secrets.RENDER_API_KEY }}",
        },
      },
      permissions: [],
    });
    expect(extractSecretNamesFromApis([...firewall.apis])).toStrictEqual([
      "RENDER_API_KEY",
    ]);
    expect(firewall.placeholders).toHaveProperty("RENDER_API_KEY");
    expect(getDefaultFirewallPolicies("render")).toStrictEqual({
      policies: {},
      unknownPolicy: "allow",
    });
  });
});
