import { describe, it, expect } from "vitest";
import {
  getDefaultFirewallPolicies,
  resolveFirewallPolicies,
  getConnectorFirewall,
} from "../firewalls/index";

describe("getDefaultFirewallPolicies", () => {
  it("should return allow/deny map for connectors with defaults", () => {
    const policies = getDefaultFirewallPolicies("slack");

    // Slack has defaults — every permission should be either "allow" or "deny"
    const values = Object.values(policies);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) {
      expect(["allow", "deny"]).toContain(v);
    }
  });

  it("should mark default-allowed permissions as allow", () => {
    const policies = getDefaultFirewallPolicies("slack");
    // "channels:read" is in slackDefaultAllowed
    expect(policies["channels:read"]).toBe("allow");
  });

  it("should mark non-default permissions as deny", () => {
    const policies = getDefaultFirewallPolicies("slack");
    // "admin" is a slack permission that is NOT in the default-allowed list
    expect(policies["admin"]).toBe("deny");
  });

  it("should cover every permission from the firewall config", () => {
    const policies = getDefaultFirewallPolicies("slack");
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
      expect(policies).toHaveProperty(name);
    }
    expect(Object.keys(policies)).toHaveLength(allPermissions.size);
  });

  it("should return empty map for connectors with no permissions", () => {
    // GitHub uses GraphQL field matching, not static permissions
    const policies = getDefaultFirewallPolicies("github");
    expect(Object.keys(policies)).toHaveLength(0);
  });
});

describe("resolveFirewallPolicies", () => {
  it("should fill in defaults for connectors missing from stored policies", () => {
    const resolved = resolveFirewallPolicies(null, ["slack"]);
    expect(resolved).not.toBeNull();
    const slack = resolved!["slack"];
    expect(slack).toBeDefined();
    expect(slack!["channels:read"]).toBe("allow");
    expect(slack!["admin"]).toBe("deny");
  });

  it("should merge defaults with stored policies (stored overrides)", () => {
    const stored = { slack: { "channels:read": "deny" as const } };
    const resolved = resolveFirewallPolicies(stored, ["slack"]);
    const slack = resolved!["slack"]!;
    // Stored override takes precedence
    expect(slack["channels:read"]).toBe("deny");
    // Defaults fill in for non-specified permissions
    expect(slack["admin"]).toBe("deny");
    expect(slack["users:read"]).toBe("allow");
  });

  it("should merge stored partial policy with defaults", () => {
    // Simulates: admin approved files:read, but defaults should still apply
    const stored = { slack: { "files:read": "allow" as const } };
    const resolved = resolveFirewallPolicies(stored, ["slack"]);
    const slack = resolved!["slack"]!;
    // Explicitly stored
    expect(slack["files:read"]).toBe("allow");
    // From defaults (slackDefaultAllowed)
    expect(slack["channels:read"]).toBe("allow");
    expect(slack["channels:history"]).toBe("allow");
    expect(slack["users:read"]).toBe("allow");
    // Not in defaults — should be deny
    expect(slack["admin"]).toBe("deny");
  });

  it("should preserve stored overrides for connectors without default-allowed list", () => {
    const stored = { github: { "repo-read": "deny" as const } };
    const resolved = resolveFirewallPolicies(stored, ["github"]);
    // GitHub has no static permissions → empty defaults, stored preserved
    expect(resolved!["github"]!["repo-read"]).toBe("deny");
  });

  it("should skip non-firewall connector types", () => {
    // "computer" is a non-firewall connector type
    const resolved = resolveFirewallPolicies(null, ["computer"]);
    expect(resolved).toBeNull();
  });

  it("should handle mixed connectors", () => {
    const stored = { github: { "repo-read": "allow" as const } };
    const resolved = resolveFirewallPolicies(stored, [
      "github",
      "slack",
      "computer",
    ]);
    expect(resolved!["github"]!["repo-read"]).toBe("allow");
    const slackMixed = resolved!["slack"];
    expect(slackMixed).toBeDefined();
    expect(slackMixed!["channels:read"]).toBe("allow");
    expect(resolved).not.toHaveProperty("computer");
  });

  it("should produce entry for connectors with no stored policies", () => {
    const resolved = resolveFirewallPolicies(null, ["github"]);
    expect(resolved).not.toBeNull();
    // GitHub has no static permissions → empty defaults
    expect(resolved!["github"]).toEqual({});
  });
});
