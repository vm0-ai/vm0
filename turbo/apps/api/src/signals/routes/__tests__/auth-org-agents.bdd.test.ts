import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-helpers";
import {
  createAuthOrgAgentsBddApi,
  type ApiTestUser,
} from "./helpers/api-bdd-auth-org";
import { createBddApi, expectApiError } from "./helpers/api-bdd";
import { createRunsSchedulesApi } from "./helpers/api-bdd-runs-schedules";

/*
helper gap:
- AUTH-02 device, desktop, sandbox, zero, realtime, and run-scoped token flows
  need a dedicated token helper; this file covers the public API key token flow
  end to end through create, use, list, and revoke.
- AUTH-03 built-in/user connector and push subscription flows need their own
  domain helpers; this file covers user-owned API keys, secrets, variables,
  preferences, and org custom connector safe metadata.
- ORG-01 logo upload/delete needs a multipart org-logo helper.
- AGENT-02 has no default-agent GET route; assertions use onboarding status as
  the visible read model for the selected default agent.
*/

const context = testContext();
const api = createAuthOrgAgentsBddApi(context);
const bdd = createBddApi(context);
const runsApi = createRunsSchedulesApi(context);

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
  options: {
    readonly displayName?: string;
    readonly workspaceName?: string;
    readonly slug?: string;
    readonly name?: string;
  } = {},
): Promise<string> {
  const orgState: { slug?: string; name?: string } = {};
  if (options.slug !== undefined) {
    orgState.slug = options.slug;
  }
  const orgName = options.name ?? options.workspaceName;
  if (orgName !== undefined) {
    orgState.name = orgName;
  }
  api.mockClerkOrg(admin, orgState);
  const setup = await api.setupOnboarding(admin, {
    displayName: options.displayName ?? "BDD Default Agent",
    workspaceName: options.workspaceName ?? "BDD Workspace",
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

describe("AUTH-01, ORG-03, AGENT-02, CHAIN-AGENT", () => {
  it("chains current identity, onboarding, default agent selection, and later agent reads", async () => {
    const admin = api.user();
    const noOrg = api.user({ orgId: null });
    const orgSlug = slug("bdd-chain");
    api.acceptAgentStorageWrites();
    api.mockClerkOrg(admin, { slug: orgSlug, name: "BDD Chain Org" });

    const me = await api.readMe(admin);
    expect(me).toStrictEqual({ userId: admin.userId, email: admin.email });

    const org = await api.readOrg(admin);
    expect(org).toMatchObject({
      id: admin.orgId,
      slug: orgSlug,
      name: "BDD Chain Org",
      role: "admin",
    });

    const missingOrg = await api.requestReadOrg(noOrg, [404]);
    expectApiError(missingOrg.body);
    expect(missingOrg.body.error.code).toBe("NOT_FOUND");

    const noOrgAgent = await api.requestCreateAgent(
      noOrg,
      { displayName: "No Org Agent" },
      [401],
    );
    expectApiError(noOrgAgent.body);
    expect(noOrgAgent.body.error.code).toBe("UNAUTHORIZED");

    const before = await api.readOnboardingStatus(admin);
    expect(before).toMatchObject({
      needsOnboarding: true,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: false,
      defaultAgentId: null,
    });

    const defaultAgentId = await onboardAdmin(admin, {
      displayName: "BDD Default Agent",
      workspaceName: "BDD Chain Org",
      slug: orgSlug,
      name: "BDD Chain Org",
    });

    const after = await api.readOnboardingStatus(admin);
    expect(after.hasDefaultAgent).toBeTruthy();
    expect(after.defaultAgentId).toBe(defaultAgentId);
    expect(after.defaultAgentMetadata).toMatchObject({
      displayName: "BDD Default Agent",
      sound: "calm",
    });

    const defaultAgent = await api.readAgent(admin, defaultAgentId);
    expect(defaultAgent.displayName).toBe("BDD Default Agent");

    const repeatedSetup = await api.setupOnboarding(admin, {
      displayName: "BDD Default Agent Repeated",
      workspaceName: "BDD Chain Org",
    });
    if (repeatedSetup.status !== 200 && repeatedSetup.status !== 409) {
      throw new Error(
        `Expected repeated onboarding setup to be idempotent, got ${repeatedSetup.status}`,
      );
    }
    expect(repeatedSetup.body.agentId).toBe(defaultAgentId);
    const afterRepeatedSetup = await api.listAgents(admin);
    expect(
      afterRepeatedSetup.filter((agent) => {
        return agent.agentId === defaultAgentId;
      }),
    ).toHaveLength(1);

    const created = await api.createAgent(admin, {
      displayName: "BDD Secondary Agent",
      description: "Created after onboarding",
      visibility: "public",
    });
    const listed = await api.listAgents(admin);
    expect(
      listed.some((agent) => {
        return agent.agentId === created.agentId;
      }),
    ).toBeTruthy();

    const selected = await api.requestSetDefaultAgent(
      admin,
      created.agentId,
      [409],
    );
    expectApiError(selected.body);
    expect(selected.body.error.code).toBe("CONFLICT");
    const selectedStatus = await api.readOnboardingStatus(admin);
    expect(selectedStatus.defaultAgentId).toBe(defaultAgentId);

    const updated = await api.updateAgentMetadata(admin, created.agentId, {
      displayName: "BDD Secondary Agent Updated",
      description: "Updated through metadata API",
      visibility: "private",
    });
    expect(updated).toMatchObject({
      agentId: created.agentId,
      displayName: "BDD Secondary Agent Updated",
      description: "Updated through metadata API",
      visibility: "private",
    });

    await api.deleteAgent(admin, created.agentId);
    const deleted = await api.requestReadAgent(admin, created.agentId, [404]);
    expectApiError(deleted.body);
    expect(deleted.body.error.code).toBe("NOT_FOUND");
  });
});

describe("AUTH-02 and AUTH-03", () => {
  it("issues a CLI API key, exposes safe metadata, authorizes API use, and revokes it", async () => {
    const admin = api.user();
    await onboardAdmin(admin, { slug: slug("bdd-key") });

    const created = await api.createApiKey(admin, {
      name: "BDD CLI token",
      expiresInDays: 7,
    });
    expect(created.token).toContain(".");
    expect(created.tokenPrefix.length).toBeGreaterThan(4);

    const listed = await api.listApiKeys(admin);
    const metadata = listed.apiKeys.find((key) => {
      return key.id === created.id;
    });
    expect(metadata).toBeDefined();
    if (!metadata) {
      throw new Error("created API key was not listed");
    }
    expect(metadata.name).toBe("BDD CLI token");
    expect("token" in metadata).toBeFalsy();

    const tokenMe = await api.requestReadMeWithBearer(
      created.token,
      admin,
      [200],
    );
    expect(tokenMe.body).toStrictEqual({
      userId: admin.userId,
      email: admin.email,
    });

    await api.deleteApiKey(admin, created.id);
    const afterDelete = await api.listApiKeys(admin);
    expect(
      afterDelete.apiKeys.some((key) => {
        return key.id === created.id;
      }),
    ).toBeFalsy();

    const revoked = await api.requestReadMeWithBearer(
      created.token,
      admin,
      [401],
    );
    expectApiError(revoked.body);
    expect(revoked.body.error.code).toBe("UNAUTHORIZED");
  });

  it("manages user-owned secrets, variables, and preferences through safe visible reads", async () => {
    const admin = api.user();
    await onboardAdmin(admin, { slug: slug("bdd-config") });

    const secretName = upperName("BDD_SECRET");
    const secret = await api.setSecret(admin, {
      name: secretName,
      value: "super-secret-value",
      description: "BDD secret",
    });
    expect(secret).toMatchObject({
      name: secretName,
      description: "BDD secret",
      type: "user",
    });

    const invalidSecret = await api.requestSetSecret(
      admin,
      { name: "bad-name", value: "value" },
      [400],
    );
    expectApiError(invalidSecret.body);

    const secrets = await api.listSecrets(admin);
    const listedSecret = secrets.secrets.find((candidate) => {
      return candidate.name === secretName;
    });
    expect(listedSecret).toBeDefined();
    expect(JSON.stringify(secrets)).not.toContain("super-secret-value");

    const variableName = upperName("BDD_VARIABLE");
    const variable = await api.setVariable(admin, {
      name: variableName,
      value: "visible-variable-value",
      description: "BDD variable",
    });
    expect(variable).toMatchObject({
      name: variableName,
      value: "visible-variable-value",
      description: "BDD variable",
    });
    const variables = await api.listVariables(admin);
    expect(
      variables.variables.some((candidate) => {
        return (
          candidate.name === variableName &&
          candidate.value === "visible-variable-value"
        );
      }),
    ).toBeTruthy();

    const preferences = await api.updatePreferences(admin, {
      timezone: "UTC",
      pinnedAgentIds: [],
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 3,
    });
    expect(preferences).toMatchObject({
      timezone: "UTC",
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 3,
    });
    const readBack = await api.readPreferences(admin);
    expect(readBack).toStrictEqual(preferences);

    await api.deleteSecret(admin, secretName);
    await api.deleteVariable(admin, variableName);
    const afterSecretDelete = await api.listSecrets(admin);
    expect(
      afterSecretDelete.secrets.some((candidate) => {
        return candidate.name === secretName;
      }),
    ).toBeFalsy();
    const afterVariableDelete = await api.listVariables(admin);
    expect(
      afterVariableDelete.variables.some((candidate) => {
        return candidate.name === variableName;
      }),
    ).toBeFalsy();
  });
});

describe("ORG-01 and ORG-02", () => {
  it("reads, updates, lists, invites, changes membership, handles requests, and leaves orgs through APIs", async () => {
    const admin = api.user();
    const member = api.user({
      orgId: admin.orgId,
      orgRole: "org:member",
      email: `member-${shortId()}@example.test`,
    });
    const requester = api.user({
      orgId: admin.orgId,
      orgRole: "org:member",
      email: `requester-${shortId()}@example.test`,
    });
    const baseSlug = slug("bdd-org");
    const nextSlug = slug("bdd-org-updated");
    const inviteId = `inv_${shortId()}`;
    const requestId = `req_${shortId()}`;

    await onboardAdmin(admin, { slug: baseSlug, name: "BDD Org" });
    api.mockClerkOrg(admin, {
      slug: baseSlug,
      name: "BDD Org",
      members: [
        { actor: admin, role: "org:admin" },
        { actor: member, role: "org:member" },
      ],
      pendingInvitations: [
        {
          id: inviteId,
          email: `invitee-${shortId()}@example.test`,
          role: "org:member",
        },
      ],
      membershipRequests: [{ id: requestId, actor: requester }],
    });

    const adminOrg = await api.readOrg(admin);
    expect(adminOrg).toMatchObject({
      slug: baseSlug,
      name: "BDD Org",
      role: "admin",
    });

    api.mockClerkOrg(member, {
      slug: baseSlug,
      name: "BDD Org",
      members: [
        { actor: admin, role: "org:admin" },
        { actor: member, role: "org:member" },
      ],
    });
    const memberOrg = await api.readOrg(member);
    expect(memberOrg.role).toBe("member");

    api.mockClerkOrg(admin, {
      slug: nextSlug,
      name: "BDD Org Updated",
      members: [
        { actor: admin, role: "org:admin" },
        { actor: member, role: "org:member" },
      ],
    });
    const updated = await api.updateOrg(admin, {
      slug: nextSlug,
      name: "BDD Org Updated",
      force: true,
    });
    expect(updated).toMatchObject({
      slug: nextSlug,
      name: "BDD Org Updated",
    });

    const orgs = await api.listOrgs(admin);
    expect(
      orgs.orgs.some((candidate) => {
        return candidate.slug === nextSlug && candidate.role === "admin";
      }),
    ).toBeTruthy();

    api.mockClerkOrg(member, {
      slug: nextSlug,
      name: "BDD Org Updated",
      members: [
        { actor: admin, role: "org:admin" },
        { actor: member, role: "org:member" },
      ],
    });
    const memberUpdate = await api.requestUpdateOrg(
      member,
      { force: false, name: "Member Update" },
      [403],
    );
    expectApiError(memberUpdate.body);
    expect(memberUpdate.body.error.code).toBe("FORBIDDEN");

    api.mockClerkOrg(admin, {
      slug: nextSlug,
      name: "BDD Org Updated",
      members: [
        { actor: admin, role: "org:admin" },
        { actor: member, role: "org:member" },
      ],
      pendingInvitations: [
        {
          id: inviteId,
          email: `invitee-${shortId()}@example.test`,
          role: "org:member",
        },
      ],
      membershipRequests: [{ id: requestId, actor: requester }],
    });
    const members = await api.listMembers(admin);
    expect(members.role).toBe("admin");
    expect(
      members.members.some((candidate) => {
        return candidate.email === member.email && candidate.role === "member";
      }),
    ).toBeTruthy();
    expect(members.pendingInvitations?.[0]?.id).toBe(inviteId);
    expect(members.membershipRequests?.[0]?.id).toBe(requestId);

    const invite = await api.inviteMember(admin, {
      email: `new-member-${shortId()}@example.test`,
      role: "member",
    });
    expect(invite.message).toContain("Invitation sent");

    api.mockClerkOrg(member, {
      slug: nextSlug,
      name: "BDD Org Updated",
      members: [
        { actor: admin, role: "org:admin" },
        { actor: member, role: "org:member" },
      ],
    });
    const forbiddenInvite = await api.requestInviteMember(
      member,
      { email: `forbidden-${shortId()}@example.test`, role: "member" },
      [403],
    );
    expectApiError(forbiddenInvite.body);
    expect(forbiddenInvite.body.error.code).toBe("FORBIDDEN");

    api.mockClerkOrg(admin, {
      slug: nextSlug,
      name: "BDD Org Updated",
      members: [
        { actor: admin, role: "org:admin" },
        { actor: member, role: "org:member" },
      ],
      pendingInvitations: [{ id: inviteId, email: member.email }],
      membershipRequests: [{ id: requestId, actor: requester }],
    });
    await expect(api.revokeInvitation(admin, inviteId)).resolves.toStrictEqual({
      message: "Invitation revoked",
    });
    await expect(
      api.updateMemberRole(admin, { email: member.email, role: "admin" }),
    ).resolves.toStrictEqual({
      message: `Updated role for ${member.email}`,
    });
    await expect(
      api.acceptMembershipRequest(admin, { requestId }),
    ).resolves.toStrictEqual({
      message: "Membership request accepted",
    });
    await expect(
      api.rejectMembershipRequest(admin, { requestId }),
    ).resolves.toStrictEqual({
      message: "Membership request rejected",
    });
    await expect(
      api.removeMember(admin, { email: member.email }),
    ).resolves.toStrictEqual({
      message: `Removed ${member.email} from org`,
    });

    api.mockClerkOrg(admin, {
      slug: nextSlug,
      name: "BDD Org Updated",
      members: [{ actor: admin, role: "org:admin" }],
    });
    const afterRemove = await api.listMembers(admin);
    expect(
      afterRemove.members.some((candidate) => {
        return candidate.email === member.email;
      }),
    ).toBeFalsy();

    api.mockClerkOrg(member, {
      slug: nextSlug,
      name: "BDD Org Updated",
      members: [
        { actor: admin, role: "org:admin" },
        { actor: member, role: "org:member" },
      ],
    });
    await expect(api.leaveOrg(member)).resolves.toStrictEqual({
      message: "Left org",
    });

    api.mockClerkOrg(admin, {
      slug: nextSlug,
      name: "BDD Org Updated",
      members: [{ actor: admin, role: "org:admin" }],
    });
    await expect(api.deleteOrg(admin, nextSlug)).resolves.toStrictEqual({
      message: "Organization deleted",
    });
  });
});

describe("ORG-03 onboarding status mapping", () => {
  it("rejects onboarding status without authentication", async () => {
    const unauthenticated = await bdd.requestReadOnboardingStatus(null, [401]);
    expect(unauthenticated.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("maps onboarding status across the setup, payment, entitlement, and agent-deletion journey", async () => {
    const noOrg = api.user({ orgId: null });
    const admin = api.user();
    const member = api.user({ orgId: admin.orgId, orgRole: "org:member" });

    const noOrgStatus = await api.readOnboardingStatus(noOrg);
    expect(noOrgStatus).toStrictEqual({
      needsOnboarding: true,
      isAdmin: false,
      hasOrg: false,
      hasDefaultAgent: false,
      defaultAgentId: null,
      defaultAgentMetadata: null,
    });

    const memberStatus = await api.readOnboardingStatus(member);
    expect(memberStatus).toStrictEqual({
      needsOnboarding: false,
      isAdmin: false,
      hasOrg: true,
      hasDefaultAgent: false,
      defaultAgentId: null,
      defaultAgentMetadata: null,
    });

    const adminBeforeSetup = await api.readOnboardingStatus(admin);
    expect(adminBeforeSetup).toStrictEqual({
      needsOnboarding: true,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: false,
      defaultAgentId: null,
      defaultAgentMetadata: null,
    });

    api.acceptAgentStorageWrites();
    const setup = await api.setupOnboarding(admin, {
      displayName: "BDD Status Agent",
      sound: "friendly",
    });
    if (setup.status !== 200) {
      throw new Error(
        `Expected onboarding setup to succeed, got ${setup.status}`,
      );
    }
    const agentId = setup.body.agentId;

    const paymentPending = await api.readOnboardingStatus(admin);
    expect(paymentPending).toStrictEqual({
      needsOnboarding: true,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: true,
      defaultAgentId: agentId,
      defaultAgentMetadata: {
        displayName: "BDD Status Agent",
        sound: "friendly",
      },
    });

    await runsApi.grantProEntitlement(admin);
    const entitled = await api.readOnboardingStatus(admin);
    expect(entitled).toStrictEqual({
      needsOnboarding: false,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: true,
      defaultAgentId: agentId,
      defaultAgentMetadata: {
        displayName: "BDD Status Agent",
        sound: "friendly",
      },
    });

    await api.deleteAgent(admin, agentId);
    const orphaned = await api.readOnboardingStatus(admin);
    expect(orphaned).toStrictEqual({
      needsOnboarding: true,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: false,
      defaultAgentId: null,
      defaultAgentMetadata: null,
    });
  });
});

describe("AGENT-01 and AGENT-02", () => {
  it("rejects agent metadata updates at unauthenticated, malformed, and missing boundaries", async () => {
    const admin = api.user();
    const missingAgentId = randomUUID();

    const unauthenticated = await api.requestUpdateAgentMetadata(
      null,
      missingAgentId,
      { displayName: "No auth" },
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const malformed = await api.requestUpdateAgentMetadata(
      admin,
      "not-a-valid-agent-id",
      { displayName: "Malformed" },
      [400],
    );
    expectApiError(malformed.body);
    expect(malformed.body.error.code).toBe("BAD_REQUEST");

    const missing = await api.requestUpdateAgentMetadata(
      admin,
      missingAgentId,
      { displayName: "Missing" },
      [404],
    );
    expectApiError(missing.body);
    expect(missing.body.error.code).toBe("NOT_FOUND");
  });

  it("enforces the public agent limit while still allowing private agents", async () => {
    const admin = api.user();
    api.acceptAgentStorageWrites();

    const builtInCustomSkill = await api.requestCreateAgent(
      admin,
      {
        displayName: "BDD Built In Custom Skill",
        customSkills: ["github"],
      },
      [400],
    );
    expectApiError(builtInCustomSkill.body);
    expect(builtInCustomSkill.body.error.code).toBe("VALIDATION_ERROR");
    expect(builtInCustomSkill.body.error.message).toBe(
      "'github' is a built-in connector, not a custom skill. Enable it via connectors instead.",
    );

    const missingCustomSkill = await api.requestCreateAgent(
      admin,
      {
        displayName: "BDD Missing Custom Skill",
        customSkills: [`missing-${shortId()}`],
      },
      [400],
    );
    expectApiError(missingCustomSkill.body);
    expect(missingCustomSkill.body.error.code).toBe("VALIDATION_ERROR");
    expect(missingCustomSkill.body.error.message).toContain(
      "not found in this organization",
    );

    const publicAgents = [];
    for (let index = 0; index < 7; index += 1) {
      publicAgents.push(
        await api.createAgent(admin, {
          displayName: `BDD Public Limit ${index + 1}`,
          visibility: "public",
        }),
      );
    }

    const blocked = await api.requestCreateAgent(
      admin,
      {
        displayName: "BDD Public Limit Blocked",
        visibility: "public",
      },
      [409],
    );
    expectApiError(blocked.body);
    expect(blocked.body.error.code).toBe("CONFLICT");
    expect(blocked.body.error.message).toBe(
      "This organization has reached the maximum number of agents (7). Delete an existing agent before creating a new one.",
    );

    const listed = await api.listAgents(admin);
    const listedPublicAgents = listed.filter((agent) => {
      return agent.visibility === "public";
    });
    expect(listedPublicAgents).toHaveLength(7);
    expect(
      publicAgents.every((agent) => {
        return listedPublicAgents.some((listedAgent) => {
          return listedAgent.agentId === agent.agentId;
        });
      }),
    ).toBeTruthy();

    const privateAfterLimit = await api.createAgent(admin, {
      displayName: "BDD Private After Public Limit",
      visibility: "private",
    });
    expect(privateAfterLimit).toMatchObject({
      displayName: "BDD Private After Public Limit",
      visibility: "private",
    });

    const blockedVisibility = await api.requestUpdateAgentMetadata(
      admin,
      privateAfterLimit.agentId,
      { visibility: "public" },
      [409],
    );
    expectApiError(blockedVisibility.body);
    expect(blockedVisibility.body.error.code).toBe("CONFLICT");
    expect(blockedVisibility.body.error.message).toBe(
      "This organization has reached the maximum number of agents (7). Delete an existing agent before making this agent public.",
    );

    const privateAfterBlockedVisibility = await api.readAgent(
      admin,
      privateAfterLimit.agentId,
    );
    expect(privateAfterBlockedVisibility.visibility).toBe("private");
  });

  it("covers agent isolation, default-agent permissions, and org custom connector enablement", async () => {
    const admin = api.user();
    const member = api.user({
      orgId: admin.orgId,
      orgRole: "org:member",
      email: `member-${shortId()}@example.test`,
    });
    const otherAdmin = api.user();
    await onboardAdmin(admin, { slug: slug("bdd-agent") });
    api.acceptAgentStorageWrites();

    const privateAgent = await api.createAgent(admin, {
      displayName: "BDD Private Agent",
      visibility: "private",
    });
    const memberPrivateRead = await api.requestReadAgent(
      member,
      privateAgent.agentId,
      [404],
    );
    expectApiError(memberPrivateRead.body);
    expect(memberPrivateRead.body.error.code).toBe("NOT_FOUND");

    const publicAgent = await api.createAgent(admin, {
      displayName: "BDD Public Agent",
      visibility: "public",
    });
    const memberPublicRead = await api.readAgent(member, publicAgent.agentId);
    expect(memberPublicRead.agentId).toBe(publicAgent.agentId);

    const crossOrgRead = await api.requestReadAgent(
      otherAdmin,
      publicAgent.agentId,
      [404],
    );
    expectApiError(crossOrgRead.body);
    expect(crossOrgRead.body.error.code).toBe("NOT_FOUND");

    const memberDefault = await api.requestSetDefaultAgent(
      member,
      publicAgent.agentId,
      [403],
    );
    expectApiError(memberDefault.body);
    expect(memberDefault.body.error.code).toBe("FORBIDDEN");

    const connectorSlug = slug("bdd-connector");
    const connector = await api.createCustomConnector(admin, {
      displayName: "BDD Custom Connector",
      prefixes: [`https://${connectorSlug}.example.test/api/`],
      headerName: "Authorization",
      headerTemplate: "Bearer {{secret}}",
      slug: connectorSlug,
    });
    expect(connector).toMatchObject({
      slug: connectorSlug,
      displayName: "BDD Custom Connector",
      hasSecret: false,
    });

    await api.setCustomConnectorSecret(
      admin,
      connector.id,
      "custom-connector-secret",
    );
    const connectorList = await api.listCustomConnectors(admin);
    const listedConnector = connectorList.connectors.find((candidate) => {
      return candidate.id === connector.id;
    });
    expect(listedConnector).toBeDefined();
    expect(listedConnector?.hasSecret).toBeTruthy();
    expect(JSON.stringify(connectorList)).not.toContain(
      "custom-connector-secret",
    );

    const enabled = await api.updateAgentCustomConnectors(
      admin,
      publicAgent.agentId,
      [connector.id],
    );
    expect(enabled.enabledIds).toStrictEqual([connector.id]);
    const readEnabled = await api.readAgentCustomConnectors(
      admin,
      publicAgent.agentId,
    );
    expect(readEnabled.enabledIds).toStrictEqual([connector.id]);

    const otherAgent = await api.createAgent(otherAdmin, {
      displayName: "Other Org Agent",
      visibility: "private",
    });
    const crossOrgConnector = await api.requestUpdateAgentCustomConnectors(
      otherAdmin,
      otherAgent.agentId,
      [connector.id],
      [400],
    );
    expectApiError(crossOrgConnector.body);
    expect(crossOrgConnector.body.error.code).toBe("VALIDATION_ERROR");

    const cleared = await api.updateAgentCustomConnectors(
      admin,
      publicAgent.agentId,
      [],
    );
    expect(cleared.enabledIds).toStrictEqual([]);

    const renamed = await api.patchCustomConnector(admin, connector.id, {
      displayName: "BDD Custom Connector Renamed",
    });
    expect(renamed.displayName).toBe("BDD Custom Connector Renamed");
    await api.deleteCustomConnectorSecret(admin, connector.id);
    const afterSecretDelete = await api.listCustomConnectors(admin);
    expect(
      afterSecretDelete.connectors.find((candidate) => {
        return candidate.id === connector.id;
      })?.hasSecret,
    ).toBeFalsy();
    await api.deleteCustomConnector(admin, connector.id);
    const afterDelete = await api.listCustomConnectors(admin);
    expect(
      afterDelete.connectors.some((candidate) => {
        return candidate.id === connector.id;
      }),
    ).toBeFalsy();
  });
});

describe("COMPOSE-01", () => {
  it("creates, reads, lists, updates metadata, rejects invalid/cross-org access, and deletes composes through public APIs", async () => {
    const admin = api.user();
    const otherAdmin = api.user();
    const composeName = slug("bdd-compose");
    const content = api.composeContent(composeName);

    const created = await api.createCompose(admin, content);
    expect(created).toMatchObject({
      name: composeName,
      action: "created",
    });

    const duplicate = await api.createCompose(admin, content);
    expect(duplicate.composeId).toBe(created.composeId);
    expect(duplicate.action).toBe("existing");

    const byId = await api.readComposeById(admin, created.composeId);
    expect(byId).toMatchObject({
      id: created.composeId,
      name: composeName,
      headVersionId: created.versionId,
    });
    const byName = await api.readComposeByName(admin, composeName);
    expect(byName.id).toBe(created.composeId);

    const zeroById = await api.readZeroComposeById(admin, created.composeId);
    expect(zeroById.id).toBe(created.composeId);
    const zeroByName = await api.readZeroComposeByName(admin, composeName);
    expect(zeroByName.id).toBe(created.composeId);

    const listed = await api.listComposes(admin);
    expect(
      listed.some((compose) => {
        return compose.id === created.composeId;
      }),
    ).toBeTruthy();
    const zeroListed = await api.listZeroComposes(admin);
    expect(
      zeroListed.some((compose) => {
        return compose.id === created.composeId;
      }),
    ).toBeTruthy();

    await api.updateComposeMetadata(admin, created.composeId, {
      displayName: "BDD Compose",
      description: "Metadata through agent compose API",
      sound: "focus",
    });
    const listedAfterMetadata = await api.listComposes(admin);
    expect(
      listedAfterMetadata.find((compose) => {
        return compose.id === created.composeId;
      }),
    ).toMatchObject({
      displayName: "BDD Compose",
      description: "Metadata through agent compose API",
      sound: "focus",
    });

    await api.updateZeroComposeMetadata(admin, created.composeId, {
      displayName: "BDD Compose Zero",
      description: "Metadata through zero compose API",
      sound: "quiet",
    });
    const zeroAfterMetadata = await api.listZeroComposes(admin);
    expect(
      zeroAfterMetadata.find((compose) => {
        return compose.id === created.composeId;
      }),
    ).toMatchObject({
      displayName: "BDD Compose Zero",
      description: "Metadata through zero compose API",
      sound: "quiet",
    });

    const invalid = await api.requestCreateCompose(
      admin,
      { version: "1", agents: {} },
      [400],
    );
    expectApiError(invalid.body);

    const crossOrg = await api.requestReadZeroComposeById(
      otherAdmin,
      created.composeId,
      [404],
    );
    expectApiError(crossOrg.body);
    expect(crossOrg.body.error.code).toBe("NOT_FOUND");

    await api.deleteZeroCompose(admin, created.composeId);
    const deleted = await api.requestReadComposeById(
      admin,
      created.composeId,
      [404],
    );
    expectApiError(deleted.body);
    expect(deleted.body.error.code).toBe("NOT_FOUND");
  });
});
