import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../../src/mocks/server";
import { GET } from "../route";
import {
  createTestRequest,
  createTestOrg,
  createTestCompose,
  findTestGitHubInstallations,
  findTestGitHubInstallationsByTargetId,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  uniqueNumericId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { env } from "../../../../../../src/env";

const context = testContext();

const TEST_TARGET_ID = "99887766";
const TEST_TARGET_LOGIN = "test-org";
const TEST_TARGET_TYPE = "Organization";

function setupGitHubMocks(installationId: string) {
  server.use(
    http.get(
      `https://api.github.com/app/installations/${installationId}`,
      () => {
        return HttpResponse.json({
          id: Number(installationId),
          account: {
            id: Number(TEST_TARGET_ID),
            login: TEST_TARGET_LOGIN,
            type: TEST_TARGET_TYPE,
          },
        });
      },
    ),
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
    await createTestOrg(uniqueId("gh-org"));
    const { composeId } = await createTestCompose(uniqueId("gh-test-agent"));

    const state = buildSignedState(userId, composeId);
    const request = createTestRequest(
      `http://localhost:3000/api/github/oauth/callback?setup_action=install&state=${encodeURIComponent(state)}`,
    );
    const response = await GET(request);

    expect(response.status).toBe(307);
    const location = response.headers.get("Location");
    expect(location).toContain("works");
    expect(location).toContain("error=");
    expect(location).toContain("Missing%20installation%20ID");
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
    expect(location).toContain("works");
    expect(location).not.toContain("error=");
  });

  it("should propagate error when GitHub API fails", async () => {
    const userId = uniqueId("gh-user");
    mockClerk({ userId });
    await createTestOrg(uniqueId("gh-org"));
    const { composeId } = await createTestCompose(uniqueId("gh-test-agent"));

    const installationId = uniqueNumericId();
    server.use(
      http.get(
        `https://api.github.com/app/installations/${installationId}`,
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
      "Failed to get installation info: 401",
    );
  });

  it("should create installation on valid callback", async () => {
    const userId = uniqueId("gh-user");
    mockClerk({ userId });
    await createTestOrg(uniqueId("gh-org"));
    const { composeId } = await createTestCompose(uniqueId("gh-test-agent"));

    const installationId = uniqueNumericId();
    setupGitHubMocks(installationId);

    const state = buildSignedState(userId, composeId);
    const request = createTestRequest(
      `http://localhost:3000/api/github/oauth/callback?installation_id=${installationId}&setup_action=install&state=${encodeURIComponent(state)}`,
    );
    const response = await GET(request);

    expect(response.status).toBe(307);
    const location = response.headers.get("Location");
    expect(location).toContain("works");
    expect(location).not.toContain("error=");

    const installations = await findTestGitHubInstallations(installationId);
    expect(installations).toHaveLength(1);
    const installation = installations[0]!;
    expect(installation.defaultComposeId).toBe(composeId);
    expect(installation.encryptedAccessToken).toBeTruthy();
    expect(installation.targetType).toBe(TEST_TARGET_TYPE);
    expect(installation.targetId).toBe(TEST_TARGET_ID);
    expect(installation.targetName).toBe(TEST_TARGET_LOGIN);
  });

  it("should create pending record when setup_action is request", async () => {
    const userId = uniqueId("gh-user");
    mockClerk({ userId });
    await createTestOrg(uniqueId("gh-org"));
    const { composeId } = await createTestCompose(uniqueId("gh-test-agent"));

    const state = buildSignedState(userId, composeId);
    const targetId = uniqueId("target");
    const request = createTestRequest(
      `http://localhost:3000/api/github/oauth/callback?setup_action=request&target_id=${targetId}&target_type=Organization&state=${encodeURIComponent(state)}`,
    );
    const response = await GET(request);

    expect(response.status).toBe(307);
    const location = response.headers.get("Location");
    expect(location).toContain("works");
    expect(location).toContain("pending=true");
    expect(location).not.toContain("error=");

    const installations = await findTestGitHubInstallationsByTargetId(targetId);
    expect(installations).toHaveLength(1);
    const installation = installations[0]!;
    expect(installation.status).toBe("pending");
    expect(installation.installationId).toBeNull();
    expect(installation.encryptedAccessToken).toBeNull();
    expect(installation.targetId).toBe(targetId);
    expect(installation.targetType).toBe("Organization");
    expect(installation.defaultComposeId).toBe(composeId);
  });

  it("should redirect with error when state contains invalid JSON", async () => {
    const request = createTestRequest(
      `http://localhost:3000/api/github/oauth/callback?installation_id=12345&setup_action=install&state=not-json`,
    );
    const response = await GET(request);

    expect(response.status).toBe(307);
    const location = response.headers.get("Location");
    expect(location).toContain("works");
    expect(location).toContain("error=");
    expect(location).toContain("Invalid%20OAuth%20state");
  });

  it("should skip creation when installation already exists", async () => {
    const userId = uniqueId("gh-user");
    mockClerk({ userId });
    await createTestOrg(uniqueId("gh-org"));
    const { composeId } = await createTestCompose(uniqueId("gh-test-agent"));

    const installationId = uniqueNumericId();
    setupGitHubMocks(installationId);

    const state = buildSignedState(userId, composeId);
    const request1 = createTestRequest(
      `http://localhost:3000/api/github/oauth/callback?installation_id=${installationId}&setup_action=install&state=${encodeURIComponent(state)}`,
    );
    await GET(request1);

    const request2 = createTestRequest(
      `http://localhost:3000/api/github/oauth/callback?installation_id=${installationId}&setup_action=install&state=${encodeURIComponent(state)}`,
    );
    const response2 = await GET(request2);

    expect(response2.status).toBe(307);
    const location = response2.headers.get("Location");
    expect(location).toContain("works");
    expect(location).not.toContain("error=");

    const installations = await findTestGitHubInstallations(installationId);
    expect(installations).toHaveLength(1);
  });
});
