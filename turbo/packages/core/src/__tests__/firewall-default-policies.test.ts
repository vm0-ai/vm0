import { describe, it, expect } from "vitest";
import {
  getDefaultFirewallPolicies,
  resolveFirewallPolicies,
  getConnectorFirewall,
} from "../firewalls/index";

describe("getDefaultFirewallPolicies", () => {
  it("should return allow/deny map for connectors with defaults", () => {
    const policies = getDefaultFirewallPolicies("slack");
    expect(policies).not.toBeNull();

    // Slack has defaults — every permission should be either "allow" or "deny"
    const values = Object.values(policies!);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) {
      expect(["allow", "deny"]).toContain(v);
    }
  });

  it("should mark default-allowed permissions as allow", () => {
    const policies = getDefaultFirewallPolicies("slack")!;
    // "channels:read" is in slackDefaultAllowed
    expect(policies["channels:read"]).toBe("allow");
  });

  it("should mark non-default permissions as deny", () => {
    const policies = getDefaultFirewallPolicies("slack")!;
    // "admin" is a slack permission that is NOT in the default-allowed list
    expect(policies["admin"]).toBe("deny");
  });

  it("should cover every permission from the firewall config", () => {
    const policies = getDefaultFirewallPolicies("slack")!;
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

  it("should return null for connectors without defaults", () => {
    expect(getDefaultFirewallPolicies("github")).toBeNull();
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

  it("should pass through connectors without defaults unchanged", () => {
    const stored = { github: { "repo-read": "allow" as const } };
    const resolved = resolveFirewallPolicies(stored, ["github"]);
    expect(resolved).toEqual(stored);
  });

  it("should skip non-firewall connector types", () => {
    const resolved = resolveFirewallPolicies(null, ["jira"]);
    expect(resolved).toBeNull();
  });

  it("should handle mixed connectors", () => {
    const stored = { github: { "repo-read": "allow" as const } };
    const resolved = resolveFirewallPolicies(stored, [
      "github",
      "slack",
      "jira",
    ]);
    expect(resolved!["github"]).toEqual({ "repo-read": "allow" });
    const slackMixed = resolved!["slack"];
    expect(slackMixed).toBeDefined();
    expect(slackMixed!["channels:read"]).toBe("allow");
    expect(resolved).not.toHaveProperty("jira");
  });

  it("should return null when no connectors need defaults", () => {
    const resolved = resolveFirewallPolicies(null, ["github"]);
    expect(resolved).toBeNull();
  });
});
