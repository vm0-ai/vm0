import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import {
  createAuthOrgAgentsBddApi,
  type ApiTestUser,
} from "./helpers/api-bdd-auth-org";
import { expectApiError } from "./helpers/api-bdd";
import { createUserConfigBddApi } from "./helpers/api-bdd-user-config";

/*
Round-5 cluster auth-03 (AUTH-01/AUTH-03): user-owned configuration plus the
auth probe matrix. State is constructed only through public APIs (onboarding,
api-keys, secrets, variables, agents, composes); the only mocks are the Clerk
SDK boundary and the S3 accept for agent creation. Sandbox/zero/forged-PAT
bearers are minted with the exported test token signers (api-bdd-github and
api-bdd-computer-use precedent).
*/

const context = testContext();
const api = createAuthOrgAgentsBddApi(context);
const cfg = createUserConfigBddApi(context);

afterEach(() => {
  clearMockNow();
});

function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 10);
}

function slug(prefix: string): string {
  return `${prefix}-${shortId()}`;
}

function upperName(prefix: string): string {
  return `${prefix}_${shortId().toUpperCase()}`;
}

async function onboardAdmin(
  admin: ApiTestUser,
  options: { readonly slug?: string } = {},
): Promise<string> {
  const orgState: { slug?: string } = {};
  if (options.slug !== undefined) {
    orgState.slug = options.slug;
  }
  api.mockClerkOrg(admin, orgState);
  const setup = await api.setupOnboarding(admin, {
    displayName: "BDD User Config Agent",
    workspaceName: "BDD User Config Workspace",
    sound: "calm",
    timezone: "UTC",
    role: "engineering",
  });
  if (setup.status !== 200 && setup.status !== 409) {
    throw new Error(
      `Expected onboarding setup to succeed, got ${setup.status}`,
    );
  }
  return setup.body.agentId;
}

