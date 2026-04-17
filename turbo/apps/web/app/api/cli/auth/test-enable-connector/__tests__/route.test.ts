import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import { DEFAULT_TEST_EMAIL } from "../../../../../../src/lib/auth/test-user";
import {
  createTestRequest,
  insertOrgCacheEntry,
  ensureOrgRow,
} from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { reloadEnv } from "../../../../../../src/env";
import { seedTestCompose } from "../../../../../../src/__tests__/db-test-seeders/agents";
import { insertOrgMembersCacheEntry } from "../../../../../../src/__tests__/db-test-seeders/org-members-cache";
import { setOrgCredits } from "../../../../../../src/__tests__/db-test-seeders/org";
import { findUserConnectorTypes } from "../../../../../../src/__tests__/db-test-assertions/connectors";

// Mock Clerk Backend API — resolveTestUserId is the only Clerk touch this
// route makes directly, but src/__tests__/clerk-mock.ts (imported via
// testContext) calls `vi.mocked(auth)`, so the `auth` stub must remain
// even though this test doesn't exercise it.
const mockGetUserList = vi.fn();
vi.mock("@clerk/nextjs/server", () => {
  return {
    clerkClient: vi.fn(async () => {
      return {
        users: { getUserList: mockGetUserList },
      };
    }),
    auth: vi.fn(async () => {
      return { userId: null, orgId: null, orgRole: null };
    }),
  };
});

const context = testContext();

const TEST_USER_ID = "user_enable_connector";
const TEST_ORG_ID = "org_enable_connector";
// Push cache entries far enough out that org_members_cache / org_cache TTLs
// never expire mid-test and fall back to Clerk (which is mocked).
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

describe("/api/cli/auth/test-enable-connector", () => {
  beforeEach(async () => {
    context.setupMocks();
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CLERK_SECRET_KEY", "test-secret-key");
    reloadEnv();

    mockGetUserList.mockResolvedValue({ data: [{ id: TEST_USER_ID }] });

    await insertOrgCacheEntry({ orgId: TEST_ORG_ID, slug: "enable-conn-org" });
    await ensureOrgRow(TEST_ORG_ID);

    // Seed the lookup caches test-token normally populates so the route's
    // resolveTestUserOrg() resolves to this test's org.
    await insertOrgMembersCacheEntry({
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      role: "admin",
      cachedAt: new Date(Date.now() + ONE_YEAR_MS),
    });
    // `setOrgCredits` upserts into org_metadata — we only care that the
    // row exists so `getOrgMetadata()` inside the route doesn't 404.
    await setOrgCredits(TEST_ORG_ID, 100_000);
  });

  it("returns 404 in production", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    reloadEnv();
    const response = await POST(
      createTestRequest(
        "http://localhost:3000/api/cli/auth/test-enable-connector",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            composeId: "00000000-0000-0000-0000-000000000000",
            connectorTypes: ["github"],
          }),
        },
      ),
    );
    expect(response.status).toBe(404);
  });

  it("rejects unknown connector types", async () => {
    const { composeId } = await seedTestCompose({
      userId: TEST_USER_ID,
      orgId: TEST_ORG_ID,
      name: `compose-unknown-${Date.now()}`,
    });
    const response = await POST(
      createTestRequest(
        "http://localhost:3000/api/cli/auth/test-enable-connector",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            composeId,
            connectorTypes: ["not-a-real-connector"],
          }),
        },
      ),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Unknown connector types");
  });

  it("rejects requests for a compose that does not exist", async () => {
    const response = await POST(
      createTestRequest(
        "http://localhost:3000/api/cli/auth/test-enable-connector",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            composeId: "00000000-0000-0000-0000-000000000000",
            connectorTypes: ["github"],
          }),
        },
      ),
    );
    expect(response.status).toBe(404);
  });

  it("writes user_connectors rows for each requested connector", async () => {
    const { composeId } = await seedTestCompose({
      userId: TEST_USER_ID,
      orgId: TEST_ORG_ID,
      name: `compose-ok-${Date.now()}`,
    });

    const response = await POST(
      createTestRequest(
        `http://localhost:3000/api/cli/auth/test-enable-connector?email=${encodeURIComponent(
          DEFAULT_TEST_EMAIL,
        )}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            composeId,
            connectorTypes: ["github", "slack"],
          }),
        },
      ),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.composeId).toBe(composeId);
    expect(body.connectorTypes).toEqual(["github", "slack"]);

    const types = await findUserConnectorTypes(TEST_USER_ID, composeId);
    expect(types.sort()).toEqual(["github", "slack"].sort());
  });
});
