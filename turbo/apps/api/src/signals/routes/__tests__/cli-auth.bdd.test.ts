import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { afterEach, describe, expect, it } from "vitest";

import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { testContext } from "../../../__tests__/test-helpers";
import { generateSandboxToken } from "../../auth/tokens";
import { DEFAULT_TEST_EMAIL } from "../../services/cli-auth.service";
import { createBddApi, expectApiError } from "./helpers/api-bdd";
import {
  createAuthDeviceApiActions,
  makeCodexAuthJson,
} from "./helpers/api-bdd-auth-device";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";

const context = testContext();
const bdd = createBddApi(context);
const authDevice = createAuthDeviceApiActions(context);
const connectors = createConnectorBddApi(context);
const misc = createMiscRoutesApi(context);

const DEVICE_CODE_EXPIRY_MS = 16 * 60 * 1000;

const LEGACY_CODEX_OAUTH_BODY = {
  accessToken: "REAL-AT-7f3a82d1-9b4c-4e5f-a1b2-c3d4e5f60718",
  refreshToken: "REAL-RT-1a2b3c4d-5e6f-7g8h-9i0j-k1l2m3n4o5p6",
  accountId: "ws_REAL_ACCOUNT_test",
  idToken: "hdr.PAYLOAD.SIG",
} as const;

interface OAuthErrorBody {
  readonly error: string;
  readonly error_description: string;
}

interface CliApprovalErrorBody {
  readonly success: false;
  readonly error: string;
}

function expectOAuthError(body: unknown): asserts body is OAuthErrorBody {
  if (
    typeof body !== "object" ||
    body === null ||
    !("error" in body) ||
    !("error_description" in body)
  ) {
    throw new Error("Expected OAuth error response body");
  }
}

function expectCliApprovalError(
  body: unknown,
): asserts body is CliApprovalErrorBody {
  if (
    typeof body !== "object" ||
    body === null ||
    !("success" in body) ||
    !("error" in body) ||
    body.success !== false
  ) {
    throw new Error("Expected CLI approval error response body");
  }
}

interface MembershipDirectoryEntry {
  readonly orgId: string;
  readonly role: "org:admin" | "org:member";
}

function mockMembershipDirectory(
  userId: string,
  entries: readonly MembershipDirectoryEntry[],
): void {
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: entries.map((entry, index) => {
      return {
        role: entry.role,
        organization: {
          id: entry.orgId,
          slug: entry.orgId.toLowerCase(),
          name: `BDD CLI Auth Org ${index}`,
        },
        publicUserData: { userId },
        createdAt: Date.parse("2026-01-01T00:00:00.000Z") + index,
      };
    }),
  });
}

async function issueDevicePat(
  actor: ReturnType<typeof bdd.user>,
): Promise<{ readonly accessToken: string }> {
  const started = await authDevice.startCliDevice();
  const approved = await authDevice.requestCliApproval(
    actor,
    { device_code: started.device_code },
    [200],
  );
  expect(approved.body).toStrictEqual({ success: true });

  const token = await authDevice.requestCliToken(started.device_code, [200]);
  if (token.status !== 200) {
    throw new Error(`Expected CLI token exchange, got ${token.status}`);
  }
  return { accessToken: token.body.access_token };
}

afterEach(() => {
  clearMockNow();
});

describe("AUTH-02: CLI device code expiry", () => {
  it("expires unexchanged device codes for both token polling and browser approval", async () => {
    const actor = bdd.user();
    const base = now();
    mockNow(base);

    const first = await authDevice.startCliDevice();
    const second = await authDevice.startCliDevice();
    expect(first.device_code).not.toBe(second.device_code);

    mockNow(base + DEVICE_CODE_EXPIRY_MS);

    const expiredExchange = await authDevice.requestCliToken(
      first.device_code,
      [400],
    );
    expectOAuthError(expiredExchange.body);
    expect(expiredExchange.body).toStrictEqual({
      error: "expired_token",
      error_description: "The device code has expired",
    });

    const expiredApproval = await authDevice.requestCliApproval(
      actor,
      { device_code: second.device_code },
      [400],
    );
    expectCliApprovalError(expiredApproval.body);
    expect(expiredApproval.body.error).toBe("Device code has expired");

    clearMockNow();
  });
});

