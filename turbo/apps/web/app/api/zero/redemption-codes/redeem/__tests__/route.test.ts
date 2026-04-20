import { beforeEach, describe, expect, it } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestOrg,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { setOrgCredits } from "../../../../../../src/__tests__/api-test-helpers/org";
import { getOrgCredits } from "../../../../../../src/__tests__/db-test-assertions/org";
import { seedRedemptionCode } from "../../../../../../src/__tests__/db-test-seeders/redemption-codes";
import {
  getRedemptionCode,
  getRedemptionExpiresRecord,
} from "../../../../../../src/__tests__/db-test-assertions/redemption-codes";

const context = testContext();

function redeemUrl(): string {
  return "http://localhost:3000/api/zero/redemption-codes/redeem";
}

function createRedeemRequest(body: unknown) {
  return createTestRequest(redeemUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function setupUserAndOrg() {
  const userId = uniqueId("rc-redeem");
  mockClerk({ userId, orgRole: "org:admin" });
  await createTestOrg(uniqueId("rc-redeem-org"));
  return { userId, orgId: `org_mock_${userId}` };
}

/** Generate a fresh, unique test code in XXXX-XXXX shape. */
function uniqueCode(tag: string): string {
  const suffix = uniqueId(tag)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8)
    .padEnd(8, "X");
  return `${suffix.slice(0, 4)}-${suffix.slice(4, 8)}`;
}

describe("POST /api/zero/redemption-codes/redeem", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });
    const response = await POST(createRedeemRequest({ code: "AAAA-BBBB" }));
    expect(response.status).toBe(401);
  });

  it("returns 400 for an unknown code", async () => {
    await setupUserAndOrg();
    const response = await POST(
      createRedeemRequest({ code: uniqueCode("nope") }),
    );
    expect(response.status).toBe(400);
  });

  it("redeems a valid code and credits the org", async () => {
    const { userId, orgId } = await setupUserAndOrg();
    await setOrgCredits(orgId, 1_000);
    const code = uniqueCode("ok");
    await seedRedemptionCode({ code, creditsPerCode: 5_000 });

    const response = await POST(createRedeemRequest({ code }));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.credits).toBe(5_000);
    expect(data.newBalance).toBe(6_000);

    const row = await getRedemptionCode(code);
    expect(row?.redeemedAt).toBeInstanceOf(Date);
    expect(row?.redeemedByOrgId).toBe(orgId);
    expect(row?.redeemedByUserId).toBe(userId);

    const expires = await getRedemptionExpiresRecord(orgId, code);
    expect(expires?.source).toBe("redemption");
    expect(expires?.amount).toBe(5_000);
    expect(expires?.remaining).toBe(5_000);
  });

  it("rejects the second redeem attempt for the same code (400)", async () => {
    const { orgId } = await setupUserAndOrg();
    await setOrgCredits(orgId, 0);
    const code = uniqueCode("dup");
    await seedRedemptionCode({ code, creditsPerCode: 1_000 });

    const first = await POST(createRedeemRequest({ code }));
    expect(first.status).toBe(200);

    const second = await POST(createRedeemRequest({ code }));
    expect(second.status).toBe(400);

    const balance = await getOrgCredits(orgId);
    expect(balance).toBe(1_000); // still only one grant
  });

  it("rejects an expired code (400)", async () => {
    await setupUserAndOrg();
    const code = uniqueCode("exp");
    await seedRedemptionCode({
      code,
      creditsPerCode: 500,
      expiresAt: new Date(Date.now() - 1_000),
    });

    const response = await POST(createRedeemRequest({ code }));
    expect(response.status).toBe(400);
  });

  it("normalizes the submitted code (trim + uppercase)", async () => {
    await setupUserAndOrg();
    const code = uniqueCode("norm");
    await seedRedemptionCode({ code, creditsPerCode: 100 });

    const response = await POST(
      createRedeemRequest({ code: `  ${code.toLowerCase()}  ` }),
    );
    expect(response.status).toBe(200);
  });
});
