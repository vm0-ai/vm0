import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import { createTestRequest } from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

vi.mock("@clerk/nextjs/server");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

describe("GET /api/zero/phone/status", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/phone/status",
    );
    const response = await GET(request);

    expect(response.status).toBe(401);
  });

  it("should return phone status with no linked phone", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/phone/status",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.userPhone).toBeNull();
    expect(data.userPhonePending).toBeNull();
    expect(data.orgPhone).toBeNull();
  });
});
