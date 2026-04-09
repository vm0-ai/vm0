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
    const values = Object.values(policy.policies);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) {
      expect(["allow", "deny"]).toContain(v);
    }
    expect(policy.unknownPolicy).toBe("allow");
  });

  it("should mark default-allowed permissions as allow", () => {
    const policy = getDefaultFirewallPolicies("slack");
    expect(policy.policies["channels:read"]).toBe("allow");
  });

  it("should mark non-default permissions as deny", () => {
    const policy = getDefaultFirewallPolicies("slack");
    expect(policy.policies["admin"]).toBe("deny");
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
      expect(policy.policies).toHaveProperty(name);
    }
    expect(Object.keys(policy.policies)).toHaveLength(allPermissions.size);
  });

  it("should return empty permissions for connectors with no static permissions", () => {
    const policy = getDefaultFirewallPolicies("github");
    expect(Object.keys(policy.policies)).toHaveLength(0);
    expect(policy.unknownPolicy).toBe("allow");
  });
});

describe("resolveFirewallPolicies", () => {
  it("should fill in defaults for connectors missing from stored policies", () => {
    const resolved = resolveFirewallPolicies(null, ["slack"]);
    expect(resolved).not.toBeNull();
    const slack = resolved!["slack"]!;
    expect(slack).toBeDefined();
    expect(slack.policies["channels:read"]).toBe("allow");
    expect(slack.policies["admin"]).toBe("deny");
  });

  it("should merge defaults with stored policies (stored overrides)", () => {
    const stored = {
      slack: { policies: { "channels:read": "deny" as const } },
    };
    const resolved = resolveFirewallPolicies(stored, ["slack"]);
    const slack = resolved!["slack"]!;
    expect(slack.policies["channels:read"]).toBe("deny");
    expect(slack.policies["admin"]).toBe("deny");
    expect(slack.policies["users:read"]).toBe("allow");
  });

  it("should merge stored partial policy with defaults", () => {
    const stored = {
      slack: { policies: { "files:read": "allow" as const } },
    };
    const resolved = resolveFirewallPolicies(stored, ["slack"]);
    const slack = resolved!["slack"]!;
    expect(slack.policies["files:read"]).toBe("allow");
    expect(slack.policies["channels:read"]).toBe("allow");
    expect(slack.policies["channels:history"]).toBe("allow");
    expect(slack.policies["users:read"]).toBe("allow");
    expect(slack.policies["admin"]).toBe("deny");
  });

  it("should preserve stored unknownPolicy override", () => {
    const stored = {
      slack: { policies: {}, unknownPolicy: "deny" as const },
    };
    const resolved = resolveFirewallPolicies(stored, ["slack"]);
    const slack = resolved!["slack"]!;
    expect(slack.unknownPolicy).toBe("deny");
  });

  it("should default unknownPolicy to allow when not stored", () => {
    const stored = {
      slack: { policies: { "channels:read": "allow" as const } },
    };
    const resolved = resolveFirewallPolicies(stored, ["slack"]);
    expect(resolved!["slack"]!.unknownPolicy).toBe("allow");
  });

  it("should preserve stored overrides for connectors without default-allowed list", () => {
    const stored = {
      github: { policies: { "repo-read": "deny" as const } },
    };
    const resolved = resolveFirewallPolicies(stored, ["github"]);
    expect(resolved!["github"]!.policies["repo-read"]).toBe("deny");
  });

  it("should skip non-firewall connector types", () => {
    const resolved = resolveFirewallPolicies(null, ["computer"]);
    expect(resolved).toBeNull();
  });

  it("should handle mixed connectors", () => {
    const stored = {
      github: { policies: { "repo-read": "allow" as const } },
    };
    const resolved = resolveFirewallPolicies(stored, [
      "github",
      "slack",
      "computer",
    ]);
    expect(resolved!["github"]!.policies["repo-read"]).toBe("allow");
    expect(resolved!["slack"]).toBeDefined();
    expect(resolved!["slack"]!.policies["channels:read"]).toBe("allow");
    expect(resolved).not.toHaveProperty("computer");
  });

  it("should produce entry for connectors with no stored policies", () => {
    const resolved = resolveFirewallPolicies(null, ["github"]);
    expect(resolved).not.toBeNull();
    expect(resolved!["github"]!.policies).toEqual({});
    expect(resolved!["github"]!.unknownPolicy).toBe("allow");
  });
});
