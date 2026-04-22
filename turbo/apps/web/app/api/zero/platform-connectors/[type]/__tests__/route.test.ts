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

  it("rejects types that don't declare a platform auth method", async () => {
    // `test-oauth` is the internal synthetic OAuth connector — it passes
    // `connectorTypeSchema` (so the request reaches the handler) and will
    // never grow a `platform` auth method by contract, so the 400 branch
    // is stable under future contract changes.
    const userId = uniqueId("zpl-np");
    await setupOrg(userId);

    const response = await enablePost("test-oauth");
    expect(response.status).toBe(400);
  });

  it("enables openai and persists a platform row", async () => {
    const userId = uniqueId("zpl-ok");
    const { orgId } = await setupOrg(userId);

    const response = await enablePost("openai");
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.type).toBe("openai");
    expect(body.authMethod).toBe("platform");

    expect(await countPlatformConnectorRows(orgId, userId, "openai")).toBe(1);
  });

  it("is idempotent — repeat POSTs yield one row", async () => {
    const userId = uniqueId("zpl-idem");
    const { orgId } = await setupOrg(userId);

    const first = await enablePost("openai");
    expect(first.status).toBe(200);
    const second = await enablePost("openai");
    expect(second.status).toBe(200);

    expect(await countPlatformConnectorRows(orgId, userId, "openai")).toBe(1);
  });
});
