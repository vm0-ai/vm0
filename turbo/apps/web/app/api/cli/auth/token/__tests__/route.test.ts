import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestDeviceCode,
  findTestDeviceCode,
  findTestCliToken,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

function makeTokenRequest(deviceCode: string) {
  return createTestRequest("http://localhost:3000/api/cli/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_code: deviceCode }),
  });
}

describe("POST /api/cli/auth/token", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("should return 400 when device code does not exist", async () => {
    const response = await POST(makeTokenRequest("ZZZZ-ZZZZ"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toBe("Invalid device code");
  });

  it("should return 400 when device code is expired", async () => {
    const code = await createTestDeviceCode({
      status: "pending",
      expiresAt: new Date(Date.now() - 1000),
    });

    const response = await POST(makeTokenRequest(code));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("expired_token");
    expect(body.error_description).toBe("The device code has expired");
  });

  it("should return 202 when device code is pending", async () => {
    const code = await createTestDeviceCode({ status: "pending" });

    const response = await POST(makeTokenRequest(code));
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.error).toBe("authorization_pending");
    expect(body.error_description).toContain(
      "The user has not yet completed authorization",
    );
  });

  it("should return 400 and clean up when device code is denied", async () => {
    const code = await createTestDeviceCode({ status: "denied" });

    const response = await POST(makeTokenRequest(code));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("access_denied");
    expect(body.error_description).toBe(
      "The user denied the authorization request",
    );

    const found = await findTestDeviceCode(code);
    expect(found).toBeUndefined();
  });

  it("should return 200 with token when device code is authenticated", async () => {
    const code = await createTestDeviceCode({
      status: "authenticated",
      userId: user.userId,
    });

    const response = await POST(makeTokenRequest(code));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty("error");
    expect(body.access_token).toMatch(/^vm0_live_/);
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(90 * 24 * 60 * 60);
    expect(body.refresh_token).toEqual(expect.any(String));

    // Verify the CLI token was persisted
    const tokenRow = await findTestCliToken(body.access_token);
    expect(tokenRow).toBeDefined();
    expect(tokenRow!.userId).toBe(user.userId);

    // Verify the device code was cleaned up
    const found = await findTestDeviceCode(code);
    expect(found).toBeUndefined();
  });

  it("should return 400 when device_code is missing from body", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/cli/auth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("invalid_request");
  });
});
