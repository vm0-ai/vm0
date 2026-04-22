import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestOrg,
  countPlatformConnectorRows,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

const context = testContext();

// `STAFF_ORG_ID_HASHES` contains the hash of this orgId (see
// `packages/core/src/identity-hash.ts`), so a user mocked into this org
// satisfies the `PlatformConnectors` feature switch without any override.
const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";

async function setupNonStaffOrg(userId: string) {
  const slug = uniqueId("zpl");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

async function setupStaffOrg(userId: string) {
  const slug = uniqueId("zpl-staff");
  mockClerk({ userId, orgId: STAFF_ORG_ID, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId: STAFF_ORG_ID };
}

function enableUrl(type: string): string {
  return `http://localhost:3000/api/zero/platform-connectors/${type}`;
}

function enablePost(type: string) {
  return POST(
    createTestRequest(enableUrl(type), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
}

describe("POST /api/zero/platform-connectors/:type", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await enablePost("openai");
    expect(response.status).toBe(401);
  });

  it("returns 404 when PlatformConnectors flag is off for this org", async () => {
    // Non-staff org → flag is off → endpoint 404s as if it doesn't exist.
    // Matches the UI, which also hides the Enable button for these users.
    const userId = uniqueId("zpl-nostaff");
    await setupNonStaffOrg(userId);

    const response = await enablePost("openai");
    expect(response.status).toBe(404);
  });

  it("rejects types that don't declare a platform auth method (staff)", async () => {
    // `test-oauth` is the internal synthetic OAuth connector — it passes
    // `connectorTypeSchema` (so the request reaches the handler) and will
    // never grow a `platform` auth method by contract, so the 400 branch
    // is stable under future contract changes.
    const userId = uniqueId("zpl-np");
    await setupStaffOrg(userId);

    const response = await enablePost("test-oauth");
    expect(response.status).toBe(400);
  });

  it("enables openai for a staff user and persists a platform row", async () => {
    const userId = uniqueId("zpl-ok");
    const { orgId } = await setupStaffOrg(userId);

    const response = await enablePost("openai");
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.type).toBe("openai");
    expect(body.authMethod).toBe("platform");

    expect(await countPlatformConnectorRows(orgId, userId, "openai")).toBe(1);
  });

  it("is idempotent — repeat POSTs yield one row", async () => {
    const userId = uniqueId("zpl-idem");
    const { orgId } = await setupStaffOrg(userId);

    const first = await enablePost("openai");
    expect(first.status).toBe(200);
    const second = await enablePost("openai");
    expect(second.status).toBe(200);

    expect(await countPlatformConnectorRows(orgId, userId, "openai")).toBe(1);
  });
});
