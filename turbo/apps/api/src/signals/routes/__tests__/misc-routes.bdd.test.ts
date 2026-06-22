import { createHmac, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { env } from "../../../lib/env";
import { testContext } from "../../../__tests__/test-helpers";
import { createBddApi, expectApiError } from "./helpers/api-bdd";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";

const context = testContext();

function testActors() {
  const base = createBddApi(context);
  const api = createMiscRoutesApi(context);
  const admin = base.user();
  const member = base.user({ orgId: admin.orgId, orgRole: "org:member" });
  return { api, base, admin, member };
}

function unsubscribeToken(userId: string): string {
  const signature = createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(`unsubscribe:${userId}`)
    .digest("hex")
    .slice(0, 32);
  return `${userId}.${signature}`;
}

describe("MISC-01: organization logo and profile-adjacent API boundaries", () => {
  it("chains logo read, upload validation, upload success, and delete through public API", async () => {
    const { api, admin, member } = testActors();

    const unauthenticated = await api.requestOrgLogo(null, [401]);
    expectApiError(unauthenticated.body);

    api.setOrgLogoRead({
      imageUrl: "https://images.example.test/org-logo.png",
      hasImage: true,
    });
    const current = await api.requestOrgLogo(admin, [200]);
    expect(current.body).toStrictEqual({
      logoUrl: "https://images.example.test/org-logo.png",
      hasImage: true,
    });

    const memberUpload = await api.uploadOrgLogo(
      member,
      new File([new Uint8Array([1])], "logo.png", { type: "image/png" }),
      [403],
    );
    expectApiError(memberUpload.body);
    expect(memberUpload.body.error.message).toBe(
      "Only admins can upload the logo",
    );

    const missingFile = await api.uploadOrgLogo(admin, null, [400]);
    expectApiError(missingFile.body);
    expect(missingFile.body.error.message).toBe("No file provided");

    api.setOrgLogoUpload({
      imageUrl: "https://images.example.test/uploaded-logo.png",
      hasImage: true,
    });
    const uploaded = await api.uploadOrgLogo(
      admin,
      new File([new Uint8Array([1, 2])], "logo.webp", {
        type: "image/webp",
      }),
      [200],
    );
    expect(uploaded.body).toStrictEqual({
      logoUrl: "https://images.example.test/uploaded-logo.png",
      hasImage: true,
    });

    api.setOrgLogoDelete({ imageUrl: null, hasImage: false });
    const deleted = await api.deleteOrgLogo(admin, [200]);
    expect(deleted.body).toStrictEqual({ logoUrl: null, hasImage: false });
  });
});

describe("MISC-02: preferences, push subscription, user export, and empty logs", () => {
  it("chains visible user-scoped reads and writes without hidden fixtures", async () => {
    const { api, admin } = testActors();

    const initialPreferences = await api.readPreferences(admin);
    expect(initialPreferences.body).toMatchObject({
      timezone: null,
      pinnedAgentIds: [],
      sendMode: "enter",
    });

    const updatedPreferences = await api.updatePreferences(
      admin,
      {
        timezone: "UTC",
        sendMode: "cmd-enter",
        pinnedAgentIds: [randomUUID()],
        captureNetworkBodiesRemaining: 3,
      },
      [200],
    );
    expect(updatedPreferences.body).toMatchObject({
      timezone: "UTC",
      sendMode: "cmd-enter",
      captureNetworkBodiesRemaining: 3,
    });
    const rereadPreferences = await api.readPreferences(admin);
    expect(rereadPreferences.body).toStrictEqual(updatedPreferences.body);

    const registeredPush = await api.registerPush(admin, [201]);
    expect(registeredPush.body).toStrictEqual({ success: true });

    const exportStatus = await api.readUserExport(admin, [200]);
    expect(exportStatus.body).toMatchObject({
      job: null,
      canExport: true,
    });
    const noOrgActor = createBddApi(context).user({ orgId: null });
    const noOrgStart = await api.startUserExport(noOrgActor, [401]);
    expectApiError(noOrgStart.body);

    const missingUnsubscribeToken = await api.requestEmailUnsubscribePage(
      undefined,
      [400],
    );
    expect(missingUnsubscribeToken.body).toStrictEqual({
      error: "Missing token",
    });

    const missingUnsubscribePost = await api.requestEmailUnsubscribe(
      undefined,
      [400],
    );
    expect(missingUnsubscribePost.body).toStrictEqual({
      error: "Missing token",
    });

    const invalidUnsubscribePage = await api.requestEmailUnsubscribePage(
      "not-a-valid-token",
      [400],
    );
    expect(invalidUnsubscribePage.body).toStrictEqual({
      error: "Invalid token",
    });

    const invalidUnsubscribeToken = await api.requestEmailUnsubscribe(
      "not-a-valid-token",
      [400],
    );
    expect(invalidUnsubscribeToken.body).toStrictEqual({
      error: "Invalid token",
    });

    const validToken = unsubscribeToken(`user_${randomUUID()}`);
    const unsubscribePage = await api.requestEmailUnsubscribePage(
      validToken,
      [200],
    );
    expect(unsubscribePage.headers.get("content-type")).toContain("text/html");
    if (typeof unsubscribePage.body !== "string") {
      throw new Error("Expected unsubscribe page to return HTML");
    }
    expect(unsubscribePage.body).toContain("You have been unsubscribed");

    const unsubscribed = await api.requestEmailUnsubscribe(validToken, [200]);
    expect(unsubscribed.body).toStrictEqual({ unsubscribed: true });

    const logs = await api.listLogs(admin);
    expect(logs.body.data).toStrictEqual([]);
    const searched = await api.searchLogs(admin, "nothing-here");
    expect(searched.body.results).toStrictEqual([]);
    const missingLog = await api.readLog(admin, randomUUID(), [404]);
    expectApiError(missingLog.body);
  });
});

describe("MISC-03: workflows lifecycle through public API", () => {
  it("chains create, list, read, update, delete, and post-delete read", async () => {
    const { api, base, admin, member } = testActors();
    const memberWorkflowName = `bdd-member-workflow-${randomUUID().slice(0, 8)}`;
    const workflowName = `bdd-workflow-${randomUUID().slice(0, 8)}`;

    // Workflows are agent-scoped (1:N) and creating one requires
    // write-permission on the target agent (owner, or org admin on a public
    // agent). Admin owns the agent it creates on; the member creates its
    // private workflow on its own agent.
    const agent = await base.createAgent(admin, {
      displayName: "BDD workflows agent",
    });
    const memberAgent = await base.createAgent(member, {
      displayName: "BDD member workflows agent",
    });

    const initialWorkflows = await api.listWorkflows(admin);
    expect(
      initialWorkflows.body.some((workflow) => {
        return workflow.name === workflowName;
      }),
    ).toBeFalsy();

    const memberCreated = await api.createWorkflow(
      member,
      memberAgent.agentId,
      memberWorkflowName,
      "# Member private workflow",
      [201],
    );
    expect(memberCreated.body).toMatchObject({
      name: memberWorkflowName,
      visibility: "private",
      ownerUserId: member.userId,
      canManage: true,
    });
    const adminListAfterMemberCreate = await api.listWorkflows(admin);
    expect(
      adminListAfterMemberCreate.body.some((workflow) => {
        return workflow.name === memberWorkflowName;
      }),
    ).toBeFalsy();

    const invalidCreate = await api.requestCreateInvalidWorkflow(
      admin,
      agent.agentId,
      [400],
    );
    expectApiError(invalidCreate.body);

    const created = await api.createWorkflow(
      admin,
      agent.agentId,
      workflowName,
      "# BDD Workflow\n\nCreated through API.",
      [201],
    );
    if (created.status !== 201) {
      throw new Error(
        `Expected workflow creation to succeed, got ${created.status}`,
      );
    }
    expect(created.body).toMatchObject({
      name: workflowName,
      displayName: "BDD Workflow",
      description: "Created through public workflow API",
    });
    const workflowId = created.body.id;

    const listed = await api.listWorkflows(admin);
    expect(
      listed.body.some((workflow) => {
        return workflow.name === workflowName;
      }),
    ).toBeTruthy();

    const detail = await api.readWorkflow(admin, workflowId, [200]);
    if (detail.status !== 200) {
      throw new Error(
        `Expected workflow detail to be readable, got ${detail.status}`,
      );
    }
    expect(detail.body.instruction).toBe(
      "# BDD Workflow\n\nCreated through API.",
    );

    const updated = await api.updateWorkflow(
      admin,
      workflowId,
      "# BDD Workflow\n\nUpdated through API.",
      [200],
    );
    if (updated.status !== 200) {
      throw new Error(
        `Expected workflow update to succeed, got ${updated.status}`,
      );
    }
    expect(updated.body.instruction).toBe(
      "# BDD Workflow\n\nUpdated through API.",
    );

    await api.deleteWorkflow(admin, workflowId, [204]);
    const missing = await api.readWorkflow(admin, workflowId, [404]);
    expectApiError(missing.body);
  });
});

describe("MISC-04: model providers, policies, and logs visible state", () => {
  it("chains model provider setup, policy read/update, provider delete, and empty logs", async () => {
    const { api, admin, member } = testActors();

    const initialProviders = await api.listModelProviders(admin);
    expect(initialProviders.body.modelProviders).toStrictEqual([]);

    const deniedProvider = await api.upsertVm0Provider(member, [403]);
    expectApiError(deniedProvider.body);

    const createdProvider = await api.upsertVm0Provider(admin, [201]);
    expect(createdProvider.body).toMatchObject({
      created: true,
      provider: { type: "vm0" },
    });

    const listedProviders = await api.listModelProviders(admin);
    expect(
      listedProviders.body.modelProviders.some((provider) => {
        return provider.type === "vm0";
      }),
    ).toBeTruthy();

    const policies = await api.listModelPolicies(admin);
    expect(policies.policies.length).toBeGreaterThan(0);
    const updatedPolicies = await api.updateModelPolicies(
      admin,
      policies.policies,
      [200],
    );
    if (updatedPolicies.status !== 200) {
      throw new Error(
        `Expected model policies update to succeed, got ${updatedPolicies.status}`,
      );
    }
    expect(updatedPolicies.body.policies).toHaveLength(
      policies.policies.length,
    );

    await api.deleteVm0Provider(admin, [204]);
    const afterDelete = await api.listModelProviders(admin);
    expect(
      afterDelete.body.modelProviders.some((provider) => {
        return provider.type === "vm0";
      }),
    ).toBeFalsy();
  });

  it("chains personal model provider create, update, list, and delete through public API", async () => {
    const { api, admin } = testActors();

    const unauthenticatedList = await api.listPersonalModelProviders(
      null,
      [401],
    );
    expectApiError(unauthenticatedList.body);

    const initial = await api.listPersonalModelProviders(admin, [200]);
    if (!("modelProviders" in initial.body)) {
      throw new Error("Expected personal model provider list response");
    }
    expect(initial.body.modelProviders).toStrictEqual([]);

    const unsupported = await api.upsertPersonalModelProvider(
      admin,
      {
        type: "anthropic-api-key",
        secret: "bdd-anthropic-key",
      },
      [404],
    );
    expectApiError(unsupported.body);
    expect(unsupported.body.error.message).toBe(
      'Provider "anthropic-api-key" not found',
    );

    const missingSecret = await api.upsertPersonalModelProvider(
      admin,
      {
        type: "claude-code-oauth-token",
      },
      [400],
    );
    expectApiError(missingSecret.body);
    expect(missingSecret.body.error.message).toBe(
      'Provider "claude-code-oauth-token" requires a secret',
    );

    const created = await api.upsertPersonalModelProvider(
      admin,
      {
        type: "claude-code-oauth-token",
        secret: "bdd-claude-oauth-token",
        selectedModel: "claude-sonnet-4-6",
      },
      [201],
    );
    expect(created.body).toMatchObject({
      created: true,
      provider: {
        type: "claude-code-oauth-token",
        secretName: "CLAUDE_CODE_OAUTH_TOKEN",
        selectedModel: "claude-sonnet-4-6",
      },
    });
    if (!("provider" in created.body)) {
      throw new Error("Expected personal model provider upsert response");
    }
    expect("secret" in created.body.provider).toBeFalsy();

    const listed = await api.listPersonalModelProviders(admin, [200]);
    if (!("modelProviders" in listed.body)) {
      throw new Error("Expected personal model provider list response");
    }
    expect(listed.body.modelProviders).toHaveLength(1);
    expect(listed.body.modelProviders[0]).toMatchObject({
      type: "claude-code-oauth-token",
      secretName: "CLAUDE_CODE_OAUTH_TOKEN",
      selectedModel: "claude-sonnet-4-6",
    });

    const updated = await api.upsertPersonalModelProvider(
      admin,
      {
        type: "claude-code-oauth-token",
        secret: "bdd-updated-claude-oauth-token",
        selectedModel: "claude-opus-4-8",
      },
      [200],
    );
    expect(updated.body).toMatchObject({
      created: false,
      provider: {
        type: "claude-code-oauth-token",
        selectedModel: "claude-opus-4-8",
      },
    });

    await api.deletePersonalModelProvider(
      admin,
      "claude-code-oauth-token",
      [204],
    );
    const afterDelete = await api.listPersonalModelProviders(admin, [200]);
    if (!("modelProviders" in afterDelete.body)) {
      throw new Error("Expected personal model provider list response");
    }
    expect(afterDelete.body.modelProviders).toStrictEqual([]);
  });
});
