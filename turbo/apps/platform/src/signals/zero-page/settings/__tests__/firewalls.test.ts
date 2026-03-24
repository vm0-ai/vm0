import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server.ts";
import { testContext } from "../../../__tests__/test-helpers.ts";
import { setupPage } from "../../../../__tests__/page-helper.ts";
import {
  hasFirewallConfig,
  getFirewallRefs,
  saveFirewallPolicies$,
} from "../firewalls.ts";

const context = testContext();

describe("hasFirewallConfig", () => {
  it("should return true for connectors with firewall configs", () => {
    expect(hasFirewallConfig("github")).toBeTruthy();
    expect(hasFirewallConfig("slack")).toBeTruthy();
    expect(hasFirewallConfig("gmail")).toBeTruthy();
    expect(hasFirewallConfig("atlassian")).toBeTruthy();
  });

  it("should return false for connectors without firewall configs", () => {
    expect(hasFirewallConfig("notion" as never)).toBeFalsy();
    expect(hasFirewallConfig("unknown" as never)).toBeFalsy();
  });
});

describe("getFirewallRefs", () => {
  it("should return single ref for simple connectors", () => {
    expect(getFirewallRefs("github")).toStrictEqual(["github"]);
    expect(getFirewallRefs("slack")).toStrictEqual(["slack"]);
  });

  it("should return multiple refs for atlassian", () => {
    expect(getFirewallRefs("atlassian")).toStrictEqual(["jira", "confluence"]);
  });

  it("should return empty array for unknown connector", () => {
    expect(getFirewallRefs("unknown" as never)).toStrictEqual([]);
  });
});

describe("saveFirewallPolicies$", () => {
  it("should send name in request body and return persisted policies", async () => {
    await setupPage({ context, path: "/", withoutRender: true });

    const policies = { github: { "issues:read": "allow" as const } };
    let capturedBody: Record<string, unknown> | null = null;

    server.use(
      http.put("*/api/zero/firewall-policies", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          name: "my-agent",
          agentId: "compose-1",
          description: null,
          displayName: null,
          sound: null,
          connectors: [],
          firewallPolicies: policies,
        });
      }),
    );

    const result = await context.store.set(
      saveFirewallPolicies$,
      "my-agent",
      policies,
    );

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.name).toBe("my-agent");
    expect(capturedBody!.policies).toStrictEqual(policies);
    expect(result).toStrictEqual(policies);
  });

  it("should throw on non-ok response with error message", async () => {
    await setupPage({ context, path: "/", withoutRender: true });

    server.use(
      http.put("*/api/zero/firewall-policies", () => {
        return HttpResponse.json(
          {
            error: { message: "Only org admins can update", code: "FORBIDDEN" },
          },
          { status: 403 },
        );
      }),
    );

    await expect(
      context.store.set(saveFirewallPolicies$, "my-agent", {}),
    ).rejects.toThrow("Only org admins can update");
  });
});
