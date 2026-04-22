import { describe, it, expect, beforeEach } from "vitest";
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

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("zpl");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function enableUrl(type: string): string {
  return `http://localhost:3000/api/zero/platform-connectors/${type}`;
}

// With no connector currently declaring `platform` auth the success path is
// unreachable (validated upstream by `connectorTypeSchema`). These tests
// cover the two branches that stay exercisable: auth rejection and the
// "type doesn't support platform enable" rejection. Expand to cover 200
// again when the next platform connector lands.
describe("POST /api/zero/platform-connectors/:type", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await POST(
      createTestRequest(enableUrl("test-oauth"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects types that don't declare a platform auth method", async () => {
    // `test-oauth` is the internal synthetic OAuth connector — it passes
    // `connectorTypeSchema` (so the request reaches the handler) and will
    // never grow a `platform` auth method by contract, so the 400 branch
    // is stable under future contract changes.
    const userId = uniqueId("zpl-np");
    await setupOrg(userId);

    const response = await POST(
      createTestRequest(enableUrl("test-oauth"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(400);
  });
});
