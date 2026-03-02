import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../../src/mocks/server";
import { GET } from "../route";
import {
  createTestRequest,
  createTestScope,
  createTestCompose,
  findTestGitHubInstallations,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

const context = testContext();

function setupGitHubTokenMock(installationId: string) {
  server.use(
    http.post(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      () => {
        return HttpResponse.json({
          token: "ghs_test_installation_token_123",
          expires_at: "2099-01-01T00:00:00Z",
        });
      },
    ),
  );
}

describe("/api/github/oauth/callback", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should redirect with error when installation_id is missing", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/github/oauth/callback",
    );
    const response = await GET(request);

    expect(response.status).toBe(307);
    const location = response.headers.get("Location");
    expect(location).toContain("settings?tab=integrations");
    expect(location).toContain("error=");
    expect(location).toContain("Missing%20installation%20ID");
  });

  it("should redirect with error when state has no vm0UserId", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/github/oauth/callback?installation_id=12345&setup_action=install",
    );
    const response = await GET(request);

    expect(response.status).toBe(307);
    const location = response.headers.get("Location");
    expect(location).toContain("error=");
    expect(location).toContain("Missing%20user%20context");
  });

  it("should redirect with error when state has no composeId", async () => {
    const state = JSON.stringify({ vm0UserId: "user-123" });
    const request = createTestRequest(
      `http://localhost:3000/api/github/oauth/callback?installation_id=12345&setup_action=install&state=${encodeURIComponent(state)}`,
    );
    const response = await GET(request);

    expect(response.status).toBe(307);
    const location = response.headers.get("Location");
    expect(location).toContain("error=");
    expect(location).toContain("Missing%20default%20agent");
  });

  it("should create installation on valid callback", async () => {
    const userId = uniqueId("gh-user");
    mockClerk({ userId });
    await createTestScope(uniqueId("gh-scope"));
    const { composeId } = await createTestCompose("gh-test-agent");

    const installationId = uniqueId("install");
    setupGitHubTokenMock(installationId);

    const state = JSON.stringify({ vm0UserId: userId, composeId });
    const request = createTestRequest(
      `http://localhost:3000/api/github/oauth/callback?installation_id=${installationId}&setup_action=install&state=${encodeURIComponent(state)}`,
    );
    const response = await GET(request);

    expect(response.status).toBe(307);
    const location = response.headers.get("Location");
    expect(location).toContain("settings?tab=integrations");
    expect(location).not.toContain("error=");

    // Verify installation was created in DB
    const installations = await findTestGitHubInstallations(installationId);
    expect(installations).toHaveLength(1);
    const installation = installations[0]!;
    expect(installation.userId).toBe(userId);
    expect(installation.defaultComposeId).toBe(composeId);
    expect(installation.encryptedAccessToken).toBeTruthy();
  });

  it("should skip creation when installation already exists", async () => {
    const userId = uniqueId("gh-user");
    mockClerk({ userId });
    await createTestScope(uniqueId("gh-scope"));
    const { composeId } = await createTestCompose("gh-test-agent");

    const installationId = uniqueId("install");
    setupGitHubTokenMock(installationId);

    // First callback — creates installation
    const state = JSON.stringify({ vm0UserId: userId, composeId });
    const request1 = createTestRequest(
      `http://localhost:3000/api/github/oauth/callback?installation_id=${installationId}&setup_action=install&state=${encodeURIComponent(state)}`,
    );
    await GET(request1);

    // Second callback — should skip, not error
    const request2 = createTestRequest(
      `http://localhost:3000/api/github/oauth/callback?installation_id=${installationId}&setup_action=install&state=${encodeURIComponent(state)}`,
    );
    const response2 = await GET(request2);

    expect(response2.status).toBe(307);
    const location = response2.headers.get("Location");
    expect(location).toContain("settings?tab=integrations");
    expect(location).not.toContain("error=");

    // Verify only one installation record exists
    const installations = await findTestGitHubInstallations(installationId);
    expect(installations).toHaveLength(1);
  });
});