describe("AUTH-03 user config CRUD error boundaries", () => {
  it("isolates secret, variable, and api-key deletion across users and missing names", async () => {
    const admin = api.user();
    const member = api.user({ orgId: admin.orgId, orgRole: "org:member" });
    await onboardAdmin(admin, { slug: slug("bdd-uc-a1") });

    const secretName = upperName("BDD_UC_SECRET");
    await api.setSecret(admin, {
      name: secretName,
      value: "uc-secret-value",
    });
    const missingSecret = await cfg.requestDeleteSecret(
      admin,
      "NONEXISTENT",
      [404],
    );
    expectApiError(missingSecret.body);
    expect(missingSecret.body.error).toStrictEqual({
      message: 'Secret "NONEXISTENT" not found',
      code: "NOT_FOUND",
    });
    const crossUserSecret = await cfg.requestDeleteSecret(
      member,
      secretName,
      [404],
    );
    expectApiError(crossUserSecret.body);
    expect(crossUserSecret.body.error.code).toBe("NOT_FOUND");
    const secretsAfter = await api.listSecrets(admin);
    expect(
      secretsAfter.secrets.some((candidate) => {
        return candidate.name === secretName;
      }),
    ).toBeTruthy();

    const variableName = upperName("BDD_UC_VARIABLE");
    await api.setVariable(admin, {
      name: variableName,
      value: "uc-variable-value",
    });
    const missingVariable = await cfg.requestDeleteVariable(
      admin,
      "NONEXISTENT",
      [404],
    );
    expectApiError(missingVariable.body);
    expect(missingVariable.body.error).toStrictEqual({
      message: 'Variable "NONEXISTENT" not found',
      code: "NOT_FOUND",
    });
    const crossUserVariable = await cfg.requestDeleteVariable(
      member,
      variableName,
      [404],
    );
    expectApiError(crossUserVariable.body);
    expect(crossUserVariable.body.error.code).toBe("NOT_FOUND");
    const variablesAfter = await api.listVariables(admin);
    expect(
      variablesAfter.variables.some((candidate) => {
        return candidate.name === variableName;
      }),
    ).toBeTruthy();

    const created = await api.createApiKey(admin, {
      name: "BDD UC key",
      expiresInDays: 7,
    });
    const missingKey = await cfg.requestDeleteApiKey(
      admin,
      randomUUID(),
      [404],
    );
    expectApiError(missingKey.body);
    expect(missingKey.body.error).toStrictEqual({
      message: "API key not found",
      code: "NOT_FOUND",
    });
    const crossUserKey = await cfg.requestDeleteApiKey(
      member,
      created.id,
      [404],
    );
    expectApiError(crossUserKey.body);
    expect(crossUserKey.body.error.code).toBe("NOT_FOUND");
    const keysAfter = await api.listApiKeys(admin);
    expect(
      keysAfter.apiKeys.some((candidate) => {
        return candidate.id === created.id;
      }),
    ).toBeTruthy();
  });

  it("rejects invalid config bodies and missing org context with 400s", async () => {
    const admin = api.user();
    const noOrg = api.user({ orgId: null });
    await onboardAdmin(admin, { slug: slug("bdd-uc-a2") });

    const invalidVariable = await cfg.requestSetVariable(
      admin,
      { name: "invalid name", value: "v" },
      [400],
    );
    expectApiError(invalidVariable.body);
    expect(invalidVariable.body.error.code).toBe("BAD_REQUEST");

    const noOrgKey = await api.requestCreateApiKey(
      noOrg,
      { name: "k", expiresInDays: 7 },
      [400],
    );
    expectApiError(noOrgKey.body);
    expect(noOrgKey.body.error).toStrictEqual({
      message: "Explicit org context required — ensure active org in session",
      code: "BAD_REQUEST",
    });

    const emptyKeyName = await api.requestCreateApiKey(
      admin,
      { name: "", expiresInDays: 90 },
      [400],
    );
    expectApiError(emptyKeyName.body);
    expect(emptyKeyName.body.error.code).toBe("BAD_REQUEST");

    const zeroExpiry = await api.requestCreateApiKey(
      admin,
      { name: "k", expiresInDays: 0 },
      [400],
    );
    expectApiError(zeroExpiry.body);
    expect(zeroExpiry.body.error.code).toBe("BAD_REQUEST");

    const invalidPush = await cfg.requestRegisterPush(
      admin,
      { endpoint: "not-a-url", keys: { p256dh: "", auth: "" } },
      [400],
    );
    expectApiError(invalidPush.body);
    expect(invalidPush.body.error.code).toBe("BAD_REQUEST");

    const invalidTimezone = await cfg.requestUpdatePreferences(
      admin,
      { timezone: "Invalid/Timezone" },
      [400],
    );
    expectApiError(invalidTimezone.body);
    expect(invalidTimezone.body.error).toStrictEqual({
      message: "Invalid request",
      code: "BAD_REQUEST",
    });

    const emptyPreferences = await cfg.requestUpdatePreferences(
      admin,
      {},
      [400],
    );
    expectApiError(emptyPreferences.body);
    expect(emptyPreferences.body.error.code).toBe("BAD_REQUEST");
  });
});

