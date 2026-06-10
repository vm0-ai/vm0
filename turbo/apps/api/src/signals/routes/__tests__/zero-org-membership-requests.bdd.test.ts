import { randomUUID } from "node:crypto";

import { http, HttpResponse } from "msw";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for accepting/rejecting org membership requests. Clerk
// owns the request lifecycle and is reached over HTTP, so the Clerk REST
// endpoint is mocked with MSW (real-infrastructure HTTP mocking) and its hit
// count is the external observable; the message/error come from the real API
// response. See `api.bdd.md` (CHAIN-ORG-MEMBERSHIP-REQUESTS).
const context = testContext();

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
        calls += 1;
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

describe("org membership requests (API-first BDD)", () => {
  it("accepts and rejects requests for an admin", async () => {
    const api = createBddApi(context);
    const admin = api.actAsAdmin();

    const acceptClerk = mockClerkMembershipAction(
      "accept",
      admin.orgId,
      "req_accept",
      200,
    );
    const accepted = await accept(
      api.membershipRequests.accept({
        headers: SESSION_AUTH,
        body: { requestId: "req_accept" },
      }),
      [200],
    );
    expect(accepted.body).toStrictEqual({
      message: "Membership request accepted",
    });
    expect(acceptClerk.callCount()).toBe(1);

    const rejectClerk = mockClerkMembershipAction(
      "reject",
      admin.orgId,
      "req_reject",
      200,
    );
    const rejected = await accept(
      api.membershipRequests.reject({
        headers: SESSION_AUTH,
        body: { requestId: "req_reject" },
      }),
      [200],
    );
    expect(rejected.body).toStrictEqual({
      message: "Membership request rejected",
    });
    expect(rejectClerk.callCount()).toBe(1);
  });

  it("surfaces a Clerk failure as a bad request", async () => {
    const api = createBddApi(context);
    const admin = api.actAsAdmin();

    mockClerkMembershipAction("accept", admin.orgId, "req_invalid", 404);
    const acceptFailure = await accept(
      api.membershipRequests.accept({
        headers: SESSION_AUTH,
        body: { requestId: "req_invalid" },
      }),
      [400],
    );
    expect(acceptFailure.body).toStrictEqual({
      error: { message: "Invalid request", code: "BAD_REQUEST" },
    });

    mockClerkMembershipAction("reject", admin.orgId, "req_invalid2", 404);
    const rejectFailure = await accept(
      api.membershipRequests.reject({
        headers: SESSION_AUTH,
        body: { requestId: "req_invalid2" },
      }),
      [400],
    );
    expect(rejectFailure.body).toStrictEqual({
      error: { message: "Invalid request", code: "BAD_REQUEST" },
    });
  });

  it("enforces admin-only access, authentication, org, and validation", async () => {
    const api = createBddApi(context);
    const orgId = `org_${randomUUID()}`;

    // A non-admin member cannot accept or reject, and Clerk is never reached.
    api.actAsMember({ userId: `user_${randomUUID()}`, orgId });
    const acceptClerk = mockClerkMembershipAction(
      "accept",
      orgId,
      "req_test",
      200,
    );
    const rejectClerk = mockClerkMembershipAction(
      "reject",
      orgId,
      "req_test",
      200,
    );
    await accept(
      api.membershipRequests.accept({
        headers: SESSION_AUTH,
        body: { requestId: "req_test" },
      }),
      [403],
    );
    await accept(
      api.membershipRequests.reject({
        headers: SESSION_AUTH,
        body: { requestId: "req_test" },
      }),
      [403],
    );

    // Unauthenticated requests are rejected.
    await accept(
      api.membershipRequests.accept({
        headers: {},
        body: { requestId: "req_test" },
      }),
      [401],
    );
    await accept(
      api.membershipRequests.reject({
        headers: {},
        body: { requestId: "req_test" },
      }),
      [401],
    );

    // A session with no active organization is rejected.
    api.actAsNoOrg();
    await accept(
      api.membershipRequests.accept({
        headers: SESSION_AUTH,
        body: { requestId: "req_test" },
      }),
      [401],
    );
    await accept(
      api.membershipRequests.reject({
        headers: SESSION_AUTH,
        body: { requestId: "req_test" },
      }),
      [401],
    );

    // Admin requests with invalid bodies are bad requests before Clerk is hit.
    api.actAsAdmin({ orgId });
    const badAccept = await accept(
      api.membershipRequests.accept({
        headers: SESSION_AUTH,
        body: {} as { requestId: string },
      }),
      [400],
    );
    expect(badAccept.body.error.code).toBe("BAD_REQUEST");
    const badReject = await accept(
      api.membershipRequests.reject({
        headers: SESSION_AUTH,
        body: {} as { requestId: string },
      }),
      [400],
    );
    expect(badReject.body.error.code).toBe("BAD_REQUEST");

    expect(acceptClerk.callCount()).toBe(0);
    expect(rejectClerk.callCount()).toBe(0);
  });
});
