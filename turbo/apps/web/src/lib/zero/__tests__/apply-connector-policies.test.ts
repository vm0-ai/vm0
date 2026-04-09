import { describe, expect, it } from "vitest";
import type { ExpandedFirewallConfig } from "@vm0/core";
import { applyConnectorPolicies } from "../build-zero-context";

function makeFirewall(
  overrides: Partial<ExpandedFirewallConfig> & { ref: string },
): ExpandedFirewallConfig {
  return {
    name: overrides.name ?? overrides.ref,
    ref: overrides.ref,
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
      ref: "github",
      apis: [
        {
          base: "https://api.github.com",
          auth: { headers: { Authorization: "Bearer token" } },
          permissions,
        },
      ],
    });

    const { firewalls, grantedPermissions } = applyConnectorPolicies(
      [fw],
      undefined,
    );

    expect(firewalls).toHaveLength(1);
    expect(firewalls[0]?.apis[0]?.permissions).toEqual(permissions);
    // No policies → all permissions granted
    expect(grantedPermissions).toEqual({
      github: {
        allow: ["repo-read", "repo-write"],
        deny: [],
        ask: [],
        allowUnknown: true,
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
      ref: "github",
      apis: [
        {
          base: "https://api.github.com",
          auth: { headers: { Authorization: "Bearer token" } },
          permissions: allPermissions,
        },
      ],
    });

    const { firewalls, grantedPermissions } = applyConnectorPolicies([fw], {
      github: {
        permissions: {
          "repo-read": "allow",
          "repo-write": "deny",
          "issues-read": "allow",
        },
      },
    });

    // Firewalls carry ALL permissions (unfiltered)
    expect(firewalls[0]?.apis[0]?.permissions).toEqual(allPermissions);
    // grantedPermissions splits by policy
    expect(grantedPermissions).toEqual({
      github: {
        allow: ["repo-read", "issues-read"],
        deny: ["repo-write"],
        ask: [],
        allowUnknown: true,
      },
    });
  });

  it("passes empty permissions as-is when firewall has none", () => {
    const fw = makeFirewall({
      ref: "custom-api",
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

    const { firewalls, grantedPermissions } = applyConnectorPolicies([fw], {
      "custom-api": { permissions: { "some-perm": "allow" } },
    });

    expect(firewalls).toHaveLength(1);
    expect(firewalls[0]?.apis[0]?.permissions).toEqual([]);
    expect(firewalls[0]?.apis[1]?.permissions).toEqual([]);
    // No permissions defined → empty granted, allow unknown
    expect(grantedPermissions).toEqual({
      "custom-api": {
        allow: [],
        deny: [],
        ask: [],
        allowUnknown: true,
      },
    });
  });

  it("passes empty permissions when all api permissions are empty arrays", () => {
    const fw = makeFirewall({
      ref: "custom-api",
      apis: [
        {
          base: "https://api.custom.com",
          auth: { headers: {} },
          permissions: [],
        },
      ],
    });

    const { firewalls, grantedPermissions } = applyConnectorPolicies([fw], {
      "custom-api": { permissions: { x: "allow" } },
    });

    expect(firewalls[0]?.apis[0]?.permissions).toEqual([]);
    expect(grantedPermissions).toEqual({
      "custom-api": {
        allow: [],
        deny: [],
        ask: [],
        allowUnknown: true,
      },
    });
  });

  it("sets allowUnknown from allowUnknownEndpoints param", () => {
    const fw = makeFirewall({
      ref: "github",
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

    const { grantedPermissions } = applyConnectorPolicies([fw], {
      github: { permissions: { "repo-read": "allow" }, allowUnknown: true },
    });

    expect(grantedPermissions.github).toEqual({
      allow: ["repo-read"],
      deny: [],
      ask: [],
      allowUnknown: true,
    });
  });

  it("classifies ask policy into ask array", () => {
    const fw = makeFirewall({
      ref: "github",
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

    const { grantedPermissions } = applyConnectorPolicies([fw], {
      github: {
        permissions: {
          "repo-read": "allow",
          "repo-write": "ask",
          admin: "deny",
        },
      },
    });

    expect(grantedPermissions.github).toEqual({
      allow: ["repo-read"],
      deny: ["admin"],
      ask: ["repo-write"],
      allowUnknown: true,
    });
  });

  it("defaults allowUnknown to true when ref absent from allowUnknownEndpoints", () => {
    const fw = makeFirewall({
      ref: "github",
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

    const { grantedPermissions } = applyConnectorPolicies([fw], {
      github: { permissions: { "repo-read": "allow" } },
    });

    expect(grantedPermissions.github).toEqual({
      allow: ["repo-read"],
      deny: [],
      ask: [],
      allowUnknown: true,
    });
  });
});
