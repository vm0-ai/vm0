import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { HttpResponse } from "msw";
import { linkIMessageAction } from "../actions";
import { testContext, uniqueId } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";
import { ensureOrgRow } from "../../../../src/__tests__/api-test-helpers";
import { server } from "../../../../src/mocks/server";
import { http } from "../../../../src/__tests__/msw";
import { env } from "../../../../src/env";

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

describe("linkIMessageAction", () => {
  beforeEach(() => {
    context.setupMocks();
    server.use(agentphoneSendMessage);
  });

  it("returns error when not authenticated", async () => {
    mockClerk({ userId: null });

    const handle = uniqueHandle();
    const orgId = uniqueId("org");
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signConnectParams(handle, orgId, timestamp);

    const result = await linkIMessageAction(
      handle,
      orgId,
      timestamp,
      signature,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Not authenticated");
  });

  it("returns error for an invalid connect signature", async () => {
    const user = await context.setupUser();
    const handle = uniqueHandle();

    const result = await linkIMessageAction(
      handle,
      user.orgId,
      Math.floor(Date.now() / 1000),
      "a".repeat(64),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid or expired/i);
  });

  it("returns error for an expired connect timestamp", async () => {
    const user = await context.setupUser();
    const handle = uniqueHandle();
    // 15 minutes in the past — beyond the 10-minute MAX_CONNECT_AGE_SECONDS window
    const timestamp = Math.floor(Date.now() / 1000) - 900;
    const signature = signConnectParams(handle, user.orgId, timestamp);

    const result = await linkIMessageAction(
      handle,
      user.orgId,
      timestamp,
      signature,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid or expired/i);
  });

  it("returns error when user is not a member of the requested org", async () => {
    await context.setupUser();
    const handle = uniqueHandle();

    // Use an org the Clerk mock does not include in the user's memberships
    const unrelatedOrgId = uniqueId("unrelated-org");
    await ensureOrgRow(unrelatedOrgId);

    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signConnectParams(handle, unrelatedOrgId, timestamp);

    const result = await linkIMessageAction(
      handle,
      unrelatedOrgId,
      timestamp,
      signature,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not a member/i);
  });

  it("links handle and returns success: true for a valid signed request", async () => {
    const user = await context.setupUser();
    const handle = uniqueHandle();
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signConnectParams(handle, user.orgId, timestamp);

    const result = await linkIMessageAction(
      handle,
      user.orgId,
      timestamp,
      signature,
    );

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("returns error when handle is already bound to a different org", async () => {
    const user = await context.setupUser();
    const handle = uniqueHandle();

    // First: link the handle to user's org
    const ts1 = Math.floor(Date.now() / 1000);
    const sig1 = signConnectParams(handle, user.orgId, ts1);
    const first = await linkIMessageAction(handle, user.orgId, ts1, sig1);
    expect(first.success).toBe(true);

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
    const result = await linkIMessageAction(handle, otherOrgId, ts2, sig2);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already linked to another organization/i);
  });

  it("allows re-linking the same handle to the same org (idempotent upsert)", async () => {
    const user = await context.setupUser();
    const handle = uniqueHandle();

    // Link once
    const ts1 = Math.floor(Date.now() / 1000);
    const sig1 = signConnectParams(handle, user.orgId, ts1);
    await linkIMessageAction(handle, user.orgId, ts1, sig1);

    // Link again with a fresh token (same handle, same org)
    const ts2 = Math.floor(Date.now() / 1000);
    const sig2 = signConnectParams(handle, user.orgId, ts2);
    const result = await linkIMessageAction(handle, user.orgId, ts2, sig2);

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });
});
