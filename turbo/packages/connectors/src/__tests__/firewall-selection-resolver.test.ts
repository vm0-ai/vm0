import { describe, expect, it } from "vitest";

import { resolveFirewallSelections } from "../firewall-selection-resolver";

describe("resolveFirewallSelections", () => {
  it("should resolve builtin firewall with permissions: all", async () => {
    const expanded = await resolveFirewallSelections({
      brex: { permissions: "all" },
    });

    expect(expanded).toHaveLength(1);
    expect(expanded[0]!.name).toBe("brex");
    expect(expanded[0]!.apis.length).toBeGreaterThan(0);
    const permNames = expanded[0]!.apis[0]!.permissions!.map((p) => {
      return p.name;
    });
    expect(permNames).toContain("read");
    expect(permNames).toContain("write");
  });

  it("should resolve firewall with specific permissions", async () => {
    const expanded = await resolveFirewallSelections({
      brex: { permissions: ["read", "write"] },
    });

    expect(expanded).toHaveLength(1);
    expect(expanded[0]!.apis[0]!.permissions).toHaveLength(2);
    const permNames = expanded[0]!.apis[0]!.permissions!.map((p) => {
      return p.name;
    });
    expect(permNames).toContain("read");
    expect(permNames).toContain("write");
  });

  it("should include placeholders and description when config has them", async () => {
    const expanded = await resolveFirewallSelections({
      brex: { permissions: "all" },
    });

    expect(expanded[0]!.placeholders).toMatchObject({
      BREX_TOKEN: "CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocal",
    });
    expect(expanded[0]!.description).toBe("Brex API");
  });

  it("should resolve multiple builtin firewalls", async () => {
    const expanded = await resolveFirewallSelections({
      brex: { permissions: "all" },
      "slack-webhook": { permissions: "all" },
    });

    expect(expanded).toHaveLength(2);
    const names = expanded.map((s) => {
      return s.name;
    });
    expect(names).toContain("brex");
    expect(names).toContain("slack-webhook");
  });

  it("should return empty array for empty selections", async () => {
    const expanded = await resolveFirewallSelections({});
    expect(expanded).toEqual([]);
  });

  it("should throw for non-existent permission name", async () => {
    await expect(
      resolveFirewallSelections({
        brex: { permissions: ["does-not-exist"] },
      }),
    ).rejects.toThrow(
      'Permission "does-not-exist" does not exist in firewall "brex"',
    );
  });

  it("should reject non-builtin firewall names", async () => {
    await expect(
      resolveFirewallSelections({
        "custom-git": { permissions: "all" },
      }),
    ).rejects.toThrow(
      'Unsupported firewall "custom-git": only built-in connector firewalls are supported',
    );
  });

  it("should reject GitHub URL firewall refs", async () => {
    await expect(
      resolveFirewallSelections({
        "https://github.com/acme/firewalls/tree/main/my-firewall": {
          permissions: "all",
        },
      }),
    ).rejects.toThrow(
      'Unsupported firewall "https://github.com/acme/firewalls/tree/main/my-firewall": only built-in connector firewalls are supported',
    );
  });

  it("should validate unsupported firewall refs before permission names", async () => {
    await expect(
      resolveFirewallSelections({
        brex: { permissions: ["does-not-exist"] },
        "custom-git": { permissions: "all" },
      }),
    ).rejects.toThrow(
      'Unsupported firewall "custom-git": only built-in connector firewalls are supported',
    );
  });

  it("should filter permissions and keep only selected ones", async () => {
    const expanded = await resolveFirewallSelections({
      brex: { permissions: ["read"] },
    });

    expect(expanded[0]!.apis[0]!.permissions).toHaveLength(1);
    expect(expanded[0]!.apis[0]!.permissions![0]!.name).toBe("read");
  });

  it("should keep all api_entries when shared permission is selected", async () => {
    const expanded = await resolveFirewallSelections({
      gmail: { permissions: ["messages.send"] },
    });

    expect(expanded).toHaveLength(1);
    expect(expanded[0]!.apis.length).toBeGreaterThan(1);
    for (const api of expanded[0]!.apis) {
      expect(
        api.permissions?.map((p) => {
          return p.name;
        }),
      ).toEqual(["messages.send"]);
    }
  });

  it("should retain api entries with empty permissions when user picks all", async () => {
    const expanded = await resolveFirewallSelections({
      "slack-webhook": { permissions: "all" },
    });

    expect(expanded).toHaveLength(1);
    expect(expanded[0]!.name).toBe("slack-webhook");
    expect(expanded[0]!.apis).toHaveLength(1);
    for (const api of expanded[0]!.apis) {
      expect(api.permissions ?? []).toEqual([]);
    }
  });
});
