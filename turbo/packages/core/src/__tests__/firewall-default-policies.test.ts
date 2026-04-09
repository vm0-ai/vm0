import { describe, it, expect } from "vitest";
import {
  getDefaultFirewallPolicies,
  resolveFirewallPolicies,
  getConnectorFirewall,
} from "../firewalls/index";

describe("getDefaultFirewallPolicies", () => {
  it("should return allow/deny map for connectors with defaults", () => {
    const policy = getDefaultFirewallPolicies("slack");

    // Slack has defaults — every permission should be either "allow" or "deny"
    const values = Object.values(policy.permissions);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) {
      expect(["allow", "deny"]).toContain(v);
    }
    expect(policy.allowUnknown).toBe(true);
  });

  it("should mark default-allowed permissions as allow", () => {
    const policy = getDefaultFirewallPolicies("slack");
    expect(policy.permissions["channels:read"]).toBe("allow");
  });

  it("should mark non-default permissions as deny", () => {
    const policy = getDefaultFirewallPolicies("slack");
    expect(policy.permissions["admin"]).toBe("deny");
  });

  it("should cover every permission from the firewall config", () => {
    const policy = getDefaultFirewallPolicies("slack");
    const config = getConnectorFirewall("slack");
    const allPermissions = new Set(
      config.apis.flatMap((api) => {
        return (
          api.permissions?.map((p) => {
            return p.name;
          }) ?? []
        );
      }),
    );

    for (const name of allPermissions) {
      expect(policy.permissions).toHaveProperty(name);
    }
    expect(Object.keys(policy.permissions)).toHaveLength(allPermissions.size);
  });

  it("should return empty permissions for connectors with no static permissions", () => {
    const policy = getDefaultFirewallPolicies("github");
    expect(Object.keys(policy.permissions)).toHaveLength(0);
    expect(policy.allowUnknown).toBe(true);
  });
});

describe("resolveFirewallPolicies", () => {
  it("should fill in defaults for connectors missing from stored policies", () => {
    const resolved = resolveFirewallPolicies(null, ["slack"]);
    expect(resolved).not.toBeNull();
    const slack = resolved!["slack"]!;
    expect(slack).toBeDefined();
    expect(slack.permissions["channels:read"]).toBe("allow");
    expect(slack.permissions["admin"]).toBe("deny");
  });

  it("should merge defaults with stored policies (stored overrides)", () => {
    const stored = {
      slack: { permissions: { "channels:read": "deny" as const } },
    };
    const resolved = resolveFirewallPolicies(stored, ["slack"]);
    const slack = resolved!["slack"]!;
    expect(slack.permissions["channels:read"]).toBe("deny");
    expect(slack.permissions["admin"]).toBe("deny");
    expect(slack.permissions["users:read"]).toBe("allow");
  });

  it("should merge stored partial policy with defaults", () => {
    const stored = {
      slack: { permissions: { "files:read": "allow" as const } },
    };
    const resolved = resolveFirewallPolicies(stored, ["slack"]);
    const slack = resolved!["slack"]!;
    expect(slack.permissions["files:read"]).toBe("allow");
    expect(slack.permissions["channels:read"]).toBe("allow");
    expect(slack.permissions["channels:history"]).toBe("allow");
    expect(slack.permissions["users:read"]).toBe("allow");
    expect(slack.permissions["admin"]).toBe("deny");
  });

  it("should preserve stored allowUnknown override", () => {
    const stored = {
      slack: { permissions: {}, allowUnknown: false },
    };
    const resolved = resolveFirewallPolicies(stored, ["slack"]);
    const slack = resolved!["slack"]!;
    expect(slack.allowUnknown).toBe(false);
  });

  it("should default allowUnknown to true when not stored", () => {
    const stored = {
      slack: { permissions: { "channels:read": "allow" as const } },
    };
    const resolved = resolveFirewallPolicies(stored, ["slack"]);
    expect(resolved!["slack"]!.allowUnknown).toBe(true);
  });

  it("should preserve stored overrides for connectors without default-allowed list", () => {
    const stored = {
      github: { permissions: { "repo-read": "deny" as const } },
    };
    const resolved = resolveFirewallPolicies(stored, ["github"]);
    expect(resolved!["github"]!.permissions["repo-read"]).toBe("deny");
  });

  it("should skip non-firewall connector types", () => {
    const resolved = resolveFirewallPolicies(null, ["computer"]);
    expect(resolved).toBeNull();
  });

  it("should handle mixed connectors", () => {
    const stored = {
      github: { permissions: { "repo-read": "allow" as const } },
    };
    const resolved = resolveFirewallPolicies(stored, [
      "github",
      "slack",
      "computer",
    ]);
    expect(resolved!["github"]!.permissions["repo-read"]).toBe("allow");
    expect(resolved!["slack"]).toBeDefined();
    expect(resolved!["slack"]!.permissions["channels:read"]).toBe("allow");
    expect(resolved).not.toHaveProperty("computer");
  });

  it("should produce entry for connectors with no stored policies", () => {
    const resolved = resolveFirewallPolicies(null, ["github"]);
    expect(resolved).not.toBeNull();
    expect(resolved!["github"]!.permissions).toEqual({});
    expect(resolved!["github"]!.allowUnknown).toBe(true);
  });
});