describe("AUTH-02: approval transitions and timezone", () => {
  it("approves a code only once and writes timezone only when valid and unset", async () => {
    const actor = bdd.user();

    const missingDeviceCode = await authDevice.requestCliApproval(
      actor,
      { device_code: "" },
      [400],
    );
    expectCliApprovalError(missingDeviceCode.body);
    expect(missingDeviceCode.body.error).toContain("device_code");

    const first = await authDevice.startCliDevice();
    const approved = await authDevice.requestCliApproval(
      actor,
      { device_code: first.device_code },
      [200],
    );
    expect(approved.body).toStrictEqual({ success: true });

    const reApproved = await authDevice.requestCliApproval(
      actor,
      { device_code: first.device_code },
      [400],
    );
    expectCliApprovalError(reApproved.body);
    expect(reApproved.body.error).toBe("Invalid or expired device code");

    const initialPreferences = await misc.readPreferences(actor);
    expect(initialPreferences.body.timezone).toBeNull();

    const second = await authDevice.startCliDevice();
    await authDevice.requestCliApproval(
      actor,
      { device_code: second.device_code, timezone: "America/Los_Angeles" },
      [200],
    );
    const afterFirstTimezone = await misc.readPreferences(actor);
    expect(afterFirstTimezone.body.timezone).toBe("America/Los_Angeles");

    const third = await authDevice.startCliDevice();
    await authDevice.requestCliApproval(
      actor,
      { device_code: third.device_code, timezone: "Asia/Tokyo" },
      [200],
    );
    const afterSecondTimezone = await misc.readPreferences(actor);
    expect(afterSecondTimezone.body.timezone).toBe("America/Los_Angeles");

    const freshActor = bdd.user();
    const fourth = await authDevice.startCliDevice();
    await authDevice.requestCliApproval(
      freshActor,
      { device_code: fourth.device_code, timezone: "Not/AZone" },
      [200],
    );
    const invalidTimezone = await misc.readPreferences(freshActor);
    expect(invalidTimezone.body.timezone).toBeNull();
  });
});

describe("AUTH-02: no-org approval issues an org-less PAT", () => {
  it("approves and exchanges for a session without an active organization", async () => {
    const noOrgActor = bdd.user({ orgId: null });

    const started = await authDevice.startCliDevice();
    const approved = await authDevice.requestCliApproval(
      noOrgActor,
      { device_code: started.device_code, timezone: "America/Los_Angeles" },
      [200],
    );
    expect(approved.body).toStrictEqual({ success: true });

    const token = await authDevice.requestCliToken(started.device_code, [200]);
    if (token.status !== 200) {
      throw new Error(`Expected CLI token exchange, got ${token.status}`);
    }
    expect(token.body.access_token).toMatch(/^vm0_pat_/);
    expect(token.body.token_type).toBe("Bearer");
    expect(token.body.expires_in).toBe(90 * 24 * 60 * 60);

    // An org-less exchange issues a PAT with an empty org claim, which the
    // CLI token verifier rejects (`orgId: z.string().min(1)`), so the only
    // visible contract is the token-issuance response itself.
    const reused = await authDevice.requestCliToken(started.device_code, [400]);
    expectOAuthError(reused.body);
    expect(reused.body.error).toBe("invalid_request");
  });
});

describe("AUTH-02: approve credential-type boundaries", () => {
  it("rejects pat and sandbox bearers on approve while the code stays pending", async () => {
    const actor = bdd.user();
    const pat = await issueDevicePat(actor);

    const pending = await authDevice.startCliDevice();

    const patApproval = await authDevice.requestCliApprovalWithBearer(
      pat.accessToken,
      { device_code: pending.device_code },
      [403],
    );
    expectApiError(patApproval.body);
    expect(patApproval.body.error.code).toBe("FORBIDDEN");

    const sandboxToken = generateSandboxToken(
      actor.userId,
      "run_bdd_cli_auth",
      actor.orgId ?? "org_bdd_cli_auth",
    );
    const sandboxApproval = await authDevice.requestCliApprovalWithBearer(
      sandboxToken,
      { device_code: pending.device_code },
      [403],
    );
    expectApiError(sandboxApproval.body);
    expect(sandboxApproval.body.error).toStrictEqual({
      message: "This endpoint is not available for sandbox tokens",
      code: "FORBIDDEN",
    });

    const stillPending = await authDevice.requestCliToken(
      pending.device_code,
      [202],
    );
    expectOAuthError(stillPending.body);
    expect(stillPending.body.error).toBe("authorization_pending");
  });
});

