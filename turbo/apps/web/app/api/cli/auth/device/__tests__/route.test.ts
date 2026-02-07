import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import { createTestRequest } from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

function makeDeviceRequest() {
  return createTestRequest("http://localhost:3000/api/cli/auth/device", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

describe("POST /api/cli/auth/device", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("should return device code with correct response shape", async () => {
    const response = await POST(makeDeviceRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      device_code: expect.any(String),
      user_code: expect.any(String),
      verification_path: "/cli-auth",
      expires_in: 900,
      interval: 5,
    });
  });

  it("should return device code in XXXX-XXXX format", async () => {
    const validChars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const pattern = new RegExp(`^[${validChars}]{4}-[${validChars}]{4}$`);

    const response = await POST(makeDeviceRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.device_code).toMatch(pattern);
  });

  it("should set user_code equal to device_code", async () => {
    const response = await POST(makeDeviceRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.user_code).toBe(body.device_code);
  });

  it("should generate unique codes on repeated calls", async () => {
    const response1 = await POST(makeDeviceRequest());
    const body1 = await response1.json();

    const response2 = await POST(makeDeviceRequest());
    const body2 = await response2.json();

    expect(response1.status).toBe(200);
    expect(response2.status).toBe(200);
    expect(body1.device_code).not.toBe(body2.device_code);
  });
});
