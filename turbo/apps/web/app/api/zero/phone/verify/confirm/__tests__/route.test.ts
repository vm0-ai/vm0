import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import { createTestRequest } from "../../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";

vi.mock("@clerk/nextjs/server");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

describe("POST /api/zero/phone/verify/confirm", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/phone/verify/confirm",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: "+14155551234", code: "123456" }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(401);
  });

  it("should reject missing required fields", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/phone/verify/confirm",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(400);
  });

  it("should return error when no verification request exists", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/phone/verify/confirm",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: "+14155551234", code: "123456" }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("No verification request found");
  });
});