describe("AUTH-02: CLI org switch", () => {
  it("switches orgs by slug with cache refresh, membership checks, and error remaps", async () => {
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected actor with an active organization");
    }
    const sourceOrgId = actor.orgId;
    const pat = await issueDevicePat(actor);

    const unauthenticated = await authDevice.requestOrgSwitch(
      null,
      { slug: "some-org" },
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body).toStrictEqual({
      error: { message: "Authentication required", code: "unauthorized" },
    });

    authDevice.seedClerkDirectory(actor);
    const missingSlug = await authDevice.requestOrgSwitchRaw(
      pat.accessToken,
      JSON.stringify({}),
    );
    expect(missingSlug.status).toBe(400);
    expectOAuthError(missingSlug.body);
    expect(missingSlug.body.error).toBe("invalid_request");

    const emptySlug = await authDevice.requestOrgSwitch(
      pat.accessToken,
      { slug: "" },
      [400],
    );
    expectOAuthError(emptySlug.body);
    expect(emptySlug.body.error).toBe("invalid_request");

    context.mocks.clerk.organizations.getOrganization.mockRejectedValue({
      statusCode: 404,
    });
    const unknownSlug = await authDevice.requestOrgSwitch(
      pat.accessToken,
      { slug: "missing-bdd-org" },
      [404],
    );
    expectApiError(unknownSlug.body);
    expect(unknownSlug.body.error.code).toBe("not_found");

    const targetOrgId = `org_bdd_target_${actor.userId.slice(-12)}`;
    const targetSlug = targetOrgId.toLowerCase();
    context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
      id: targetOrgId,
      slug: targetSlug,
      name: "BDD Target Org",
      createdBy: actor.userId,
    });
    mockMembershipDirectory(actor.userId, [
      { orgId: sourceOrgId, role: "org:admin" },
      { orgId: targetOrgId, role: "org:member" },
    ]);

    const switched = await authDevice.requestOrgSwitch(
      pat.accessToken,
      { slug: targetSlug },
      [200],
    );
    if (switched.status !== 200) {
      throw new Error(`Expected org switch to succeed, got ${switched.status}`);
    }
    expect(switched.body.access_token).toMatch(/^vm0_pat_/);
    expect(switched.body.token_type).toBe("Bearer");
    expect(switched.body.expires_in).toBe(90 * 24 * 60 * 60);

    const me = await authDevice.readMeWithBearer(
      switched.body.access_token,
      actor,
      [200],
    );
    expect(me.body).toStrictEqual({
      userId: actor.userId,
      email: actor.email,
    });

    const cachedSwitch = await authDevice.requestOrgSwitch(
      pat.accessToken,
      { slug: targetSlug },
      [200],
    );
    if (cachedSwitch.status !== 200) {
      throw new Error(
        `Expected cached org switch to succeed, got ${cachedSwitch.status}`,
      );
    }
    expect(cachedSwitch.body.access_token).toMatch(/^vm0_pat_/);
    expect(
      context.mocks.clerk.organizations.getOrganization,
    ).toHaveBeenCalledTimes(2);

    const foreignOrgId = `org_bdd_foreign_${actor.userId.slice(-12)}`;
    context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
      id: foreignOrgId,
      slug: foreignOrgId.toLowerCase(),
      name: "BDD Foreign Org",
    });
    mockMembershipDirectory(actor.userId, [
      { orgId: sourceOrgId, role: "org:admin" },
    ]);

    const notMember = await authDevice.requestOrgSwitch(
      pat.accessToken,
      { slug: foreignOrgId.toLowerCase() },
      [403],
    );
    expectApiError(notMember.body);
    expect(notMember.body.error).toStrictEqual({
      message: "Not a member of this organization",
      code: "forbidden",
    });
  });
});

