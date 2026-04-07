import { describe, expect, it } from "vitest";
import type { ExpandedFirewallConfig } from "@vm0/core";
import {
  applyConnectorPolicies,
  UNRESTRICTED_PERMISSION,
} from "../build-zero-context";

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

    const result = applyConnectorPolicies([fw], undefined);

    expect(result).toHaveLength(1);
    const entry = result[0];
    expect(entry).toBeDefined();
    expect(entry?.apis[0]?.permissions).toEqual(permissions);
  });

  it("filters permissions by policy when permissions are defined", () => {
    const fw = makeFirewall({
      ref: "github",
      apis: [
        {
          base: "https://api.github.com",
          auth: { headers: { Authorization: "Bearer token" } },
          permissions: [
            { name: "repo-read", rules: ["GET /repos/{owner}/{repo}"] },
            { name: "repo-write", rules: ["PUT /repos/{owner}/{repo}"] },
            {
              name: "issues-read",
              rules: ["GET /repos/{owner}/{repo}/issues"],
            },
          ],
        },
      ],
    });

    const result = applyConnectorPolicies([fw], {
      github: {
        "repo-read": "allow",
        "repo-write": "deny",
        "issues-read": "allow",
      },
    });

    expect(result[0]?.apis[0]?.permissions).toEqual([
      { name: "repo-read", rules: ["GET /repos/{owner}/{repo}"] },
      { name: "issues-read", rules: ["GET /repos/{owner}/{repo}/issues"] },
    ]);
  });

  it("returns unrestricted when firewall has no permissions on any api", () => {
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

    const result = applyConnectorPolicies([fw], {
      "custom-api": { "some-perm": "allow" },
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.apis[0]?.permissions).toEqual([UNRESTRICTED_PERMISSION]);
    expect(result[0]?.apis[1]?.permissions).toEqual([UNRESTRICTED_PERMISSION]);
  });

  it("returns unrestricted when all api permissions are empty arrays", () => {
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

    const result = applyConnectorPolicies([fw], {
      "custom-api": { x: "allow" },
    });

    expect(result[0]?.apis[0]?.permissions).toEqual([UNRESTRICTED_PERMISSION]);
  });
});
