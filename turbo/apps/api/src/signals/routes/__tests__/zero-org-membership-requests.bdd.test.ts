import { randomUUID } from "node:crypto";

import { http, HttpResponse } from "msw";
import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { zeroOrgMembershipRequestsContract } from "@vm0/api-contracts/contracts/zero-org-members";

// BDD migration of the legacy
// `zero-org-membership-requests.test.ts`. The 12 legacy
// `it()`s collapse into 2 BDD `it()`s: (1) POST accept chain
// (200 admin accepts a request + Clerk API called once → 400
// Clerk API rejects → 403 non-admin → 400 invalid body via raw
// app → 401 unauth → 401 no-org), (2) DELETE reject chain
// (200 admin rejects a request + Clerk API called once → 400
// Clerk API rejects → 403 non-admin → 400 invalid body via raw
// app → 401 unauth → 401 no-org).
//
// Service-Level Exception: each step asserts whether the
// upstream Clerk API was called via MSW handlers (Clerk is
// a mocked external service per the BDD plan). The 400
// invalid-body cases use the raw public app because the
// ts-rest client validates the body client-side and never
// reaches the route.

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

describe("BDD POST /api/zero/org/membership-requests (accept) — full chain", () => {
  it("gwt-wt-wt: 200 admin accepts + Clerk API called once → 400 Clerk API rejects → 403 non-admin → 400 invalid body via raw app → 401 unauth → 401 no-org", async () => {
    // Given: an admin session + a Clerk API mock that
    // succeeds.
    const acceptUserId = `user_${randomUUID()}`;
    const acceptOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(acceptUserId, acceptOrgId, "org:admin");
    const clerk = mockClerkMembershipAction(
      "accept",
      acceptOrgId,
      "req_test123",
      200,
    );

    // When: admin accepts a request.
    const accepted = await accept(
      apiClient().accept({
        headers: authHeaders(),
        body: { requestId: "req_test123" },
      }),
      [200],
    );

    // Then: 200 + Clerk API was called once.
    expect(accepted.body).toStrictEqual({
      message: "Membership request accepted",
    });
    expect(clerk.callCount()).toBe(1);

    // Given: a fresh admin session + a Clerk API mock that
    // returns 404.
    const invalidUserId = `user_${randomUUID()}`;
    const invalidOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(invalidUserId, invalidOrgId, "org:admin");
    mockClerkMembershipAction("accept", invalidOrgId, "req_invalid", 404);

    // When + Then: 400 — Clerk rejects the request.
    const rejected = await accept(
      apiClient().accept({
        headers: authHeaders(),
        body: { requestId: "req_invalid" },
      }),
      [400],
    );
    expect(rejected.body).toStrictEqual({
      error: { message: "Invalid request", code: "BAD_REQUEST" },
    });

    // Given: a non-admin session.
    const memberUserId = `user_${randomUUID()}`;
    const memberOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(memberUserId, memberOrgId, "org:member");
    const nonAdminClerk = mockClerkMembershipAction(
      "accept",
      memberOrgId,
      "req_test123",
      200,
    );

    // When + Then: 403 — non-admin cannot accept; Clerk is
    // not called.
    const nonAdmin = await accept(
      apiClient().accept({
        headers: authHeaders(),
        body: { requestId: "req_test123" },
      }),
      [403],
    );
    expect(nonAdmin.body).toStrictEqual({
      error: { message: "Access denied", code: "FORBIDDEN" },
    });
    expect(nonAdminClerk.callCount()).toBe(0);

    // Given: an admin session + a Clerk API mock.
    const badBodyUserId = `user_${randomUUID()}`;
    const badBodyOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(badBodyUserId, badBodyOrgId, "org:admin");
    const badBodyClerk = mockClerkMembershipAction(
      "accept",
      badBodyOrgId,
      "req_test123",
      200,
    );

    // When + Then: 400 on an empty body via raw app; Clerk
    // is not called.
    const app = createApp({ signal: context.signal });
    const badBodyResponse = await app.request(
      "/api/zero/org/membership-requests",
      {
        method: "POST",
        headers: {
          authorization: "Bearer clerk-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );
    expect(badBodyResponse.status).toBe(400);
    await expect(badBodyResponse.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(badBodyClerk.callCount()).toBe(0);

    // When + Then: 401 with no auth header.
    const noAuth = await accept(
      apiClient().accept({
        headers: {},
        body: { requestId: "req_test123" },
      }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a session with a user but no org.
    const noOrgUserId = `user_${randomUUID()}`;
    mocks.clerk.session(noOrgUserId, null);

    // When + Then: still 401.
    const noOrg = await accept(
      apiClient().accept({
        headers: authHeaders(),
        body: { requestId: "req_test123" },
      }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});

describe("BDD DELETE /api/zero/org/membership-requests (reject) — full chain", () => {
  it("gwt-wt-wt: 200 admin rejects + Clerk API called once → 400 Clerk API rejects → 403 non-admin → 400 invalid body via raw app → 401 unauth → 401 no-org", async () => {
    // Given: an admin session + a Clerk API mock that
    // succeeds.
    const rejectUserId = `user_${randomUUID()}`;
    const rejectOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(rejectUserId, rejectOrgId, "org:admin");
    const clerk = mockClerkMembershipAction(
      "reject",
      rejectOrgId,
      "req_test456",
      200,
    );

    // When: admin rejects a request.
    const rejected = await accept(
      apiClient().reject({
        headers: authHeaders(),
        body: { requestId: "req_test456" },
      }),
      [200],
    );

    // Then: 200 + Clerk API was called once.
    expect(rejected.body).toStrictEqual({
      message: "Membership request rejected",
    });
    expect(clerk.callCount()).toBe(1);

    // Given: a fresh admin session + a Clerk API mock that
    // returns 404.
    const invalidUserId = `user_${randomUUID()}`;
    const invalidOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(invalidUserId, invalidOrgId, "org:admin");
    mockClerkMembershipAction("reject", invalidOrgId, "req_invalid", 404);

    // When + Then: 400 — Clerk rejects the request.
    const invalid = await accept(
      apiClient().reject({
        headers: authHeaders(),
        body: { requestId: "req_invalid" },
      }),
      [400],
    );
    expect(invalid.body).toStrictEqual({
      error: { message: "Invalid request", code: "BAD_REQUEST" },
    });

    // Given: a non-admin session.
    const memberUserId = `user_${randomUUID()}`;
    const memberOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(memberUserId, memberOrgId, "org:member");
    const nonAdminClerk = mockClerkMembershipAction(
      "reject",
      memberOrgId,
      "req_test456",
      200,
    );

    // When + Then: 403 — non-admin cannot reject; Clerk is
    // not called.
    const nonAdmin = await accept(
      apiClient().reject({
        headers: authHeaders(),
        body: { requestId: "req_test456" },
      }),
      [403],
    );
    expect(nonAdmin.body).toStrictEqual({
      error: { message: "Access denied", code: "FORBIDDEN" },
    });
    expect(nonAdminClerk.callCount()).toBe(0);

    // Given: an admin session + a Clerk API mock.
    const badBodyUserId = `user_${randomUUID()}`;
    const badBodyOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(badBodyUserId, badBodyOrgId, "org:admin");
    const badBodyClerk = mockClerkMembershipAction(
      "reject",
      badBodyOrgId,
      "req_test456",
      200,
    );

    // When + Then: 400 on an empty body via raw app; Clerk
    // is not called.
    const app = createApp({ signal: context.signal });
    const badBodyResponse = await app.request(
      "/api/zero/org/membership-requests",
      {
        method: "DELETE",
        headers: {
          authorization: "Bearer clerk-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );
    expect(badBodyResponse.status).toBe(400);
    await expect(badBodyResponse.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(badBodyClerk.callCount()).toBe(0);

    // When + Then: 401 with no auth header.
    const noAuth = await accept(
      apiClient().reject({
        headers: {},
        body: { requestId: "req_test456" },
      }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a session with a user but no org.
    const noOrgUserId = `user_${randomUUID()}`;
    mocks.clerk.session(noOrgUserId, null);

    // When + Then: still 401.
    const noOrg = await accept(
      apiClient().reject({
        headers: authHeaders(),
        body: { requestId: "req_test456" },
      }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});
