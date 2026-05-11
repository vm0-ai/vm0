import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET, POST, DELETE } from "../route";
import { createTestRequest } from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

vi.mock("@axiomhq/logging");

const context = testContext();

const BASE_URL = "http://localhost:3000/api/zero/feature-switches";

function getRequest() {
  return createTestRequest(BASE_URL);
}

function postRequest(switches: Record<string, boolean>) {
  return createTestRequest(BASE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ switches }),
  });
}

function deleteRequest() {
  return createTestRequest(BASE_URL, { method: "DELETE" });
}

describe("GET /api/zero/feature-switches", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(getRequest());
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should return 401 when authenticated session has no active organization", async () => {
    mockClerk({ userId: "user_feature_switches_no_org_get", orgId: null });

    const response = await GET(getRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("should return empty switches for new user", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    const response = await GET(getRequest());
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.switches).toEqual({});
  });
});

describe("POST /api/zero/feature-switches", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await POST(postRequest({ voiceChat: true }));
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should return 401 when authenticated session has no active organization", async () => {
    mockClerk({ userId: "user_feature_switches_no_org_post", orgId: null });

    const response = await POST(postRequest({ voiceChat: true }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("should create new switches", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    const response = await POST(postRequest({ voiceChat: true }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.switches).toEqual({ voiceChat: true });
  });

  it("should merge with existing switches", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    await POST(postRequest({ voiceChat: true }));
    const response = await POST(postRequest({ lab: false }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.switches).toEqual({ voiceChat: true, lab: false });
  });

  it("should override existing switch values", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    await POST(postRequest({ voiceChat: true }));
    const response = await POST(postRequest({ voiceChat: false }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.switches).toEqual({ voiceChat: false });
  });

  it("should return updated switches on subsequent GET", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    await POST(postRequest({ voiceChat: true, lab: false }));

    const response = await GET(getRequest());
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.switches).toEqual({ voiceChat: true, lab: false });
  });
});

describe("DELETE /api/zero/feature-switches", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await DELETE(deleteRequest());
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should return 401 when authenticated session has no active organization", async () => {
    mockClerk({ userId: "user_feature_switches_no_org_delete", orgId: null });

    const response = await DELETE(deleteRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("should clear all overrides and subsequent GET returns empty switches", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    await POST(postRequest({ voiceChat: true, lab: false }));

    const deleteResponse = await DELETE(deleteRequest());
    const deleteData = await deleteResponse.json();

    expect(deleteResponse.status).toBe(200);
    expect(deleteData.deleted).toBe(true);

    const getResponse = await GET(getRequest());
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(200);
    expect(getData.switches).toEqual({});
  });
});