describe("AUTH-03 agent user connectors", () => {
  it("replaces, dedupes, clears, validates, and isolates per-agent user connectors", async () => {
    const admin = api.user();
    const otherAdmin = api.user();
    await onboardAdmin(admin, { slug: slug("bdd-uc-b1") });
    api.acceptAgentStorageWrites();
    const agent = await api.createAgent(admin, {
      displayName: "BDD Connector Agent",
    });

    const set = await cfg.updateUserConnectors(admin, agent.agentId, [
      "github",
      "slack",
    ]);
    expect(new Set(set.enabledTypes)).toStrictEqual(
      new Set(["github", "slack"]),
    );
    const readBack = await cfg.readUserConnectors(admin, agent.agentId);
    expect(new Set(readBack.enabledTypes)).toStrictEqual(
      new Set(["github", "slack"]),
    );

    const deduped = await cfg.updateUserConnectors(admin, agent.agentId, [
      "slack",
      "github",
      "slack",
    ]);
    expect(deduped.enabledTypes).toHaveLength(2);
    expect(new Set(deduped.enabledTypes)).toStrictEqual(
      new Set(["github", "slack"]),
    );

    const replaced = await cfg.updateUserConnectors(admin, agent.agentId, [
      "linear",
    ]);
    expect(replaced.enabledTypes).toStrictEqual(["linear"]);
    const readReplaced = await cfg.readUserConnectors(admin, agent.agentId);
    expect(readReplaced.enabledTypes).toStrictEqual(["linear"]);

    const cleared = await cfg.updateUserConnectors(admin, agent.agentId, []);
    expect(cleared.enabledTypes).toStrictEqual([]);
    const readCleared = await cfg.readUserConnectors(admin, agent.agentId);
    expect(readCleared.enabledTypes).toStrictEqual([]);

    const invalid = await cfg.requestUpdateUserConnectors(
      admin,
      agent.agentId,
      ["github", "not-a-connector"],
      [400],
    );
    expectApiError(invalid.body);
    expect(invalid.body.error).toStrictEqual({
      message: "Invalid connector types: not-a-connector",
      code: "VALIDATION_ERROR",
    });

    const gated = await cfg.requestUpdateUserConnectors(
      admin,
      agent.agentId,
      ["bentoml"],
      [400],
    );
    expectApiError(gated.body);
    expect(gated.body.error).toStrictEqual({
      message: "Connector types are not available: bentoml",
      code: "VALIDATION_ERROR",
    });
    const readAfterGated = await cfg.readUserConnectors(admin, agent.agentId);
    expect(readAfterGated.enabledTypes).toStrictEqual([]);

    const missingAgentId = randomUUID();
    const missingRead = await cfg.requestReadUserConnectors(
      admin,
      missingAgentId,
      [404],
    );
    expectApiError(missingRead.body);
    expect(missingRead.body.error.code).toBe("NOT_FOUND");
    const missingUpdate = await cfg.requestUpdateUserConnectors(
      admin,
      missingAgentId,
      ["github"],
      [404],
    );
    expectApiError(missingUpdate.body);
    expect(missingUpdate.body.error.code).toBe("NOT_FOUND");

    const crossOrgRead = await cfg.requestReadUserConnectors(
      otherAdmin,
      agent.agentId,
      [404],
    );
    expectApiError(crossOrgRead.body);
    expect(crossOrgRead.body.error.code).toBe("NOT_FOUND");

    const pat = await api.createApiKey(admin, {
      name: "BDD UC PAT",
      expiresInDays: 7,
    });
    cfg.mockMembership(admin, "org:admin");
    const patSet = await cfg.updateUserConnectors(
      { bearer: pat.token },
      agent.agentId,
      ["github"],
    );
    expect(patSet.enabledTypes).toStrictEqual(["github"]);
    const readAfterPat = await cfg.readUserConnectors(admin, agent.agentId);
    expect(readAfterPat.enabledTypes).toStrictEqual(["github"]);
  });

  it("recomposes a stale compose-target on user-connector updates through public APIs", async () => {
    const admin = api.user();
    await onboardAdmin(admin, { slug: slug("bdd-uc-b1c") });
    const composeName = slug("bdd-uc-compose");
    const created = await api.createCompose(
      admin,
      api.composeContent(composeName),
    );

    // A compose without a zero-agent row only accepts the empty replace
    // (user_connectors.agent_id FK references zero_agents); the empty set
    // still walks the visible-joined lookup and the stale recompose arm.
    const updated = await cfg.updateUserConnectors(
      admin,
      created.composeId,
      [],
    );
    expect(updated.enabledTypes).toStrictEqual([]);

    const compose = await api.readComposeById(admin, created.composeId);
    expect(compose.headVersionId).not.toBe(created.versionId);
    expect(compose.headVersionId).toMatch(/^[a-f0-9]{64}$/);

    const getOnCompose = await cfg.requestReadUserConnectors(
      admin,
      created.composeId,
      [404],
    );
    expectApiError(getOnCompose.body);
    expect(getOnCompose.body.error.code).toBe("NOT_FOUND");
  });
});

