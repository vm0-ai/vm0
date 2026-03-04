import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../../src/mocks/server";
import { GET } from "../route";
import {
  createTestRequest,
  createTestScope,
  createTestCompose,
  findTestGitHubInstallations,
  findTestGitHubInstallationsByUserId,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { env } from "../../../../../../src/env";

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

/**
 * Build a signed OAuth state string matching the install route's HMAC format.
 */
function buildSignedState(vm0UserId: string, composeId: string): string {
  const { SECRETS_ENCRYPTION_KEY } = env();
  const payload = `${vm0UserId}:${composeId}`;
  const sig = createHmac("sha256", SECRETS_ENCRYPTION_KEY)
    .update(payload)
    .digest("hex");
  return JSON.stringify({ vm0UserId, composeId, sig });
}

describe("/api/github/oauth/callback", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should redirect with error when installation_id is missing for install action", async () => {
    const userId = uniqueId("gh-user");
    mockClerk({ userId });
    await createTestScope(uniqueId("gh-scope"));
    const { composeId } = await createTestCompose("gh-test-agent");

    const state = buildSignedState(userId, composeId);
    const request = createTestRequest(
      `http://localhost:3000/api/github/oauth/callback?setup_action=install&state=${encodeURIComponent(state)}`,
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

  it("should redirect with error when state has no composeId and no signature", async () => {
    const state = JSON.stringify({ vm0UserId: "user-123" });
    const request = createTestRequest(
      `http://localhost:3000/api/github/oauth/callback?installation_id=12345&setup_action=install&state=${encodeURIComponent(state)}`,
    );
    const response = await GET(request);

    expect(response.status).toBe(307);
    const location = response.headers.get("Location");
    expect(location).toContain("error=");
    expect(location).toContain("Invalid%20state%20signature");
  });

  it("should redirect with error when state signature is invalid", async () => {
    const state = JSON.stringify({
      vm0UserId: "user-123",
      composeId: "compose-123",
      sig: "invalid-signature",
    });
    const request = createTestRequest(
      `http://localhost:3000/api/github/oauth/callback?installation_id=12345&setup_action=install&state=${encodeURIComponent(state)}`,
    );
    const response = await GET(request);

    expect(response.status).toBe(307);
    const location = response.headers.get("Location");
    expect(location).toContain("error=");
    expect(location).toContain("Invalid%20state%20signature");
  });

  it("should redirect without error for update action", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/github/oauth/callback?installation_id=12345&setup_action=update",
    );
    const response = await GET(request);

    expect(response.status).toBe(307);
    const location = response.headers.get("Location");
    expect(location).toContain("settings?tab=integrations");
    expect(location).not.toContain("error=");
  });

  it("should propagate error when GitHub API fails", async () => {
    const userId = uniqueId("gh-user");
    mockClerk({ userId });
    await createTestScope(uniqueId("gh-scope"));
    const { composeId } = await createTestCompose("gh-test-agent");

    const installationId = uniqueId("install");
    server.use(
      http.post(
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        () => {
          return HttpResponse.json(
            { message: "Bad credentials" },
            { status: 401 },
          );
        },
      ),
    );

    const state = buildSignedState(userId, composeId);
    const request = createTestRequest(
      `http://localhost:3000/api/github/oauth/callback?installation_id=${installationId}&setup_action=install&state=${encodeURIComponent(state)}`,
    );

    await expect(GET(request)).rejects.toThrow(
      "Failed to get installation access token: 401",
    );
  });

  it("should create installation on valid callback", async () => {
    const userId = uniqueId("gh-user");
    mockClerk({ userId });
    await createTestScope(uniqueId("gh-scope"));
    const { composeId } = await createTestCompose("gh-test-agent");

    const installationId = uniqueId("install");
    setupGitHubTokenMock(installationId);

    const state = buildSignedState(userId, composeId);
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

  it("should create pending record when setup_action is request", async () => {
    const userId = uniqueId("gh-user");
    mockClerk({ userId });
    await createTestScope(uniqueId("gh-scope"));
    const { composeId } = await createTestCompose("gh-test-agent");

    const state = buildSignedState(userId, composeId);
    const targetId = "12345678";
    const request = createTestRequest(
      `http://localhost:3000/api/github/oauth/callback?setup_action=request&target_id=${targetId}&target_type=Organization&state=${encodeURIComponent(state)}`,
    );
    const response = await GET(request);

    expect(response.status).toBe(307);
    const location = response.headers.get("Location");
    expect(location).toContain("settings?tab=integrations");
    expect(location).toContain("pending=true");
    expect(location).not.toContain("error=");

    // Verify pending installation was created in DB
    const installations = await findTestGitHubInstallationsByUserId(userId);
    expect(installations).toHaveLength(1);
    const installation = installations[0]!;
    expect(installation.userId).toBe(userId);
    expect(installation.status).toBe("pending");
    expect(installation.installationId).toBeNull();
    expect(installation.encryptedAccessToken).toBeNull();
    expect(installation.targetId).toBe(targetId);
    expect(installation.targetType).toBe("Organization");
    expect(installation.defaultComposeId).toBe(composeId);
  });

  it("should skip creation when installation already exists", async () => {
    const userId = uniqueId("gh-user");
    mockClerk({ userId });
    await createTestScope(uniqueId("gh-scope"));
    const { composeId } = await createTestCompose("gh-test-agent");

    const installationId = uniqueId("install");
    setupGitHubTokenMock(installationId);

    // First callback — creates installation
    const state = buildSignedState(userId, composeId);
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
