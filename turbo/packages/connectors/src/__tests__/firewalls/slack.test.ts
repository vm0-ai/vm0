import { describe, expect, it } from "vitest";

import { findMatchingPermissions } from "../../firewall-rule-matcher";
import {
  getConnectorFirewall,
  getDefaultFirewallPolicies,
} from "../../firewalls";

const RUNTIME_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

function slackMatches(method: string, path: string): string[] {
  return findMatchingPermissions(method, path, getConnectorFirewall("slack"), {
    apiBase: "https://slack.com/api",
  });
}

function expectSlackMatches(
  method: string,
  path: string,
  permissionNames: readonly string[],
): void {
  expect([...slackMatches(method, path)].sort()).toStrictEqual(
    [...permissionNames].sort(),
  );
}

function expandRuntimeRules(rule: string): string[] {
  const spaceIndex = rule.indexOf(" ");
  const method = rule.slice(0, spaceIndex);
  const path = rule.slice(spaceIndex + 1);
  if (method !== "ANY") return [rule];
  return RUNTIME_METHODS.map((runtimeMethod) => {
    return `${runtimeMethod} ${path}`;
  });
}

describe("slack firewall", () => {
  it("assigns one permission owner to every runtime route", () => {
    const duplicates: string[] = [];
    for (const api of getConnectorFirewall("slack").apis) {
      const owners = new Map<string, string>();
      for (const permission of api.permissions ?? []) {
        for (const rule of permission.rules) {
          for (const runtimeRule of expandRuntimeRules(rule)) {
            const key = `${api.base} ${runtimeRule}`;
            const existing = owners.get(key);
            if (existing) {
              duplicates.push(`${key}: ${existing}, ${permission.name}`);
              continue;
            }
            owners.set(key, permission.name);
          }
        }
      }
    }

    expect(duplicates).toStrictEqual([]);
  });

  it("maps shared Conversations API routes to vm0-owned permissions", () => {
    expectSlackMatches("GET", "/conversations.history", [
      "conversations:history",
    ]);
    expectSlackMatches("GET", "/conversations.replies", [
      "conversations:history",
    ]);
    expectSlackMatches("GET", "/conversations.info", ["conversations:read"]);
    expectSlackMatches("GET", "/conversations.list", ["conversations:read"]);
    expectSlackMatches("GET", "/conversations.members", ["conversations:read"]);
    expectSlackMatches("GET", "/users.conversations", ["conversations:read"]);
  });

  it("maps shared Conversations API mutations to vm0-owned permissions", () => {
    expectSlackMatches("POST", "/conversations.archive", [
      "conversations:write",
    ]);
    expectSlackMatches("POST", "/conversations.invite", [
      "conversations:write.invites",
    ]);
    expectSlackMatches("POST", "/conversations.setTopic", [
      "conversations:write.topic",
    ]);
    expectSlackMatches("POST", "/conversations.setPurpose", [
      "conversations:write.topic",
    ]);
    expectSlackMatches("POST", "/conversations.join", ["channels:join"]);
  });

  it("maps other shared-scope routes to single vm0-owned permissions", () => {
    expectSlackMatches("POST", "/assistant.search.context", [
      "assistant.search:read",
    ]);
    expectSlackMatches("GET", "/team.externalTeams.list", [
      "conversations.connect:read",
    ]);
    expectSlackMatches("POST", "/users.discoverableContacts.lookup", [
      "conversations.connect:read",
    ]);
  });

  it("preserves default read access for shared Slack conversation routes", () => {
    const policies = getDefaultFirewallPolicies("slack").policies;

    expect(policies["assistant.search:read"]).toBe("deny");
    expect(policies["conversations:history"]).toBe("allow");
    expect(policies["conversations:read"]).toBe("allow");
    expect(policies["conversations:write"]).toBe("deny");
    expect(policies["conversations:write.invites"]).toBe("deny");
    expect(policies["conversations:write.topic"]).toBe("deny");
    expect(policies["conversations.connect:read"]).toBe("allow");
  });
});