describe("CLI-TEST: test-token gating", () => {
  it("hides test-token outside development without a valid preview bypass", async () => {
    mockEnv("ENV", "production");
    const productionResponse = await authDevice.requestTestToken({}, [404]);
    expect(productionResponse.body).toBe("Not found");

    mockEnv("ENV", "preview");
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");

    const missingHeader = await authDevice.requestTestTokenRaw();
    expect(missingHeader.status).toBe(404);
    expect(missingHeader.body).toBe("Not found");

    const wrongHeader = await authDevice.requestTestTokenRaw({
      "x-vercel-protection-bypass": "wrong-secret",
    });
    expect(wrongHeader.status).toBe(404);
    expect(wrongHeader.body).toBe("Not found");

    const actor = bdd.user();
    authDevice.seedClerkDirectory(actor);
    const bypassed = await authDevice.requestTestTokenRaw({
      "x-vercel-protection-bypass": "preview-secret",
    });
    expect(bypassed.status).toBe(200);
    expect(bypassed.body).toMatchObject({
      token_type: "Bearer",
      user_id: actor.userId,
    });

    mockOptionalEnv("USE_MOCK_CLAUDE", "true");
    const rewritten = await authDevice.requestTestToken({}, [200]);
    if (rewritten.status !== 200) {
      throw new Error(
        `Expected preview-rewrite test token, got ${rewritten.status}`,
      );
    }
    expect(rewritten.body.access_token).toMatch(/^vm0_pat_/);
    expect(rewritten.body.user_id).toBe(actor.userId);
  });
});

describe("CLI-TEST: test-token provisioning", () => {
  it("provisions a pro test org whose pat works against me, billing, and org switch", async () => {
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected actor with an active organization");
    }
    authDevice.seedClerkDirectory(actor);

    const issued = await authDevice.requestTestToken({}, [200]);
    if (issued.status !== 200) {
      throw new Error(`Expected test token issuance, got ${issued.status}`);
    }
    expect(issued.body).toMatchObject({
      token_type: "Bearer",
      expires_in: 90 * 24 * 60 * 60,
      user_id: actor.userId,
    });
    expect(issued.body.access_token).toMatch(/^vm0_pat_/);
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
      emailAddress: [DEFAULT_TEST_EMAIL],
    });

    const me = await authDevice.readMeWithBearer(
      issued.body.access_token,
      actor,
      [200],
    );
    expect(me.body).toStrictEqual({
      userId: actor.userId,
      email: actor.email,
    });

    const billing = await authDevice.readBillingStatus(actor);
    expect(billing.tier).toBe("pro");
    expect(billing.credits).toBe(100_000);

    const switched = await authDevice.requestOrgSwitch(
      issued.body.access_token,
      { slug: actor.orgId.toLowerCase() },
      [200],
    );
    if (switched.status !== 200) {
      throw new Error(
        `Expected org switch with seeded caches, got ${switched.status}`,
      );
    }
    expect(switched.body.access_token).toMatch(/^vm0_pat_/);

    const reIssued = await authDevice.requestTestToken({}, [200]);
    if (reIssued.status !== 200) {
      throw new Error(
        `Expected repeated test token issuance, got ${reIssued.status}`,
      );
    }
    expect(reIssued.body.user_id).toBe(actor.userId);

    await authDevice.requestTestToken({ email: "custom@test.com" }, [200]);
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
      emailAddress: ["custom@test.com"],
    });

    context.mocks.clerk.users.getUserList.mockResolvedValue({ data: [] });
    const unresolved = await authDevice.requestTestTokenRaw();
    expect(unresolved.status).toBe(500);
  });
});

