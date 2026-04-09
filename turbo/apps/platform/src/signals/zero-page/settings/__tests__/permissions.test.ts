import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server.ts";
import { testContext } from "../../../__tests__/test-helpers.ts";
import { setupPage } from "../../../../__tests__/page-helper.ts";
import {
  hasConnectorPermissions,
  savePermissionPolicies$,
} from "../permissions.ts";

const context = testContext();

describe("hasConnectorPermissions", () => {
  it("should return true for connectors with permissions", () => {
    expect(hasConnectorPermissions("slack")).toBeTruthy();
    expect(hasConnectorPermissions("gmail")).toBeTruthy();
    expect(hasConnectorPermissions("x")).toBeTruthy();
  });

  it("should return false for connectors without permissions", () => {
    expect(hasConnectorPermissions("unknown" as never)).toBeFalsy();
  });

  it("should return false for connectors with config but no permissions", () => {
    // hubspot, atlassian, stripe have connector configs but no permissions defined
    expect(hasConnectorPermissions("hubspot")).toBeFalsy();
    expect(hasConnectorPermissions("atlassian")).toBeFalsy();
    expect(hasConnectorPermissions("stripe")).toBeFalsy();
  });
});

describe("savePermissionPolicies$", () => {
  it("should send name in request body and return persisted policies", async () => {
    await setupPage({ context, path: "/", withoutRender: true });

    const policies = {
      slack: { permissions: { "channels:read": "allow" as const } },
    };
    let capturedBody: Record<string, unknown> | null = null;

    server.use(
      http.put("*/api/zero/permission-policies", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          agentId: "compose-1",
          ownerId: "test-user-123",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          connectors: [],
          permissionPolicies: policies,
        });
      }),
    );

    const result = await context.store.set(
      savePermissionPolicies$,
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
      http.put("*/api/zero/permission-policies", () => {
        return HttpResponse.json(
          {
            error: { message: "Only org admins can update", code: "FORBIDDEN" },
          },
          { status: 403 },
        );
      }),
    );

    await expect(
      context.store.set(
        savePermissionPolicies$,
        "my-agent",
        {},
        context.signal,
      ),
    ).rejects.toThrow("Only org admins can update");
  });
});
