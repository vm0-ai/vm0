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

/** Generate a fresh, unique test code in VM0-XXXX-XXXX shape. */
function uniqueCode(tag: string): string {
  const suffix = uniqueId(tag)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8)
    .padEnd(8, "X");
  return `VM0-${suffix.slice(0, 4)}-${suffix.slice(4, 8)}`;
}

describe("POST /api/zero/redemption-codes/redeem", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });
    const response = await POST(createRedeemRequest({ code: "VM0-AAAA-BBBB" }));
    expect(response.status).toBe(401);
  });

  it("returns 400 for a code missing the VM0- prefix", async () => {
    await setupUserAndOrg();
    const response = await POST(createRedeemRequest({ code: "ABCD-EFGH" }));
    expect(response.status).toBe(400);
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

  it("rate-limits after too many failed attempts (429)", async () => {
    await setupUserAndOrg();

    // 10 distinct invalid codes — each one hits the UPDATE path and fails,
    // each failure is recorded in redemption_code_attempts.
    for (let i = 0; i < 10; i++) {
      const response = await POST(
        createRedeemRequest({ code: uniqueCode(`rl-${String(i)}`) }),
      );
      expect(response.status).toBe(400);
    }

    const throttled = await POST(
      createRedeemRequest({ code: uniqueCode("rl-throttle") }),
    );
    expect(throttled.status).toBe(429);
  });

  it("bad-prefix codes do not consume rate-limit budget", async () => {
    const { orgId } = await setupUserAndOrg();
    await setOrgCredits(orgId, 0);

    // 20 bad-prefix attempts — these are rejected before rate-limit check.
    for (let i = 0; i < 20; i++) {
      const response = await POST(createRedeemRequest({ code: "BAD-CODE" }));
      expect(response.status).toBe(400);
    }

    // A fresh valid code should still redeem (no throttle): if bad-prefix
    // attempts had been counted, we'd already be locked out at 11.
    const code = uniqueCode("pbp");
    await seedRedemptionCode({ code, creditsPerCode: 250 });
    const valid = await POST(createRedeemRequest({ code }));
    expect(valid.status).toBe(200);
  });
});