describe("CLI-TEST: test-approve", () => {
  it("hides test-approve unless mock claude is enabled", async () => {
    const unset = await authDevice.requestTestApprove(
      {},
      { device_code: "TEST-CODE" },
      [404],
    );
    expect(unset.body).toBe("Not found");

    mockOptionalEnv("USE_MOCK_CLAUDE", "false");
    const disabled = await authDevice.requestTestApprove(
      {},
      { device_code: "TEST-CODE" },
      [404],
    );
    expect(disabled.body).toBe("Not found");
  });

  it("approves pending codes case-insensitively and reports transitions visibly", async () => {
    mockOptionalEnv("USE_MOCK_CLAUDE", "true");
    const actor = bdd.user();
    authDevice.seedClerkDirectory(actor);

    const missingCode = await authDevice.requestTestApprove({}, {}, [400]);
    expect(missingCode.body).toStrictEqual({ error: "device_code required" });

    const unknownCode = await authDevice.requestTestApprove(
      {},
      { device_code: "XXXX-XXXX" },
      [404],
    );
    expect(unknownCode.body).toBe("Not found");

    const started = await authDevice.startCliDevice();
    const approved = await authDevice.requestTestApprove(
      { email: DEFAULT_TEST_EMAIL },
      { device_code: started.device_code.toLowerCase() },
      [200],
    );
    expect(approved.body).toStrictEqual({
      success: true,
      userId: actor.userId,
    });
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
      emailAddress: [DEFAULT_TEST_EMAIL],
    });

    const reApproved = await authDevice.requestTestApprove(
      {},
      { device_code: started.device_code },
      [400],
    );
    expect(reApproved.body).toStrictEqual({
      error: "Device code is not in pending status",
    });

    // Test-approve never assigns an org, so the exchanged PAT carries an
    // empty org claim; the issuance response is the visible contract.
    const token = await authDevice.requestCliToken(started.device_code, [200]);
    if (token.status !== 200) {
      throw new Error(`Expected CLI token exchange, got ${token.status}`);
    }
    expect(token.body.access_token).toMatch(/^vm0_pat_/);

    const second = await authDevice.startCliDevice();
    await authDevice.requestTestApprove(
      { email: "custom@test.com" },
      { device_code: second.device_code },
      [200],
    );
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
      emailAddress: ["custom@test.com"],
    });
  });

  it("rejects expired pending device codes", async () => {
    mockOptionalEnv("USE_MOCK_CLAUDE", "true");
    const base = now();
    mockNow(base);
    const started = await authDevice.startCliDevice();

    mockNow(base + DEVICE_CODE_EXPIRY_MS);
    const expired = await authDevice.requestTestApprove(
      {},
      { device_code: started.device_code },
      [400],
    );
    expect(expired.body).toStrictEqual({ error: "Device code has expired" });

    clearMockNow();
  });

  it("keeps the code pending when the test user cannot be resolved", async () => {
    mockOptionalEnv("USE_MOCK_CLAUDE", "true");
    const started = await authDevice.startCliDevice();

    context.mocks.clerk.users.getUserList.mockResolvedValue({ data: [] });
    const unresolved = await authDevice.requestTestApproveRaw(
      JSON.stringify({ device_code: started.device_code }),
    );
    expect(unresolved.status).toBe(500);
    expect(unresolved.body).toStrictEqual({ error: "Internal server error" });

    const actor = bdd.user();
    authDevice.seedClerkDirectory(actor);
    const approved = await authDevice.requestTestApprove(
      {},
      { device_code: started.device_code },
      [200],
    );
    expect(approved.body).toStrictEqual({
      success: true,
      userId: actor.userId,
    });
  });
});

