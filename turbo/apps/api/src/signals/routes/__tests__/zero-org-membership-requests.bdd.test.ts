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

async function rawMembershipRequest(
  method: "POST" | "DELETE",
  body: object,
): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return await app.request("/api/zero/org/membership-requests", {
    method,
    headers: {
      ...authHeaders(),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/zero/org/membership-requests BDD", () => {
  it("enforces accept boundaries and accepts admin membership requests", async () => {
    const client = apiClient();
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");
    const acceptedClerk = mockClerkMembershipAction(
      "accept",
      orgId,
      "req_test123",
      200,
    );

    const accepted = await accept(
      client.accept({
        headers: authHeaders(),
        body: { requestId: "req_test123" },
      }),
      [200],
    );

    expect(accepted.body).toStrictEqual({
      message: "Membership request accepted",
    });
    expect(acceptedClerk.callCount()).toBe(1);

    const invalidOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(`user_${randomUUID()}`, invalidOrgId, "org:admin");
    mockClerkMembershipAction("accept", invalidOrgId, "req_invalid", 404);
    const rejectedByClerk = await accept(
      client.accept({
        headers: authHeaders(),
        body: { requestId: "req_invalid" },
      }),
      [400],
    );

    expect(rejectedByClerk.body).toStrictEqual({
      error: { message: "Invalid request", code: "BAD_REQUEST" },
    });

    const memberOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(`user_${randomUUID()}`, memberOrgId, "org:member");
    const memberClerk = mockClerkMembershipAction(
      "accept",
      memberOrgId,
      "req_forbidden",
      200,
    );
    const forbidden = await accept(
      client.accept({
        headers: authHeaders(),
        body: { requestId: "req_forbidden" },
      }),
      [403],
    );

    expect(forbidden.body).toStrictEqual({
      error: { message: "Access denied", code: "FORBIDDEN" },
    });
    expect(memberClerk.callCount()).toBe(0);

    const invalidBodyOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(`user_${randomUUID()}`, invalidBodyOrgId, "org:admin");
    const invalidBodyClerk = mockClerkMembershipAction(
      "accept",
      invalidBodyOrgId,
      "req_invalid_body",
      200,
    );
    const invalidBody = await rawMembershipRequest("POST", {});

    expect(invalidBody.status).toBe(400);
    await expect(invalidBody.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(invalidBodyClerk.callCount()).toBe(0);

    const unauthenticated = await accept(
      client.accept({
        headers: {},
        body: { requestId: "req_test123" },
      }),
      [401],
    );

    expect(unauthenticated.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noActiveOrg = await accept(
      client.accept({
        headers: authHeaders(),
        body: { requestId: "req_test123" },
      }),
      [401],
    );

    expect(noActiveOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});

describe("DELETE /api/zero/org/membership-requests BDD", () => {
  it("enforces reject boundaries and rejects admin membership requests", async () => {
    const client = apiClient();
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(`user_${randomUUID()}`, orgId, "org:admin");
    const rejectedClerk = mockClerkMembershipAction(
      "reject",
      orgId,
      "req_test456",
      200,
    );

    const rejected = await accept(
      client.reject({
        headers: authHeaders(),
        body: { requestId: "req_test456" },
      }),
      [200],
    );

    expect(rejected.body).toStrictEqual({
      message: "Membership request rejected",
    });
    expect(rejectedClerk.callCount()).toBe(1);

    const invalidOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(`user_${randomUUID()}`, invalidOrgId, "org:admin");
    mockClerkMembershipAction("reject", invalidOrgId, "req_invalid", 404);
    const rejectedByClerk = await accept(
      client.reject({
        headers: authHeaders(),
        body: { requestId: "req_invalid" },
      }),
      [400],
    );

    expect(rejectedByClerk.body).toStrictEqual({
      error: { message: "Invalid request", code: "BAD_REQUEST" },
    });

    const memberOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(`user_${randomUUID()}`, memberOrgId, "org:member");
    const memberClerk = mockClerkMembershipAction(
      "reject",
      memberOrgId,
      "req_forbidden",
      200,
    );
    const forbidden = await accept(
      client.reject({
        headers: authHeaders(),
        body: { requestId: "req_forbidden" },
      }),
      [403],
    );

    expect(forbidden.body).toStrictEqual({
      error: { message: "Access denied", code: "FORBIDDEN" },
    });
    expect(memberClerk.callCount()).toBe(0);

    const invalidBodyOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(`user_${randomUUID()}`, invalidBodyOrgId, "org:admin");
    const invalidBodyClerk = mockClerkMembershipAction(
      "reject",
      invalidBodyOrgId,
      "req_invalid_body",
      200,
    );
    const invalidBody = await rawMembershipRequest("DELETE", {});

    expect(invalidBody.status).toBe(400);
    await expect(invalidBody.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(invalidBodyClerk.callCount()).toBe(0);

    const unauthenticated = await accept(
      client.reject({
        headers: {},
        body: { requestId: "req_test456" },
      }),
      [401],
    );

    expect(unauthenticated.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noActiveOrg = await accept(
      client.reject({
        headers: authHeaders(),
        body: { requestId: "req_test456" },
      }),
      [401],
    );

    expect(noActiveOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});
