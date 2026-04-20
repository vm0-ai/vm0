import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "../route";
import { seedRedemptionCode } from "../../../../../src/__tests__/db-test-seeders/redemption-codes";
import {
  createTestRequest,
  createTestOrg,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { seedUserFeatureSwitches } from "../../../../../src/__tests__/db-test-seeders/feature-switches";
import { listRedemptionCodesByCreator } from "../../../../../src/__tests__/db-test-assertions/redemption-codes";
import { reloadEnv } from "../../../../../src/env";

/**
 * Known staff org id (hash `afce210e` lives in STAFF_ORG_ID_HASHES).
 * Hardcoded because `isStaffOrg` compares against this exact value's hash.
 */
const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";

const context = testContext();

function mintUrl(): string {
  return "http://localhost:3000/api/zero/redemption-codes";
}

function createMintRequest(body: unknown) {
  return createTestRequest(mintUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function setupNonStaffOrg() {
  const userId = uniqueId("rc-mint");
  mockClerk({ userId, orgRole: "org:admin" });
  await createTestOrg(uniqueId("rc-mint-org"));
  return { userId, orgId: `org_mock_${userId}` };
}

async function setupStaffOrg() {
  const userId = uniqueId("rc-staff");
  mockClerk({ userId, orgId: STAFF_ORG_ID, orgRole: "org:admin" });
  await createTestOrg(uniqueId("rc-staff-org"));
  return { userId, orgId: STAFF_ORG_ID };
}

describe("POST /api/zero/redemption-codes (mint)", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });
    const response = await POST(
      createMintRequest({ creditsPerCode: 100, quantity: 1 }),
    );
    expect(response.status).toBe(401);
  });

  it("returns 403 for a non-staff org", async () => {
    await setupNonStaffOrg();
    const response = await POST(
      createMintRequest({ creditsPerCode: 100, quantity: 1 }),
    );
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error.code).toBe("FORBIDDEN");
  });

  it(
    "returns 403 even if the non-staff user self-enables the feature switch override " +
      "(proves isStaffOrg is the real gate, not isFeatureEnabled)",
    async () => {
      const { userId, orgId } = await setupNonStaffOrg();

      // Simulate the bypass attempt: write `redemptionCodes: true` into the
      // user's feature-switch overrides table, which `POST /api/zero/feature-switches`
      // would have accepted without any key allow-list.
      await seedUserFeatureSwitches(orgId, userId, { redemptionCodes: true });

      const response = await POST(
        createMintRequest({ creditsPerCode: 100, quantity: 1 }),
      );

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error.code).toBe("FORBIDDEN");
    },
  );

  describe("EXTRA_STAFF_USER_IDS env override", () => {
    it("allows minting for a non-staff user whose id is in EXTRA_STAFF_USER_IDS", async () => {
      const { userId } = await setupNonStaffOrg();
      vi.stubEnv("EXTRA_STAFF_USER_IDS", `some-other-user, ${userId} ,another`);
      reloadEnv();

      const response = await POST(
        createMintRequest({ creditsPerCode: 100, quantity: 1 }),
      );

      expect(response.status).toBe(200);
    });

    it("still 403 when the user id is not listed", async () => {
      await setupNonStaffOrg();
      vi.stubEnv("EXTRA_STAFF_USER_IDS", "some-other-user,another");
      reloadEnv();

      const response = await POST(
        createMintRequest({ creditsPerCode: 100, quantity: 1 }),
      );

      expect(response.status).toBe(403);
    });
  });

  it("mints codes for a staff org", async () => {
    const { userId, orgId } = await setupStaffOrg();

    const response = await POST(
      createMintRequest({ creditsPerCode: 2500, quantity: 3 }),
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.codes).toHaveLength(3);
    for (const code of data.codes) {
      // Every minted code must carry the VM0- prefix — the redeem endpoint
      // rejects anything without it before touching the DB.
      expect(code.code).toMatch(
        /^VM0-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/,
      );
      expect(code.creditsPerCode).toBe(2500);
      expect(new Date(code.expiresAt).getTime()).toBeGreaterThan(Date.now());
    }

    const persisted = await listRedemptionCodesByCreator(userId);
    expect(persisted).toHaveLength(3);
    expect(persisted[0]?.createdByOrgId).toBe(orgId);
  });

  it.each([
    { case: "quantity = 0", body: { creditsPerCode: 100, quantity: 0 } },
    { case: "quantity = 101", body: { creditsPerCode: 100, quantity: 101 } },
    { case: "creditsPerCode = 0", body: { creditsPerCode: 0, quantity: 1 } },
    {
      case: "creditsPerCode > max",
      body: { creditsPerCode: 1_000_001, quantity: 1 },
    },
  ])("rejects invalid body: $case", async ({ body }) => {
    await setupStaffOrg();
    const response = await POST(createMintRequest(body));
    expect(response.status).toBe(400);
  });
});

describe("GET /api/zero/redemption-codes (list)", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  function createListRequest() {
    return createTestRequest(mintUrl(), { method: "GET" });
  }

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });
    const response = await GET(createListRequest());
    expect(response.status).toBe(401);
  });

  it("returns 403 for a non-staff org", async () => {
    await setupNonStaffOrg();
    const response = await GET(createListRequest());
    expect(response.status).toBe(403);
  });

  it("lists codes with redemption status for a staff org", async () => {
    await setupStaffOrg();

    // Unique test codes. The list endpoint doesn't validate format, so we can
    // use short unique strings here.
    const outstanding = `VM0-LIST-OUT-${uniqueId("out").slice(-8).toUpperCase()}`;
    const redeemed = `VM0-LIST-RED-${uniqueId("red").slice(-8).toUpperCase()}`;

    await seedRedemptionCode({ code: outstanding, creditsPerCode: 100 });
    await seedRedemptionCode({
      code: redeemed,
      creditsPerCode: 200,
      redeemedByUserId: "user_redeemer",
      redeemedByOrgId: "org_redeemer",
      redeemedAt: new Date(),
    });

    const response = await GET(createListRequest());
    expect(response.status).toBe(200);
    const data = await response.json();

    const outstandingRow = data.codes.find((c: { code: string }) => {
      return c.code === outstanding;
    });
    expect(outstandingRow?.redeemedAt).toBeNull();
    expect(outstandingRow?.creditsPerCode).toBe(100);

    const redeemedRow = data.codes.find((c: { code: string }) => {
      return c.code === redeemed;
    });
    expect(redeemedRow?.redeemedAt).not.toBeNull();
    expect(redeemedRow?.redeemedByUserId).toBe("user_redeemer");
    expect(redeemedRow?.creditsPerCode).toBe(200);
  });

  describe("EXTRA_STAFF_USER_IDS env override", () => {
    it("allows listing for a non-staff user whose id is in EXTRA_STAFF_USER_IDS", async () => {
      const { userId } = await setupNonStaffOrg();
      vi.stubEnv("EXTRA_STAFF_USER_IDS", `some-other-user, ${userId} ,another`);
      reloadEnv();

      const response = await GET(createListRequest());

      expect(response.status).toBe(200);
    });

    it("still 403 when the user id is not listed", async () => {
      await setupNonStaffOrg();
      vi.stubEnv("EXTRA_STAFF_USER_IDS", "some-other-user,another");
      reloadEnv();

      const response = await GET(createListRequest());

      expect(response.status).toBe(403);
    });
  });
});
