import { describe, expect, it } from "vitest";

import { extractSecretNamesFromApis } from "../../firewall-types";
import {
  loadDefaultFirewallPolicies,
  loadRequiredConnectorFirewall,
} from "../firewall-test-helpers";

describe("render firewall", () => {
  it("registers the Render public API firewall with API key auth", async () => {
    const firewall = await loadRequiredConnectorFirewall("render");

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
    await expect(loadDefaultFirewallPolicies("render")).resolves.toStrictEqual({
      policies: {},
      unknownPolicy: "allow",
    });
  });
});
