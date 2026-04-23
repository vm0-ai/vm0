import { describe, expect, it } from "vitest";
import type { ExpandedFirewallConfig } from "@vm0/core/contracts/firewalls";
import { applyConnectorPolicies } from "../build-zero-context";

function makeFirewall(
  overrides: Partial<ExpandedFirewallConfig> & { name: string },
): ExpandedFirewallConfig {
  return {
    name: overrides.name,
    apis: overrides.apis ?? [
      {
        base: `https://api.example.com`,
        auth: { headers: { Authorization: "Bearer ${{ secrets.TOKEN }}" } },
      },
    ],
  };
}

describe("applyConnectorPolicies", () => {
  it("includes all permissions when no policies are provided", () => {
    const permissions = [
      { name: "repo-read", rules: ["GET /repos/{owner}/{repo}"] },
      { name: "repo-write", rules: ["PUT /repos/{owner}/{repo}"] },
    ];
    const fw = makeFirewall({
      name: "github",
      apis: [
        {
          base: "https://api.github.com",
          auth: { headers: { Authorization: "Bearer token" } },
          permissions,
        },
      ],
    });

    const { firewalls, networkPolicies } = applyConnectorPolicies(
      [fw],
      undefined,
    );

    expect(firewalls).toHaveLength(1);
    expect(firewalls[0]?.apis[0]?.permissions).toEqual(permissions);
    // No policies → all permissions granted
    expect(networkPolicies).toEqual({
      github: {
        allow: ["repo-read", "repo-write"],
        deny: [],
        ask: [],
        unknownPolicy: "allow",
      },
    });
  });

  it("keeps all permissions in firewalls but grants only allowed ones", () => {
    const allPermissions = [
      { name: "repo-read", rules: ["GET /repos/{owner}/{repo}"] },
      { name: "repo-write", rules: ["PUT /repos/{owner}/{repo}"] },
      { name: "issues-read", rules: ["GET /repos/{owner}/{repo}/issues"] },
    ];
    const fw = makeFirewall({
      name: "github",
      apis: [
        {
          base: "https://api.github.com",
          auth: { headers: { Authorization: "Bearer token" } },
          permissions: allPermissions,
        },
      ],
    });

    const { firewalls, networkPolicies } = applyConnectorPolicies([fw], {
      github: {
        policies: {
          "repo-read": "allow",
          "repo-write": "deny",
          "issues-read": "allow",
        },
      },
    });

    // Firewalls carry ALL permissions (unfiltered)
    expect(firewalls[0]?.apis[0]?.permissions).toEqual(allPermissions);
    // networkPolicies splits by policy
    expect(networkPolicies).toEqual({
      github: {
        allow: ["repo-read", "issues-read"],
        deny: ["repo-write"],
        ask: [],
        unknownPolicy: "allow",
      },
    });
  });

  it("passes empty permissions as-is when firewall has none", () => {
    const fw = makeFirewall({
      name: "custom-api",
      apis: [
        {
          base: "https://api.custom.com",
          auth: { headers: { Authorization: "Bearer token" } },
        },
        {
          base: "https://api2.custom.com",
          auth: { headers: { "X-Api-Key": "key" } },
        },
      ],
    });

    const { firewalls, networkPolicies } = applyConnectorPolicies([fw], {
      "custom-api": { policies: { "some-perm": "allow" } },
    });

    expect(firewalls).toHaveLength(1);
    expect(firewalls[0]?.apis[0]?.permissions).toEqual([]);
    expect(firewalls[0]?.apis[1]?.permissions).toEqual([]);
    // No permissions defined → empty granted, allow unknown
    expect(networkPolicies).toEqual({
      "custom-api": {
        allow: [],
        deny: [],
        ask: [],
        unknownPolicy: "allow",
      },
    });
  });

  it("passes empty permissions when all api permissions are empty arrays", () => {
    const fw = makeFirewall({
      name: "custom-api",
      apis: [
        {
          base: "https://api.custom.com",
          auth: { headers: {} },
          permissions: [],
        },
      ],
    });

    const { firewalls, networkPolicies } = applyConnectorPolicies([fw], {
      "custom-api": { policies: { x: "allow" } },
    });

    expect(firewalls[0]?.apis[0]?.permissions).toEqual([]);
    expect(networkPolicies).toEqual({
      "custom-api": {
        allow: [],
        deny: [],
        ask: [],
        unknownPolicy: "allow",
      },
    });
  });

  it("sets unknownPolicy from unknownPolicy param", () => {
    const fw = makeFirewall({
      name: "github",
      apis: [
        {
          base: "https://api.github.com",
          auth: { headers: { Authorization: "Bearer token" } },
          permissions: [
            { name: "repo-read", rules: ["GET /repos/{owner}/{repo}"] },
          ],
        },
      ],
    });

    const { networkPolicies } = applyConnectorPolicies([fw], {
      github: { policies: { "repo-read": "allow" }, unknownPolicy: "allow" },
    });

    expect(networkPolicies.github).toEqual({
      allow: ["repo-read"],
      deny: [],
      ask: [],
      unknownPolicy: "allow",
    });
  });

  it("classifies ask policy into ask array", () => {
    const fw = makeFirewall({
      name: "github",
      apis: [
        {
          base: "https://api.github.com",
          auth: { headers: { Authorization: "Bearer token" } },
          permissions: [
            { name: "repo-read", rules: ["GET /repos/{owner}/{repo}"] },
            { name: "repo-write", rules: ["PUT /repos/{owner}/{repo}"] },
            { name: "admin", rules: ["DELETE /repos/{owner}/{repo}"] },
          ],
        },
      ],
    });

    const { networkPolicies } = applyConnectorPolicies([fw], {
      github: {
        policies: {
          "repo-read": "allow",
          "repo-write": "ask",
          admin: "deny",
        },
      },
    });

    expect(networkPolicies.github).toEqual({
      allow: ["repo-read"],
      deny: ["admin"],
      ask: ["repo-write"],
      unknownPolicy: "allow",
    });
  });

  it("defaults unknownPolicy to allow when name absent from unknownPermissionPolicies", () => {
    const fw = makeFirewall({
      name: "github",
      apis: [
        {
          base: "https://api.github.com",
          auth: { headers: { Authorization: "Bearer token" } },
          permissions: [
            { name: "repo-read", rules: ["GET /repos/{owner}/{repo}"] },
          ],
        },
      ],
    });

    const { networkPolicies } = applyConnectorPolicies([fw], {
      github: { policies: { "repo-read": "allow" } },
    });

    expect(networkPolicies.github).toEqual({
      allow: ["repo-read"],
      deny: [],
      ask: [],
      unknownPolicy: "allow",
    });
  });
});