describe("AUTH-03 user model preference", () => {
  it("defaults, updates, validates, and clears the user model preference", async () => {
    const admin = api.user();
    await onboardAdmin(admin, { slug: slug("bdd-uc-b2") });

    const defaults = await cfg.readModelPreference(admin);
    expect(defaults).toStrictEqual({ selectedModel: null, updatedAt: null });

    const updated = await cfg.updateModelPreference(admin, {
      selectedModel: "claude-sonnet-4-6",
    });
    expect(updated.selectedModel).toBe("claude-sonnet-4-6");
    expect(updated.updatedAt).toStrictEqual(expect.any(String));
    const readUpdated = await cfg.readModelPreference(admin);
    expect(readUpdated).toStrictEqual(updated);

    const unconfigured = await cfg.requestUpdateModelPreference(
      admin,
      { selectedModel: "gpt-5.4" },
      [400],
    );
    expectApiError(unconfigured.body);
    expect(unconfigured.body.error).toStrictEqual({
      message: "Invalid request",
      code: "BAD_REQUEST",
    });
    const readAfterRejected = await cfg.readModelPreference(admin);
    expect(readAfterRejected).toStrictEqual(updated);

    const cleared = await cfg.updateModelPreference(admin, {
      selectedModel: null,
    });
    expect(cleared).toStrictEqual({ selectedModel: null, updatedAt: null });
    const readCleared = await cfg.readModelPreference(admin);
    expect(readCleared).toStrictEqual({ selectedModel: null, updatedAt: null });
  });

  it("rejects contract-invalid model preference bodies and unauthenticated access", async () => {
    const admin = api.user();
    const noOrg = api.user({ orgId: null });

    const emptyBody = await cfg.rawUpdateModelPreference(admin, {}, [400]);
    expectApiError(emptyBody.body);
    expect(emptyBody.body.error.code).toBe("BAD_REQUEST");
    expect(emptyBody.body.error.message).toContain(
      "selectedModel: Invalid option",
    );

    const removedModel = await cfg.rawUpdateModelPreference(
      admin,
      { selectedModel: "claude-haiku-4-5" },
      [400],
    );
    expectApiError(removedModel.body);
    expect(removedModel.body.error.code).toBe("BAD_REQUEST");
    expect(removedModel.body.error.message).toContain(
      "selectedModel: Invalid option",
    );

    const unauthenticated = await cfg.requestReadModelPreference(null, [401]);
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    const noOrgRead = await cfg.requestReadModelPreference(noOrg, [401]);
    expectApiError(noOrgRead.body);
    expect(noOrgRead.body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("AUTH-01 auth probe sessions", () => {
  it("resolves clerk sessions and rejects missing or non-bearer credentials", async () => {
    const admin = api.user();
    const member = api.user({ orgRole: "org:member" });
    const solo = api.user({ orgId: null });
    const cookie = "__session=opaque";

    cfg.mockSession(admin);
    const adminProbe = await cfg.probeAuth({ cookie }, {}, [200]);
    expect(adminProbe.body).toStrictEqual({
      tokenType: "session",
      userId: admin.userId,
      orgId: admin.orgId,
      orgRole: "admin",
    });

    cfg.mockSession(member);
    const memberProbe = await cfg.probeAuth({ cookie }, {}, [200]);
    expect(memberProbe.body).toStrictEqual({
      tokenType: "session",
      userId: member.userId,
      orgId: member.orgId,
      orgRole: "member",
    });

    cfg.mockSession(solo);
    const soloProbe = await cfg.probeAuth({ cookie }, {}, [200]);
    expect(soloProbe.body).toStrictEqual({
      tokenType: "session",
      userId: solo.userId,
    });

    cfg.mockSession(null);
    const unauthenticated = await cfg.probeAuth({ cookie }, {}, [401]);
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const noCredentials = await cfg.probeAuth({}, {}, [401]);
    expectApiError(noCredentials.body);
    expect(noCredentials.body.error.code).toBe("UNAUTHORIZED");

    const basicHeader = await cfg.probeAuth(
      { authorization: "Basic dXNlcjpwYXNz" },
      {},
      [401],
    );
    expectApiError(basicHeader.body);
    expect(basicHeader.body.error.code).toBe("UNAUTHORIZED");

    const emptyBearer = await cfg.probeAuth(
      { authorization: "Bearer " },
      {},
      [401],
    );
    expectApiError(emptyBearer.body);
    expect(emptyBearer.body.error.code).toBe("UNAUTHORIZED");

    cfg.mockSession(member);
    const unknownShapeWithCookie = await cfg.probeAuth(
      { authorization: "Bearer some-unknown-token-format", cookie },
      {},
      [200],
    );
    expect(unknownShapeWithCookie.body).toStrictEqual({
      tokenType: "session",
      userId: member.userId,
      orgId: member.orgId,
      orgRole: "member",
    });

    cfg.mockSession(null);
    const unknownShapeNoCookie = await cfg.probeAuth(
      { authorization: "Bearer some-unknown-token-format" },
      {},
      [401],
    );
    expectApiError(unknownShapeNoCookie.body);
    expect(unknownShapeNoCookie.body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("AUTH-02 auth probe PAT bearers", () => {
  it("resolves api-key bearers with membership roles from clerk", async () => {
    const admin = api.user();
    const memberUser = api.user({ orgRole: "org:member" });
    const orphan = api.user();

    const adminKey = await api.createApiKey(admin, {
      name: "BDD probe admin key",
      expiresInDays: 7,
    });
    cfg.mockMembership(admin, "org:admin");
    const adminProbe = await cfg.probeAuth(
      { authorization: `Bearer ${adminKey.token}` },
      {},
      [200],
    );
    expect(adminProbe.body).toStrictEqual({
      tokenType: "pat",
      userId: admin.userId,
      orgId: admin.orgId,
      orgRole: "admin",
    });

    const memberKey = await api.createApiKey(memberUser, {
      name: "BDD probe member key",
      expiresInDays: 7,
    });
    cfg.mockMembership(memberUser, "org:member");
    const memberProbe = await cfg.probeAuth(
      { authorization: `Bearer ${memberKey.token}` },
      {},
      [200],
    );
    expect(memberProbe.body).toStrictEqual({
      tokenType: "pat",
      userId: memberUser.userId,
      orgId: memberUser.orgId,
      orgRole: "member",
    });

    const orphanKey = await api.createApiKey(orphan, {
      name: "BDD probe orphan key",
      expiresInDays: 7,
    });
    cfg.mockMembership(orphan, null);
    const orphanProbe = await cfg.probeAuth(
      { authorization: `Bearer ${orphanKey.token}` },
      {},
      [200],
    );
    expect(orphanProbe.body).toStrictEqual({
      tokenType: "pat",
      userId: orphan.userId,
    });
  });

  it("serves cached membership inside the ttl and drops stale rows through the api", async () => {
    const admin = api.user();
    const base = now();
    mockNow(base);
    const key = await api.createApiKey(admin, {
      name: "BDD probe cache key",
      expiresInDays: 7,
    });
    const bearer = { authorization: `Bearer ${key.token}` };

    cfg.mockMembership(admin, "org:admin");
    const first = await cfg.probeAuth(bearer, {}, [200]);
    expect(first.body).toStrictEqual({
      tokenType: "pat",
      userId: admin.userId,
      orgId: admin.orgId,
      orgRole: "admin",
    });

    cfg.mockMembership(admin, null);
    mockNow(base + 30_000);
    const cached = await cfg.probeAuth(bearer, {}, [200]);
    expect(cached.body).toStrictEqual(first.body);

    mockNow(base + 120_000);
    const stale = await cfg.probeAuth(bearer, {}, [200]);
    expect(stale.body).toStrictEqual({
      tokenType: "pat",
      userId: admin.userId,
    });

    cfg.mockMembership(admin, "org:admin");
    const refreshed = await cfg.probeAuth(bearer, {}, [200]);
    expect(refreshed.body).toStrictEqual(first.body);
  });

  it("rejects revoked api-key bearers even when a valid clerk cookie rides along", async () => {
    const admin = api.user();
    const key = await api.createApiKey(admin, {
      name: "BDD probe revoked key",
      expiresInDays: 7,
    });
    cfg.mockMembership(admin, "org:admin");
    const before = await cfg.probeAuth(
      { authorization: `Bearer ${key.token}` },
      {},
      [200],
    );
    expect(before.body).toMatchObject({ tokenType: "pat" });

    await api.deleteApiKey(admin, key.id);
    cfg.mockSession(null);
    const revoked = await cfg.probeAuth(
      { authorization: `Bearer ${key.token}` },
      {},
      [401],
    );
    expectApiError(revoked.body);
    expect(revoked.body.error.code).toBe("UNAUTHORIZED");

    cfg.mockSession(admin);
    const revokedWithCookie = await cfg.probeAuth(
      { authorization: `Bearer ${key.token}`, cookie: "__session=opaque" },
      {},
      [401],
    );
    expectApiError(revokedWithCookie.body);
    expect(revokedWithCookie.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects forged and malformed pat bearers", async () => {
    cfg.mockSession(null);

    const forged = await cfg.probeAuth(
      {
        authorization: `Bearer ${cfg.forgedPatBearer(`user_${randomUUID()}`)}`,
      },
      {},
      [401],
    );
    expectApiError(forged.body);
    expect(forged.body.error.code).toBe("UNAUTHORIZED");

    const garbage = await cfg.probeAuth(
      { authorization: "Bearer vm0_pat_garbage" },
      {},
      [401],
    );
    expectApiError(garbage.body);
    expect(garbage.body.error.code).toBe("UNAUTHORIZED");
  });

  it("expires api keys by their db expiry under mocked time", async () => {
    const admin = api.user();
    const base = now();
    mockNow(base);
    const key = await api.createApiKey(admin, {
      name: "BDD probe expiring key",
      expiresInDays: 1,
    });
    cfg.mockMembership(admin, "org:admin");
    const fresh = await cfg.probeAuth(
      { authorization: `Bearer ${key.token}` },
      {},
      [200],
    );
    expect(fresh.body).toMatchObject({ tokenType: "pat" });

    mockNow(base + 2 * 24 * 60 * 60 * 1000);
    const expired = await cfg.probeAuth(
      { authorization: `Bearer ${key.token}` },
      {},
      [401],
    );
    expectApiError(expired.body);
    expect(expired.body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("AUTH-01 sandbox and zero bearers", () => {
  it("resolves sandbox and zero bearers on the auth probe by capability opt-in", async () => {
    const sandboxActor = api.user();
    const zeroMember = api.user();
    const zeroAdmin = api.user();
    const zeroOrphan = api.user();
    cfg.mockSession(null);

    const sandbox = cfg.sandboxBearer(sandboxActor);
    const rejected = await cfg.probeAuth(
      { authorization: `Bearer ${sandbox.token}` },
      {},
      [403],
    );
    expectApiError(rejected.body);
    expect(rejected.body).toStrictEqual({
      error: {
        message: "This endpoint is not available for sandbox tokens",
        code: "FORBIDDEN",
      },
    });

    const accepted = await cfg.probeAuth(
      { authorization: `Bearer ${sandbox.token}` },
      { acceptAnySandboxCapability: "true" },
      [200],
    );
    expect(accepted.body).toStrictEqual({
      tokenType: "sandbox",
      userId: sandboxActor.userId,
      orgId: sandboxActor.orgId,
      runId: sandbox.runId,
    });

    const memberZero = cfg.zeroBearer(zeroMember, ["file:read"]);
    cfg.mockMembership(zeroMember, "org:member");
    const memberProbe = await cfg.probeAuth(
      { authorization: `Bearer ${memberZero.token}` },
      { acceptAnySandboxCapability: "true" },
      [200],
    );
    expect(memberProbe.body).toStrictEqual({
      tokenType: "zero",
      userId: zeroMember.userId,
      orgId: zeroMember.orgId,
      orgRole: "member",
      runId: memberZero.runId,
      capabilities: ["file:read"],
    });

    const adminZero = cfg.zeroBearer(zeroAdmin, ["file:read", "file:write"]);
    cfg.mockMembership(zeroAdmin, "org:admin");
    const adminProbe = await cfg.probeAuth(
      { authorization: `Bearer ${adminZero.token}` },
      { acceptAnySandboxCapability: "true" },
      [200],
    );
    expect(adminProbe.body).toStrictEqual({
      tokenType: "zero",
      userId: zeroAdmin.userId,
      orgId: zeroAdmin.orgId,
      orgRole: "admin",
      runId: adminZero.runId,
      capabilities: ["file:read", "file:write"],
    });

    const orphanZero = cfg.zeroBearer(zeroOrphan, ["file:read"]);
    cfg.mockMembership(zeroOrphan, null);
    const orphanProbe = await cfg.probeAuth(
      { authorization: `Bearer ${orphanZero.token}` },
      { acceptAnySandboxCapability: "true" },
      [200],
    );
    expect(orphanProbe.body).toStrictEqual({
      tokenType: "zero",
      userId: zeroOrphan.userId,
      runId: orphanZero.runId,
    });

    const badSignature = await cfg.probeAuth(
      { authorization: "Bearer vm0_sandbox_not-a-real-token" },
      {},
      [401],
    );
    expectApiError(badSignature.body);
    expect(badSignature.body.error.code).toBe("UNAUTHORIZED");
  });

  it("enforces zero capabilities on real user-config routes", async () => {
    const admin = api.user();
    api.acceptAgentStorageWrites();
    const agent = await api.createAgent(admin, {
      displayName: "BDD Zero Cap Agent",
    });
    cfg.mockMembership(admin, "org:admin");

    const readCap = cfg.zeroBearer(admin, ["agent:read"]);
    const updated = await cfg.updateUserConnectors(
      { bearer: readCap.token },
      agent.agentId,
      ["github"],
    );
    expect(updated.enabledTypes).toStrictEqual(["github"]);
    const readBack = await cfg.readUserConnectors(admin, agent.agentId);
    expect(readBack.enabledTypes).toStrictEqual(["github"]);

    const fileCap = cfg.zeroBearer(admin, ["file:read"]);
    const forbidden = await cfg.requestUpdateUserConnectors(
      { bearer: fileCap.token },
      agent.agentId,
      ["github"],
      [403],
    );
    expectApiError(forbidden.body);
    expect(forbidden.body).toStrictEqual({
      error: {
        message: "Missing required capability: agent:read",
        code: "FORBIDDEN",
      },
    });

    const pushForbidden = await cfg.requestRegisterPush(
      { bearer: fileCap.token },
      {
        endpoint: "https://push.example.test/subscription",
        keys: { p256dh: "p256dh-key", auth: "auth-key" },
      },
      [403],
    );
    expectApiError(pushForbidden.body);
    expect(pushForbidden.body).toStrictEqual({
      error: {
        message: "This endpoint is not available for sandbox tokens",
        code: "FORBIDDEN",
      },
    });
  });

  it("accepts sandbox and zero bearers on auth me", async () => {
    const sandboxActor = api.user();
    const writeActor = api.user();
    const bareActor = api.user();
    cfg.mockSession(null);

    cfg.mockClerkUsers([sandboxActor]);
    const sandbox = cfg.sandboxBearer(sandboxActor);
    const sandboxMe = await cfg.readMe({ bearer: sandbox.token });
    expect(sandboxMe).toStrictEqual({
      userId: sandboxActor.userId,
      email: sandboxActor.email,
    });

    cfg.mockClerkUsers([writeActor]);
    cfg.mockMembership(writeActor, null);
    const zeroWrite = cfg.zeroBearer(writeActor, ["file:write"]);
    const zeroWriteMe = await cfg.readMe({ bearer: zeroWrite.token });
    expect(zeroWriteMe).toStrictEqual({
      userId: writeActor.userId,
      email: writeActor.email,
    });

    cfg.mockClerkUsers([bareActor]);
    cfg.mockMembership(bareActor, null);
    const zeroBare = cfg.zeroBearer(bareActor, []);
    const zeroBareMe = await cfg.readMe({ bearer: zeroBare.token });
    expect(zeroBareMe).toStrictEqual({
      userId: bareActor.userId,
      email: bareActor.email,
    });
  });

  it("serves auth me from the fresh user cache and refreshes after the ttl", async () => {
    const admin = api.user();
    const base = now();
    mockNow(base);

    cfg.mockClerkUsers([admin]);
    const first = await cfg.readMe(admin);
    expect(first).toStrictEqual({ userId: admin.userId, email: admin.email });

    const rotatedEmail = `rotated-${shortId()}@example.test`;
    cfg.mockClerkUsers([{ ...admin, email: rotatedEmail }]);
    const cached = await cfg.readMe(admin);
    expect(cached.email).toBe(admin.email);

    mockNow(base + 16 * 60 * 1000);
    const refreshed = await cfg.readMe(admin);
    expect(refreshed.email).toBe(rotatedEmail);
  });
});
