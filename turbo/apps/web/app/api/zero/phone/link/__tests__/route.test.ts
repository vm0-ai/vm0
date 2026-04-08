import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST, DELETE } from "../route";
import {
  createTestRequest,
  createTestOrg,
} from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

vi.mock("@clerk/nextjs/server");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

describe("POST /api/zero/phone/link", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/phone/link",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: "+14155551234" }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(401);
  });

  it("should reject non-vm0 org with 403", async () => {
    // The default org slug from setupUser() is not "vm0", so it should be rejected
    const request = createTestRequest(
      "http://localhost:3000/api/zero/phone/link",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: "+14155551234" }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toContain("not available");
  });

  it("should reject invalid phone number format for vm0 org", async () => {
    // Set up user with vm0 org slug so the org check passes
    await createTestOrg("vm0");

    const request = createTestRequest(
      "http://localhost:3000/api/zero/phone/link",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: "not-a-phone" }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("E.164");
  });

  it("should save phone number for vm0 org user and return success", async () => {
    await createTestOrg("vm0");

    const request = createTestRequest(
      "http://localhost:3000/api/zero/phone/link",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: "+14155551234" }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });
});

describe("DELETE /api/zero/phone/link", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/phone/link",
      { method: "DELETE" },
    );
    const response = await DELETE(request);

    expect(response.status).toBe(401);
  });

  it("should succeed even when no link exists to delete", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/phone/link",
      { method: "DELETE" },
    );
    const response = await DELETE(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });
});
