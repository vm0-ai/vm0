import { describe, expect, it } from "vitest";
import type { ExpandedFirewallConfig } from "@vm0/core";
import { mergePermissions } from "../context/resolve-permissions";

function jiraLikeFirewall(): ExpandedFirewallConfig {
  return {
    name: "jira",
    apis: [
      {
        base: "https://${{ vars.JIRA_DOMAIN }}",
        auth: {
          headers: { Authorization: "Bearer ${{ secrets.JIRA_API_TOKEN }}" },
        },
        permissions: [
          { name: "issues-read", rules: ["GET /rest/api/3/issue"] },
        ],
      },
    ],
  };
}

function githubStaticFirewall(): ExpandedFirewallConfig {
  return {
    name: "github",
    apis: [
      {
        base: "https://api.github.com",
        auth: {
          headers: { Authorization: "Bearer ${{ secrets.GITHUB_TOKEN }}" },
        },
        permissions: [{ name: "repo-read", rules: ["GET /repos"] }],
      },
    ],
  };
}

describe("mergePermissions", () => {
  it("drops firewall whose base URL var is unset and removes its networkPolicies entry", () => {
    const result = mergePermissions(
      null,
      [githubStaticFirewall(), jiraLikeFirewall()],
      undefined,
      {}, // no vars provided — jira's JIRA_DOMAIN is unset
    );

    expect(result).toBeDefined();
    expect(
      result!.firewalls.map((fw) => {
        return fw.name;
      }),
    ).toEqual(["github"]);
    // Orphan networkPolicies entry must not leak for dropped firewalls
    expect(Object.keys(result!.networkPolicies)).toEqual(["github"]);
  });

  it("returns undefined when all firewalls are dropped", () => {
    const result = mergePermissions(null, [jiraLikeFirewall()], undefined, {});
    expect(result).toBeUndefined();
  });

  it("keeps firewall when its base URL var is provided", () => {
    const result = mergePermissions(null, [jiraLikeFirewall()], undefined, {
      JIRA_DOMAIN: "acme.atlassian.net",
    });

    expect(result).toBeDefined();
    expect(result!.firewalls).toHaveLength(1);
    expect(result!.firewalls[0]!.apis[0]!.base).toBe(
      "https://acme.atlassian.net",
    );
    expect(result!.networkPolicies.jira).toBeDefined();
  });
});