describe("CLI-TEST: test-connector", () => {
  const githubOauthBody = {
    connectorName: "github",
    authMethod: "oauth",
    accessToken: "github-access-token",
  } as const;

  it("hides test-connector in production", async () => {
    mockEnv("ENV", "production");
    const response = await authDevice.requestTestConnector(
      {},
      githubOauthBody,
      [404],
    );
    expect(response.body).toBe("Not found");
  });

  it("rejects malformed and unsupported connector seeds with legacy errors", async () => {
    const invalidJson = await authDevice.requestTestConnectorRaw("{ not json");
    expect(invalidJson.status).toBe(400);
    expect(invalidJson.body).toStrictEqual({ error: "Invalid JSON body" });

    const missingFields = await authDevice.requestTestConnectorRaw(
      JSON.stringify({ connectorName: "github" }),
    );
    expect(missingFields.status).toBe(400);
    expect(missingFields.body).toStrictEqual({
      error: "connectorName, authMethod, and accessToken are required",
    });

    const emptyRefreshToken = await authDevice.requestTestConnector(
      {},
      { ...githubOauthBody, refreshToken: "" },
      [400],
    );
    expect(emptyRefreshToken.body).toStrictEqual({
      error: "connectorName, authMethod, and accessToken are required",
    });

    const unknownType = await authDevice.requestTestConnector(
      {},
      { ...githubOauthBody, connectorName: "unknown-connector" },
      [400],
    );
    expect(unknownType.body).toStrictEqual({
      error: 'Unknown connector type: "unknown-connector"',
    });

    const freshActor = bdd.user();
    authDevice.seedClerkDirectory(freshActor);
    const noOrg = await authDevice.requestTestConnector(
      { email: freshActor.email },
      githubOauthBody,
      [400],
    );
    expect(noOrg.body).toStrictEqual({
      error: "Test user has no org — run test-token first",
    });

    const actor = bdd.user();
    await authDevice.provisionTestOrg(actor);

    const wrongGrantKind = await authDevice.requestTestConnector(
      { email: actor.email },
      {
        connectorName: "cloudinary",
        authMethod: "api-token",
        accessToken: "cloudinary-access-token",
      },
      [400],
    );
    expect(wrongGrantKind.body).toStrictEqual({
      error:
        "cloudinary connector auth method api-token does not use an auth-code or device-auth grant",
    });

    const unconfiguredMethod = await authDevice.requestTestConnector(
      { email: actor.email },
      { ...githubOauthBody, authMethod: "api-token" },
      [400],
    );
    expect(unconfiguredMethod.body).toStrictEqual({
      error: "github connector does not configure auth method api-token",
    });
  });

  it("seeds connector state readable through the connectors API", async () => {
    const actor = bdd.user();
    await authDevice.provisionTestOrg(actor);
    await connectors.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });

    const seeded = await authDevice.requestTestConnector(
      { email: actor.email },
      {
        connectorName: "test-oauth",
        authMethod: "oauth",
        accessToken: "test-oauth-access-token",
        refreshToken: "test-oauth-refresh-token",
        expiresIn: -60,
      },
      [200],
    );
    expect(seeded.body).toStrictEqual({
      ok: true,
      connectorType: "test-oauth",
      orgId: actor.orgId,
    });

    const oauthState = await connectors.readConnectorByType(
      actor,
      "test-oauth",
    );
    expect(oauthState).toMatchObject({
      authMethod: "oauth",
      externalUsername: "e2e-test-oauth",
    });
    if (!oauthState.tokenExpiresAt) {
      throw new Error("Expected seeded connector token expiry");
    }
    expect(Date.parse(oauthState.tokenExpiresAt)).toBeLessThan(now());

    const reSeeded = await authDevice.requestTestConnector(
      { email: actor.email },
      {
        connectorName: "test-oauth",
        authMethod: "api",
        accessToken: "test-oauth-api-access-token",
        refreshToken: "test-oauth-api-refresh-token",
      },
      [200],
    );
    expect(reSeeded.body).toStrictEqual({
      ok: true,
      connectorType: "test-oauth",
      orgId: actor.orgId,
    });
    const apiState = await connectors.readConnectorByType(actor, "test-oauth");
    expect(apiState.authMethod).toBe("api");

    await authDevice.requestTestConnector(
      { email: "custom@test.com" },
      githubOauthBody,
      [200],
    );
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
      emailAddress: ["custom@test.com"],
    });
  });
});

