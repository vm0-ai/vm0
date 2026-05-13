import { describe, it, expect, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import { POST } from "../route";
import {
  createTestRequest,
  insertOrgMembersCacheEntry,
} from "../../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../../src/__tests__/clerk-mock";
import { generateZeroToken } from "../../../../../../../../src/lib/auth/sandbox-token";

const URL =
  "http://localhost:3000/api/zero/integrations/phone/upload-file/init";

const context = testContext();

describe("POST /api/zero/integrations/phone/upload-file/init", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  async function zeroToken(): Promise<string> {
    mockClerk({ userId: null });
    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
      role: "admin",
    });
    return generateZeroToken(user.userId, "run-1", user.orgId);
  }

  function initRequest(body: unknown, token?: string): NextRequest {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (token) headers.authorization = `Bearer ${token}`;
    return createTestRequest(URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  it("returns 401 without authentication", async () => {
    mockClerk({ userId: null });

    const response = await POST(
      initRequest({
        filename: "photo.jpg",
        contentType: "image/jpeg",
        length: 100,
      }),
    );

    expect(response.status).toBe(401);
  });

  it("returns a presigned upload URL and final AgentPhone file URL", async () => {
    const token = await zeroToken();

    const response = await POST(
      initRequest(
        {
          filename: "daily photo.jpg",
          contentType: "image/jpeg",
          length: 1234,
        },
        token,
      ),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      filename: "daily_photo.jpg",
      contentType: "image/jpeg",
      size: 1234,
    });
    expect(body.uploadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.uploadUrl).toBeTypeOf("string");
    expect(body.fileUrl).toContain(
      `/f/${encodeURIComponent(user.userId.replace(/^user_/, ""))}/${body.uploadId}/daily_photo.jpg`,
    );

    const putCall = context.mocks.s3.generatePresignedPutUrl.mock.calls[0];
    expect(putCall?.[1]).toBe(
      `uploads/${user.userId}/${body.uploadId}/daily_photo.jpg`,
    );
    expect(putCall?.[2]).toBe("image/jpeg");
  });
});
