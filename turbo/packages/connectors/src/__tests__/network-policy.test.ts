import { describe, expect, it } from "vitest";

import {
  networkPoliciesSchema,
  networkPolicyPermissionList,
  networkPolicyPermissionPolicy,
  networkPolicySchema,
} from "../firewall-types";

describe("networkPolicySchema", () => {
  it("accepts historical expanded policies without kind", () => {
    const parsed = networkPolicySchema.parse({
      allow: ["repo-read"],
      deny: ["repo-write"],
      ask: [],
      unknownPolicy: "deny",
    });

    expect(parsed).toStrictEqual({
      allow: ["repo-read"],
      deny: ["repo-write"],
      ask: [],
      unknownPolicy: "deny",
    });
  });

  it("accepts tagged expanded policies", () => {
    const parsed = networkPolicySchema.parse({
      kind: "expanded",
      allow: ["repo-read"],
      deny: [],
      ask: ["repo-admin"],
      unknownPolicy: "allow",
    });

    expect(parsed.kind).toBe("expanded");
  });

  it("accepts compact default-overrides policies", () => {
    const parsed = networkPoliciesSchema.parse({
      github: {
        kind: "default-overrides",
        defaultPermissionPolicy: "allow",
        permissionOverrides: {
          deny: ["repo-write"],
          ask: ["repo-admin"],
        },
        unknownPolicy: "deny",
        catalogVersion: "catalog-1",
      },
    });

    expect(parsed.github).toStrictEqual({
      kind: "default-overrides",
      defaultPermissionPolicy: "allow",
      permissionOverrides: {
        deny: ["repo-write"],
        ask: ["repo-admin"],
      },
      unknownPolicy: "deny",
      catalogVersion: "catalog-1",
    });
  });

  it("rejects invalid compact policy values", () => {
    const result = networkPolicySchema.safeParse({
      kind: "default-overrides",
      defaultPermissionPolicy: "blocked",
      unknownPolicy: "allow",
    });

    expect(result.success).toBe(false);
  });
});

describe("network policy helpers", () => {
  it("computes effective expanded policy with implicit allow fallback", () => {
    const policy = networkPolicySchema.parse({
      allow: ["repo-read"],
      deny: ["repo-write"],
      ask: ["repo-admin"],
      unknownPolicy: "deny",
    });

    expect(networkPolicyPermissionPolicy(policy, "repo-read")).toBe("allow");
    expect(networkPolicyPermissionPolicy(policy, "repo-write")).toBe("deny");
    expect(networkPolicyPermissionPolicy(policy, "repo-admin")).toBe("ask");
    expect(networkPolicyPermissionPolicy(policy, "repo-status")).toBe("allow");
  });

  it("computes effective compact policy from default plus overrides", () => {
    const policy = networkPolicySchema.parse({
      kind: "default-overrides",
      defaultPermissionPolicy: "deny",
      permissionOverrides: {
        allow: ["repo-read"],
        ask: ["repo-admin"],
      },
      unknownPolicy: "deny",
    });

    expect(networkPolicyPermissionPolicy(policy, "repo-read")).toBe("allow");
    expect(networkPolicyPermissionPolicy(policy, "repo-admin")).toBe("ask");
    expect(networkPolicyPermissionPolicy(policy, "repo-write")).toBe("deny");
    expect(networkPolicyPermissionList(policy, "allow")).toStrictEqual([
      "repo-read",
    ]);
  });
});