describe("CLI-TEST: test-enable-connector", () => {
  const ZERO_COMPOSE_ID = "00000000-0000-0000-0000-000000000000";

  function composeContent(name: string) {
    return {
      version: "1",
      agents: {
        [name]: {
          framework: "claude-code" as const,
          description: "BDD cli-auth compose agent",
        },
      },
    };
  }

  it("hides test-enable-connector in production", async () => {
    mockEnv("ENV", "production");
    const response = await authDevice.requestTestEnableConnector(
      {},
      { composeId: ZERO_COMPOSE_ID, connectorTypes: ["github"] },
      [404],
    );
    expect(response.body).toBe("Not found");
  });

  it("rejects malformed enable-connector requests with legacy errors", async () => {
    const invalidJson =
      await authDevice.requestTestEnableConnectorRaw("{ not json");
    expect(invalidJson.status).toBe(400);
    expect(invalidJson.body).toStrictEqual({ error: "Invalid JSON body" });

    for (const rawBody of [
      {},
      { composeId: "not-a-uuid", connectorTypes: ["github"] },
      { composeId: ZERO_COMPOSE_ID, connectorTypes: [] },
    ]) {
      const invalidBody = await authDevice.requestTestEnableConnectorRaw(
        JSON.stringify(rawBody),
      );
      expect(invalidBody.status).toBe(400);
      expect(invalidBody.body).toStrictEqual({
        error: "composeId and connectorTypes are required",
      });
    }

    const unknownTypes = await authDevice.requestTestEnableConnector(
      {},
      { composeId: ZERO_COMPOSE_ID, connectorTypes: ["not-a-real-connector"] },
      [400],
    );
    expect(unknownTypes.body).toStrictEqual({
      error: "Unknown connector types: not-a-real-connector",
    });

    const freshActor = bdd.user();
    authDevice.seedClerkDirectory(freshActor);
    const noOrg = await authDevice.requestTestEnableConnector(
      { email: freshActor.email },
      { composeId: ZERO_COMPOSE_ID, connectorTypes: ["github"] },
      [400],
    );
    expect(noOrg.body).toStrictEqual({
      error: "Test user has no org — run test-token first",
    });

    const actor = bdd.user();
    await authDevice.provisionTestOrg(actor);
    const missingCompose = await authDevice.requestTestEnableConnector(
      { email: actor.email },
      { composeId: ZERO_COMPOSE_ID, connectorTypes: ["github"] },
      [404],
    );
    expect(missingCompose.body).toStrictEqual({
      error: `Compose not found: ${ZERO_COMPOSE_ID}`,
    });
  });

  it("enables connectors on a compose visible through the agent user-connectors API", async () => {
    const actor = bdd.user();
    await authDevice.provisionTestOrg(actor);
    const compose = await authDevice.createCompose(
      actor,
      composeContent(`cli-auth-bdd-enable-${actor.userId.slice(-12)}`),
    );

    const enabled = await authDevice.requestTestEnableConnector(
      { email: actor.email },
      { composeId: compose.composeId, connectorTypes: ["github", "slack"] },
      [200],
    );
    expect(enabled.body).toStrictEqual({
      ok: true,
      composeId: compose.composeId,
      connectorTypes: ["github", "slack"],
    });

    const userConnectors = await authDevice.readUserConnectors(
      actor,
      compose.composeId,
    );
    expect([...userConnectors.enabledTypes].sort()).toStrictEqual([
      "github",
      "slack",
    ]);

    const customEmailCompose = await authDevice.createCompose(
      actor,
      composeContent(`cli-auth-bdd-custom-${actor.userId.slice(-12)}`),
    );
    await authDevice.requestTestEnableConnector(
      { email: "custom@test.com" },
      { composeId: customEmailCompose.composeId, connectorTypes: ["github"] },
      [200],
    );
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
      emailAddress: ["custom@test.com"],
    });
  });

  it("allows protected preview rewrites for enable-connector", async () => {
    const actor = bdd.user();
    await authDevice.provisionTestOrg(actor);
    const compose = await authDevice.createCompose(
      actor,
      composeContent(`cli-auth-bdd-preview-${actor.userId.slice(-12)}`),
    );

    mockEnv("ENV", "preview");
    mockOptionalEnv("USE_MOCK_CLAUDE", "true");
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");

    const enabled = await authDevice.requestTestEnableConnector(
      { email: actor.email },
      { composeId: compose.composeId, connectorTypes: ["github"] },
      [200],
    );
    expect(enabled.body).toStrictEqual({
      ok: true,
      composeId: compose.composeId,
      connectorTypes: ["github"],
    });
  });
});

