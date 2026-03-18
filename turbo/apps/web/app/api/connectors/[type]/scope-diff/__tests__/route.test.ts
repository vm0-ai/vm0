import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestConnector,
  setTestConnectorOauthScopes,
} from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("GET /api/connectors/:type/scope-diff", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/github/scope-diff",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should return 404 for connector not connected", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/github/scope-diff",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.message).toContain("not found");
  });

  it("should return correct diff when scopes added", async () => {
    const user = await context.setupUser();
    await createTestConnector({ type: "github" });

    // GitHub requires ["repo", "project"] — set stored to only ["repo"]
    await setTestConnectorOauthScopes(user.orgId, user.userId, "github", [
      "repo",
    ]);

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/github/scope-diff",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.addedScopes).toEqual(["project"]);
    expect(data.removedScopes).toEqual([]);
    expect(data.currentScopes).toEqual(["repo", "project"]);
    expect(data.storedScopes).toEqual(["repo"]);
  });

  it("should return correct diff when scopes removed", async () => {
    const user = await context.setupUser();
    await createTestConnector({ type: "github" });

    // Stored has extra "read:org" that is no longer required
    await setTestConnectorOauthScopes(user.orgId, user.userId, "github", [
      "repo",
      "project",
      "read:org",
    ]);

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/github/scope-diff",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.addedScopes).toEqual([]);
    expect(data.removedScopes).toEqual(["read:org"]);
    expect(data.currentScopes).toEqual(["repo", "project"]);
    expect(data.storedScopes).toEqual(["repo", "project", "read:org"]);
  });

  it("should return empty arrays when no mismatch", async () => {
    await context.setupUser();
    await createTestConnector({ type: "github" });

    // Default createTestConnector for github stores ["repo", "project"] via mock
    const request = createTestRequest(
      "http://localhost:3000/api/connectors/github/scope-diff",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.addedScopes).toEqual([]);
    expect(data.removedScopes).toEqual([]);
    expect(data.currentScopes).toEqual(["repo", "project"]);
    expect(data.storedScopes).toEqual(["repo", "project"]);
  });
});
