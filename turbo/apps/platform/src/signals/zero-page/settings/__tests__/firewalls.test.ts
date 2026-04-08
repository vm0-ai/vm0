import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server.ts";
import { testContext } from "../../../__tests__/test-helpers.ts";
import { setupPage } from "../../../../__tests__/page-helper.ts";
import { hasFirewallPermissions, saveFirewallPolicies$ } from "../firewalls.ts";

const context = testContext();

describe("hasFirewallPermissions", () => {
  it("should return true for connectors with firewall permissions", () => {
    expect(hasFirewallPermissions("slack")).toBeTruthy();
    expect(hasFirewallPermissions("gmail")).toBeTruthy();
    expect(hasFirewallPermissions("atlassian")).toBeTruthy();
    expect(hasFirewallPermissions("x")).toBeTruthy();
  });

  it("should return false for connectors without firewall permissions", () => {
    expect(hasFirewallPermissions("unknown" as never)).toBeFalsy();
  });

  it("should return false for connectors with firewall but no permissions", () => {
    // stripe has a firewall config but no permissions defined
    expect(hasFirewallPermissions("stripe")).toBeFalsy();
  });
});

describe("saveFirewallPolicies$", () => {
  it("should send name in request body and return persisted policies", async () => {
    await setupPage({ context, path: "/", withoutRender: true });

    const policies = { slack: { "channels:read": "allow" as const } };
    let capturedBody: Record<string, unknown> | null = null;

    server.use(
      http.put("*/api/zero/firewall-policies", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          agentId: "compose-1",
          ownerId: "test-user-123",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          connectors: [],
          firewallPolicies: policies,
        });
      }),
    );

    const result = await context.store.set(
      saveFirewallPolicies$,
      "my-agent",
      policies,
      context.signal,
    );

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.agentId).toBe("my-agent");
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
      context.store.set(saveFirewallPolicies$, "my-agent", {}, context.signal),
    ).rejects.toThrow("Only org admins can update");
  });
});
