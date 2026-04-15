import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { HttpResponse } from "msw";
import { POST } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { ensureOrgRow } from "../../../../../../src/__tests__/api-test-helpers";
import { server } from "../../../../../../src/mocks/server";
import { http } from "../../../../../../src/__tests__/msw";
import { env } from "../../../../../../src/env";

vi.mock("@clerk/nextjs/server");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

/**
 * Sign iMessage connect params using the test signing key from env.
 * Mirrors signConnectParams in imessage-connect-token.ts.
 */
function signConnectParams(
  imessageHandle: string,
  orgId: string,
  timestamp: number,
): string {
  const data = `imessage:${imessageHandle}:${orgId}:${timestamp}`;
  return createHmac("sha256", env().SECRETS_ENCRYPTION_KEY)
    .update(data)
    .digest("hex");
}

/**
 * Generate a unique phone-number-like handle for test isolation.
 * Uses a random suffix so DB rows from different runs never collide.
 */
function uniqueHandle(): string {
  return `+1555${uniqueId("").replace(/-/g, "").slice(0, 7)}`;
}

const context = testContext();

// Register MSW handler for AgentPhone send-message endpoint used by sendIMessage()
const { handler: agentphoneSendMessage } = http.post(
  "https://api.agentphone.to/v1/messages",
  () => {
    return HttpResponse.json({ id: "msg_test", status: "sent" });
  },
);

function linkRequest(body: Record<string, unknown>) {
  return new Request("http://localhost:3000/api/integrations/imessage/link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/integrations/imessage/link", () => {
  beforeEach(() => {
    context.setupMocks();
    server.use(agentphoneSendMessage);
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const handle = uniqueHandle();
    const orgId = uniqueId("org");
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signConnectParams(handle, orgId, timestamp);

    const response = await POST(
      linkRequest({ handle, orgId, timestamp, signature }),
    );
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 400 for invalid request body (missing fields)", async () => {
    await context.setupUser();

    const response = await POST(linkRequest({ invalid: "body" }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 for an invalid connect signature", async () => {
    const user = await context.setupUser();
    const handle = uniqueHandle();

    const response = await POST(
      linkRequest({
        handle,
        orgId: user.orgId,
        timestamp: Math.floor(Date.now() / 1000),
        signature: "a".repeat(64),
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 for an expired connect timestamp", async () => {
    const user = await context.setupUser();
    const handle = uniqueHandle();
    // 15 minutes in the past — beyond the 10-minute MAX_CONNECT_AGE_SECONDS window
    const timestamp = Math.floor(Date.now() / 1000) - 900;
    const signature = signConnectParams(handle, user.orgId, timestamp);

    const response = await POST(
      linkRequest({ handle, orgId: user.orgId, timestamp, signature }),
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("returns 403 when user is not a member of the requested org", async () => {
    await context.setupUser();
    const handle = uniqueHandle();

    // Use an org the Clerk mock does not include in the user's memberships
    const unrelatedOrgId = uniqueId("unrelated-org");
    await ensureOrgRow(unrelatedOrgId);

    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signConnectParams(handle, unrelatedOrgId, timestamp);

    const response = await POST(
      linkRequest({ handle, orgId: unrelatedOrgId, timestamp, signature }),
    );
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error.code).toBe("FORBIDDEN");
  });

  it("links handle and returns linked: true for a valid signed request", async () => {
    const user = await context.setupUser();
    const handle = uniqueHandle();
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signConnectParams(handle, user.orgId, timestamp);

    const response = await POST(
      linkRequest({ handle, orgId: user.orgId, timestamp, signature }),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.linked).toBe(true);
  });

  it("returns 409 when handle is already bound to a different org", async () => {
    const user = await context.setupUser();
    const handle = uniqueHandle();

    // First: link the handle to user's org
    const ts1 = Math.floor(Date.now() / 1000);
    const sig1 = signConnectParams(handle, user.orgId, ts1);
    const first = await POST(
      linkRequest({
        handle,
        orgId: user.orgId,
        timestamp: ts1,
        signature: sig1,
      }),
    );
    expect(first.status).toBe(200);

    // Second: a different user tries to link the same handle to a different org
    const otherUserId = uniqueId("other-user");
    const otherOrgId = uniqueId("other-org");
    await ensureOrgRow(otherOrgId);
    mockClerk({
      userId: otherUserId,
      clerkOrgs: [
        { id: otherOrgId, slug: `org-${otherUserId}`, name: otherOrgId },
      ],
    });

    const ts2 = Math.floor(Date.now() / 1000);
    const sig2 = signConnectParams(handle, otherOrgId, ts2);
    const response = await POST(
      linkRequest({
        handle,
        orgId: otherOrgId,
        timestamp: ts2,
        signature: sig2,
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(409);
    expect(data.error.code).toBe("CONFLICT");
  });

  it("allows re-linking the same handle to the same org (idempotent upsert)", async () => {
    const user = await context.setupUser();
    const handle = uniqueHandle();

    // Link once
    const ts1 = Math.floor(Date.now() / 1000);
    const sig1 = signConnectParams(handle, user.orgId, ts1);
    await POST(
      linkRequest({
        handle,
        orgId: user.orgId,
        timestamp: ts1,
        signature: sig1,
      }),
    );

    // Link again with a fresh token (same handle, same org)
    const ts2 = Math.floor(Date.now() / 1000);
    const sig2 = signConnectParams(handle, user.orgId, ts2);
    const response = await POST(
      linkRequest({
        handle,
        orgId: user.orgId,
        timestamp: ts2,
        signature: sig2,
      }),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.linked).toBe(true);
  });
});