describe("CLI-TEST: test-codex-oauth", () => {
  async function readCodexProvider(actor: ReturnType<typeof bdd.user>) {
    const providers = await misc.listModelProviders(actor);
    const provider = providers.body.modelProviders.find((candidate) => {
      return candidate.type === "codex-oauth-token";
    });
    if (!provider) {
      throw new Error("Expected codex-oauth-token provider in list");
    }
    return provider;
  }

  it("hides test-codex-oauth in production and allows preview rewrites", async () => {
    const actor = bdd.user();
    await authDevice.provisionTestOrg(actor);

    mockEnv("ENV", "production");
    const hidden = await authDevice.requestTestCodexOauth(
      {},
      LEGACY_CODEX_OAUTH_BODY,
      [404],
    );
    expect(hidden.body).toBe("Not found");

    mockEnv("ENV", "preview");
    mockOptionalEnv("USE_MOCK_CLAUDE", "true");
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
    const rewritten = await authDevice.requestTestCodexOauth(
      { email: actor.email },
      LEGACY_CODEX_OAUTH_BODY,
      [200],
    );
    if (rewritten.status !== 200) {
      throw new Error(
        `Expected preview-rewrite codex seed, got ${rewritten.status}`,
      );
    }
    expect(rewritten.body.orgId).toBe(actor.orgId);

    await authDevice.deleteOrgModelProvider(actor, "codex-oauth-token");
  });

  it("rejects malformed codex bodies and unprovisioned users", async () => {
    const invalidJson = await authDevice.requestTestCodexOauthRaw("{ not json");
    expect(invalidJson.status).toBe(400);
    expect(invalidJson.body).toStrictEqual({ error: "Invalid JSON body" });

    const invalidShape = await authDevice.requestTestCodexOauthRaw(
      JSON.stringify({ accessToken: "missing-others" }),
    );
    expect(invalidShape.status).toBe(400);
    expect(invalidShape.body).toStrictEqual({ error: "Invalid body shape" });

    const freshActor = bdd.user();
    authDevice.seedClerkDirectory(freshActor);
    const noOrg = await authDevice.requestTestCodexOauth(
      { email: freshActor.email },
      LEGACY_CODEX_OAUTH_BODY,
      [400],
    );
    expect(noOrg.body).toStrictEqual({
      error: "Test user has no org — run test-token first",
    });
  });

  it("seeds codex provider state visible through the model-providers API", async () => {
    const actor = bdd.user();
    await authDevice.provisionTestOrg(actor);

    const legacySeed = await authDevice.requestTestCodexOauth(
      {},
      {
        ...LEGACY_CODEX_OAUTH_BODY,
        expiresIn: 600,
        needsReconnect: true,
        lastRefreshErrorCode: "refresh_failed",
      },
      [200],
    );
    if (legacySeed.status !== 200) {
      throw new Error(`Expected codex legacy seed, got ${legacySeed.status}`);
    }
    expect(legacySeed.body.ok).toBeTruthy();
    expect(legacySeed.body.orgId).toBe(actor.orgId);
    expect(legacySeed.body.tokenExpiresAt).toBeDefined();
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
      emailAddress: [DEFAULT_TEST_EMAIL],
    });

    const legacyProvider = await readCodexProvider(actor);
    expect(legacyProvider).toMatchObject({
      authMethod: "auth_json",
      needsReconnect: true,
      lastRefreshErrorCode: "refresh_failed",
    });

    const preExpired = await authDevice.requestTestCodexOauth(
      {},
      { ...LEGACY_CODEX_OAUTH_BODY, expiresIn: -60 },
      [200],
    );
    if (preExpired.status !== 200) {
      throw new Error(`Expected pre-expired seed, got ${preExpired.status}`);
    }
    if (!preExpired.body.tokenExpiresAt) {
      throw new Error("Expected pre-expired tokenExpiresAt in response");
    }
    expect(Date.parse(preExpired.body.tokenExpiresAt)).toBeLessThan(now());

    const authJsonSeed = await authDevice.requestTestCodexOauth(
      {},
      { authJson: makeCodexAuthJson() },
      [200],
    );
    if (authJsonSeed.status !== 200) {
      throw new Error(`Expected auth.json seed, got ${authJsonSeed.status}`);
    }
    expect(authJsonSeed.body.tokenExpiresAt).toBeDefined();
    const pastedProvider = await readCodexProvider(actor);
    expect(pastedProvider).toMatchObject({
      authMethod: "auth_json",
      workspaceName: "Acme",
      planType: "plus",
      needsReconnect: false,
      lastRefreshErrorCode: null,
    });

    await authDevice.requestTestCodexOauth(
      {},
      {
        authJson: makeCodexAuthJson({
          workspaceName: "Acme Preserved",
          planType: "business",
        }),
      },
      [200],
    );
    await authDevice.requestTestCodexOauth(
      {},
      { ...LEGACY_CODEX_OAUTH_BODY, expiresIn: 600 },
      [200],
    );
    const preservedProvider = await readCodexProvider(actor);
    expect(preservedProvider).toMatchObject({
      workspaceName: "Acme Preserved",
      planType: "business",
      needsReconnect: false,
      lastRefreshErrorCode: null,
    });

    const malformed = await authDevice.requestTestCodexOauth(
      {},
      { authJson: "{ not json" },
      [400],
    );
    expect(malformed.body).toStrictEqual({
      error: "auth.json shape invalid: auth.json is not valid JSON",
    });

    const freePlan = await authDevice.requestTestCodexOauth(
      {},
      { authJson: makeCodexAuthJson({ planType: "free" }) },
      [400],
    );
    expect(freePlan.body).toStrictEqual({
      error: "Free plan rejected by parser",
    });

    await authDevice.requestTestCodexOauth(
      { email: "custom@test.com" },
      LEGACY_CODEX_OAUTH_BODY,
      [200],
    );
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
      emailAddress: ["custom@test.com"],
    });

    await authDevice.deleteOrgModelProvider(actor, "codex-oauth-token");
  });
});
