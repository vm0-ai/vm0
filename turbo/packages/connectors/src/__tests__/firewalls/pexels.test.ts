import { describe, expect, it } from "vitest";

import { extractSecretNamesFromApis } from "../../firewall-types";
import {
  loadDefaultFirewallPolicies,
  loadRequiredConnectorFirewall,
} from "../firewall-test-helpers";

describe("pexels firewall", () => {
  it("registers Pexels API and media asset hosts", async () => {
    const firewall = await loadRequiredConnectorFirewall("pexels");

    expect(firewall.name).toBe("pexels");
    expect(firewall.apis).toHaveLength(4);
    expect(firewall.apis[0]).toMatchObject({
      base: "https://api.pexels.com/v1",
      auth: {
        headers: {
          Authorization: "${{ secrets.PEXELS_API_KEY }}",
        },
      },
    });
    expect(firewall.apis[1]).toMatchObject({
      base: "https://api.pexels.com/videos",
      auth: {
        headers: {
          Authorization: "${{ secrets.PEXELS_API_KEY }}",
        },
      },
    });
    expect(firewall.apis[2]).toMatchObject({
      base: "https://images.pexels.com",
    });
    expect(firewall.apis[3]).toMatchObject({
      base: "https://videos.pexels.com",
    });
    expect(extractSecretNamesFromApis([...firewall.apis])).toStrictEqual([
      "PEXELS_API_KEY",
    ]);
    expect(firewall.placeholders).toHaveProperty("PEXELS_API_KEY");
    await expect(loadDefaultFirewallPolicies("pexels")).resolves.toStrictEqual({
      policies: {
        "photos.read": "allow",
        "collections.read": "allow",
        "videos.read": "allow",
        "media.download": "allow",
      },
      unknownPolicy: "deny",
    });
  });
});
