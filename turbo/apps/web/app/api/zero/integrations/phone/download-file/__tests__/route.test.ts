import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { GET } from "../route";
import {
  createTestRequest,
  insertOrgMembersCacheEntry,
  insertTestAgentPhoneMessage,
  insertTestAgentPhoneUserLink,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  uniqueNumericId,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { generateZeroToken } from "../../../../../../../src/lib/auth/sandbox-token";
import { server } from "../../../../../../../src/mocks/server";

const URL = "http://localhost:3000/api/zero/integrations/phone/download-file";

const context = testContext();

function uniquePhone(): string {
  return `+1555${uniqueNumericId().slice(0, 7)}`;
}

describe("GET /api/zero/integrations/phone/download-file", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  async function authedRequest(fileId: string): Promise<Request> {
    mockClerk({ userId: null });
    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
      role: "admin",
    });
    const token = await generateZeroToken(user.userId, "run-1", user.orgId);
    return createTestRequest(`${URL}?file_id=${fileId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  it("returns 401 when no auth token is provided", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(`${URL}?file_id=apmsg-file`, {
      method: "GET",
    });
    const response = await GET(request as never);

    expect(response.status).toBe(401);
  });

  it("streams AgentPhone media bytes for the linked user", async () => {
    const phone = uniquePhone();
    const fileId = uniqueId("apmsg-file");
    const link = await insertTestAgentPhoneUserLink({
      phoneHandle: phone,
      vm0UserId: user.userId,
      orgId: user.orgId,
    });
    await insertTestAgentPhoneMessage({
      agentphoneMessageId: fileId,
      agentphoneUserLinkId: link.id,
      phoneHandle: phone,
      fromNumber: phone,
      toNumber: "+19039853128",
      direction: "inbound",
      mediaUrl: "https://cdn.agentphone.test/files/photo.jpg",
    });

    const fileBytes = Buffer.from("agentphone image bytes");
    server.use(
      http.get("https://cdn.agentphone.test/files/photo.jpg", () => {
        return new HttpResponse(fileBytes, {
          status: 200,
          headers: {
            "content-type": "image/jpeg",
            "content-length": String(fileBytes.length),
          },
        });
      }),
    );

    const request = await authedRequest(fileId);
    const response = await GET(request as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("x-file-name")).toBe("photo.jpg");

    const receivedBytes = Buffer.from(await response.arrayBuffer());
    expect(receivedBytes.equals(fileBytes)).toBe(true);
  });

  it("returns 404 when the media message is not linked to the user", async () => {
    const request = await authedRequest("missing-agentphone-file");
    const response = await GET(request as never);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });
});
