import { randomUUID } from "node:crypto";

import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { zeroOrgMembershipRequestsContract } from "@vm0/api-contracts/contracts/zero-org-members";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

function apiClient() {
  return setupApp({ context })(zeroOrgMembershipRequestsContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function mockClerkMembershipAction(
  action: "accept" | "reject",
  orgId: string,
  requestId: string,
  status: number,
): { readonly callCount: () => number } {
  let calls = 0;
  server.use(
    http.post(
      `https://api.clerk.com/v1/organizations/${orgId}/membership_requests/${requestId}/${action}`,
      () => {
        calls++;
        if (status === 200) {
          return HttpResponse.json({});
        }
        return HttpResponse.json({ error: "Not found" }, { status });
      },
    ),
  );
  return {
    callCount: () => {
      return calls;
    },
  };
}

describe("POST /api/zero/org/membership-requests (accept)", () => {
  it("accepts a membership request for an admin", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");
    const clerk = mockClerkMembershipAction(
      "accept",
      orgId,
      "req_test123",
      200,
    );

    const response = await accept(
      apiClient().accept({
        headers: authHeaders(),
        body: { requestId: "req_test123" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      message: "Membership request accepted",
    });
    expect(clerk.callCount()).toBe(1);
  });

  it("returns 400 when Clerk API rejects the accept request", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");
    mockClerkMembershipAction("accept", orgId, "req_invalid", 404);

    const response = await accept(
      apiClient().accept({
        headers: authHeaders(),
        body: { requestId: "req_invalid" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Invalid request", code: "BAD_REQUEST" },
    });
  });

  it("returns 403 when caller is not an admin", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:member");
    const clerk = mockClerkMembershipAction(
      "accept",
      orgId,
      "req_test123",
      200,
    );

    const response = await accept(
      apiClient().accept({
        headers: authHeaders(),
        body: { requestId: "req_test123" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Access denied", code: "FORBIDDEN" },
    });
    expect(clerk.callCount()).toBe(0);
  });

  it("rejects invalid bodies before calling Clerk", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");
    const clerk = mockClerkMembershipAction(
      "accept",
      orgId,
      "req_test123",
      200,
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/org/membership-requests", {
      method: "POST",
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(clerk.callCount()).toBe(0);
  });

  it("returns 401 when not authenticated", async () => {
    const response = await accept(
      apiClient().accept({
        headers: {},
        body: { requestId: "req_test123" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when authenticated session has no active organization", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);

    const response = await accept(
      apiClient().accept({
        headers: authHeaders(),
        body: { requestId: "req_test123" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});

describe("DELETE /api/zero/org/membership-requests (reject)", () => {
  it("rejects a membership request for an admin", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");
    const clerk = mockClerkMembershipAction(
      "reject",
      orgId,
      "req_test456",
      200,
    );

    const response = await accept(
      apiClient().reject({
        headers: authHeaders(),
        body: { requestId: "req_test456" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      message: "Membership request rejected",
    });
    expect(clerk.callCount()).toBe(1);
  });

  it("returns 400 when Clerk API rejects the reject request", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");
    mockClerkMembershipAction("reject", orgId, "req_invalid", 404);

    const response = await accept(
      apiClient().reject({
        headers: authHeaders(),
        body: { requestId: "req_invalid" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Invalid request", code: "BAD_REQUEST" },
    });
  });

  it("returns 403 when caller is not an admin", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:member");
    const clerk = mockClerkMembershipAction(
      "reject",
      orgId,
      "req_test456",
      200,
    );

    const response = await accept(
      apiClient().reject({
        headers: authHeaders(),
        body: { requestId: "req_test456" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Access denied", code: "FORBIDDEN" },
    });
    expect(clerk.callCount()).toBe(0);
  });

  it("rejects invalid bodies before calling Clerk", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");
    const clerk = mockClerkMembershipAction(
      "reject",
      orgId,
      "req_test456",
      200,
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/org/membership-requests", {
      method: "DELETE",
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(clerk.callCount()).toBe(0);
  });

  it("returns 401 when not authenticated", async () => {
    const response = await accept(
      apiClient().reject({
        headers: {},
        body: { requestId: "req_test456" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when authenticated session has no active organization", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);

    const response = await accept(
      apiClient().reject({
        headers: authHeaders(),
        body: { requestId: "req_test456" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});
