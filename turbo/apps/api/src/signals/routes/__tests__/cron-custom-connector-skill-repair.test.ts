import { randomUUID } from "node:crypto";

import { cronCustomConnectorSkillRepairContract } from "@vm0/api-contracts/contracts/cron";
import { testCustomConnectorSkillRepairStateContract } from "@vm0/api-contracts/contracts/test-custom-connector-skill-repair-state";
import type { CustomConnectorHttpResponse } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { getCustomConnectorSkillName } from "@vm0/core/storage-names";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { extractFileFromTarGz } from "../../../lib/tar";
import { createDeferredPromise } from "../../utils";
import { cronCustomConnectorSkillRepairRoutes } from "../cron-custom-connector-skill-repair";
import { testCustomConnectorSkillRepairStateRoutes } from "../test-custom-connector-skill-repair-state";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";

const context = testContext();
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const CRON_SECRET = "custom-connector-skill-repair-test-secret";

function cronClient() {
  return setupApp({
    context,
    routes: cronCustomConnectorSkillRepairRoutes,
  })(cronCustomConnectorSkillRepairContract);
}

function stateClient() {
  return setupApp({
    context,
    routes: testCustomConnectorSkillRepairStateRoutes,
  })(testCustomConnectorSkillRepairStateContract);
}

function cronHeaders(secret = CRON_SECRET) {
  return { authorization: `Bearer ${secret}` };
}

function uniqueSlug(): string {
  return `_repair-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

async function createConnector(
  actor: ApiTestUser,
  skillMarkdown: string | null,
): Promise<CustomConnectorHttpResponse> {
  const slug = uniqueSlug();
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    { data: [{ publicUserData: { userId: actor.userId } }] },
  );
  const connector = await connectorsApi.createCustomConnector(actor, {
    displayName: `Repair ${slug}`,
    slug,
    prefixes: [`https://${slug.slice(1)}.example.test/v1/`],
    headerName: "Authorization",
    headerTemplate: "Bearer {{secret}}",
    skillMarkdown,
  });
  if (connector.kind !== "http") {
    throw new Error("Expected an HTTP custom connector");
  }
  return connector;
}

async function createOauthConnector(
  actor: ApiTestUser,
  skillMarkdown: string,
): Promise<CustomConnectorHttpResponse> {
  const slug = uniqueSlug();
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    { data: [{ publicUserData: { userId: actor.userId } }] },
  );
  const connector = await connectorsApi.createCustomConnector(actor, {
    displayName: `Managed repair ${slug}`,
    slug,
    prefixTemplates: [`https://${slug.slice(1)}.example.test/v1/`],
    fields: [],
    headerInjections: [
      {
        name: "Authorization",
        valueTemplate: "Bearer {{oauth.access_token}}",
      },
    ],
    queryInjections: [],
    authMode: "oauth",
    oauthConfig: {
      providerAdapter: "standard",
      clientId: `client-${randomUUID()}`,
      clientSecret: "repair-test-client-secret",
      authorizationUrl: "https://oauth.example.test/authorize",
      tokenUrl: "https://oauth.example.test/token",
      tokenEndpointAuthMethod: "client_secret_post",
      pkceMethod: "none",
      scopes: ["read"],
      authorizationParams: {},
    },
    skillMarkdown,
  });
  if (connector.kind !== "http") {
    throw new Error("Expected an HTTP custom connector");
  }
  return connector;
}

async function updateSkill(
  actor: ApiTestUser,
  connector: CustomConnectorHttpResponse,
  skillMarkdown: string,
): Promise<CustomConnectorHttpResponse> {
  const response = await connectorsApi.requestUpdateCustomConnector(
    actor,
    connector.id,
    {
      displayName: connector.displayName,
      prefixTemplates: connector.prefixTemplates,
      fields: connector.fields,
      headerInjections: connector.headerInjections,
      queryInjections: connector.queryInjections,
      authMode: connector.authMode ?? "manual",
      permissionBundleRef: connector.permissionBundleRef,
      skillMarkdown,
      storageVersion: connector.storageVersion,
    },
    [200],
  );
  if (response.status !== 200) {
    throw new Error("Expected the custom connector update to succeed");
  }
  if (response.body.kind !== "http") {
    throw new Error("Expected an HTTP custom connector");
  }
  return response.body;
}

async function readState(connectorId: string) {
  const response = await accept(
    stateClient().action({
      body: { action: "read", connectorId },
    }),
    [200],
  );
  return response.body.state;
}

async function setConnectorState(
  connectorId: string,
  values: {
    readonly skillMarkdown?: string | null;
    readonly skillStorageVersionId?: string | null;
  },
) {
  const response = await accept(
    stateClient().action({
      body: { action: "set-connector", connectorId, ...values },
    }),
    [200],
  );
  return response.body.state;
}

async function setHead(connectorId: string, headVersionId: string | null) {
  const response = await accept(
    stateClient().action({
      body: { action: "set-head", connectorId, headVersionId },
    }),
    [200],
  );
  return response.body.state;
}

async function setManagedFeishuInstallation(
  connectorId: string,
  installationId: string,
  defaultComposeId: string,
) {
  const response = await accept(
    stateClient().action({
      body: {
        action: "set-managed-feishu-installation",
        connectorId,
        installationId,
        defaultComposeId,
      },
    }),
    [200],
  );
  return response.body.state;
}

async function setProviderAdapter(
  connectorId: string,
  providerAdapter: "standard" | "feishu",
) {
  const response = await accept(
    stateClient().action({
      body: {
        action: "set-provider-adapter",
        connectorId,
        providerAdapter,
      },
    }),
    [200],
  );
  return response.body.state;
}

async function clearManagedFeishuInstallation(
  connectorId: string,
  installationId: string,
) {
  const response = await accept(
    stateClient().action({
      body: {
        action: "clear-managed-feishu-installation",
        connectorId,
        installationId,
      },
    }),
    [200, 404],
  );
  return response.body;
}

async function repair() {
  return await accept(cronClient().repair({ headers: cronHeaders() }), [200]);
}

async function status() {
  const response = await accept(
    cronClient().status({ headers: cronHeaders() }),
    [200],
  );
  return response.body;
}

function requireVersionId(versionId: string | null, message: string): string {
  if (!versionId) {
    throw new Error(message);
  }
  return versionId;
}

function commandName(command: unknown): string | undefined {
  return typeof command === "object" && command !== null
    ? command.constructor.name
    : undefined;
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

function s3PutCalls(): readonly unknown[][] {
  return context.mocks.s3.send.mock.calls.filter(([command]) => {
    return commandName(command) === "PutObjectCommand";
  });
}

function uploadedSkillMarkdown(): string {
  for (const [command] of s3PutCalls()) {
    const input = commandInput(command);
    if (
      String(input.Key).endsWith("/archive.tar.gz") &&
      Buffer.isBuffer(input.Body)
    ) {
      const skillMarkdown = extractFileFromTarGz(input.Body, "SKILL.md");
      if (skillMarkdown !== null) {
        return skillMarkdown;
      }
    }
  }
  throw new Error("Expected a repaired SKILL.md upload");
}

beforeEach(() => {
  mockEnv("CRON_SECRET", CRON_SECRET);
  bdd.acceptAgentStorageWrites();
});

describe.sequential("custom connector skill repair cron", () => {
  const createdConnectors: {
    actor: ApiTestUser;
    connectorId: string;
  }[] = [];

  async function createTrackedConnector(
    actor: ApiTestUser,
    skillMarkdown: string | null,
  ): Promise<CustomConnectorHttpResponse> {
    const connector = await createConnector(actor, skillMarkdown);
    createdConnectors.push({ actor, connectorId: connector.id });
    return connector;
  }

  async function createTrackedOauthConnector(
    actor: ApiTestUser,
    skillMarkdown: string,
  ): Promise<CustomConnectorHttpResponse> {
    const connector = await createOauthConnector(actor, skillMarkdown);
    createdConnectors.push({ actor, connectorId: connector.id });
    return connector;
  }

  const managedFeishuInstallations: {
    connectorId: string;
    installationId: string;
  }[] = [];

  afterEach(async () => {
    for (const { connectorId, installationId } of managedFeishuInstallations
      .splice(0)
      .reverse()) {
      await clearManagedFeishuInstallation(connectorId, installationId);
    }
    for (const { actor, connectorId } of createdConnectors
      .splice(0)
      .reverse()) {
      await connectorsApi.deleteCustomConnector(actor, connectorId, [204, 404]);
    }
  });

  it("protects repair and status with the cron secret", async () => {
    const repairResponse = await accept(
      cronClient().repair({ headers: cronHeaders("wrong") }),
      [401],
    );
    const statusResponse = await accept(
      cronClient().status({ headers: {} }),
      [401],
    );

    expect(repairResponse.body.error.code).toBe("UNAUTHORIZED");
    expect(statusResponse.body.error.code).toBe("UNAUTHORIZED");
  });

  it("reports mutually exclusive semantic reasons without calling S3", async () => {
    const actor = bdd.user({ orgRole: "org:admin" });
    const baseline = await status();

    const missingStorage = await createTrackedConnector(actor, null);
    await setConnectorState(missingStorage.id, {
      skillMarkdown: "Missing canonical storage",
    });

    const missingExpected = await createTrackedConnector(
      actor,
      "Registered v1",
    );
    await setConnectorState(missingExpected.id, {
      skillMarkdown: "Unregistered v2",
    });

    const missingAssociation = await createTrackedConnector(
      actor,
      "Missing association",
    );
    await setConnectorState(missingAssociation.id, {
      skillStorageVersionId: null,
    });

    const wrongStorage = await createTrackedConnector(actor, "Wrong storage A");
    const otherStorage = await createTrackedConnector(actor, "Wrong storage B");
    const otherVersionId = requireVersionId(
      (await readState(otherStorage.id)).connector.skillStorageVersionId,
      "Expected the other connector version",
    );
    await setConnectorState(wrongStorage.id, {
      skillStorageVersionId: otherVersionId,
    });

    const staleAssociation = await createTrackedConnector(actor, "Stale v1");
    const staleVersionId = requireVersionId(
      (await readState(staleAssociation.id)).connector.skillStorageVersionId,
      "Expected the stale connector version",
    );
    await updateSkill(actor, staleAssociation, "Stale v2");
    await setConnectorState(staleAssociation.id, {
      skillStorageVersionId: staleVersionId,
    });

    const headMismatch = await createTrackedConnector(actor, "HEAD v1");
    const previousHeadId = requireVersionId(
      (await readState(headMismatch.id)).storage?.headVersionId ?? null,
      "Expected the previous HEAD",
    );
    await updateSkill(actor, headMismatch, "HEAD v2");
    await setHead(headMismatch.id, previousHeadId);

    const inverseInvalid = await createTrackedConnector(
      actor,
      "Remove this skill",
    );
    await setConnectorState(inverseInvalid.id, { skillMarkdown: null });

    context.mocks.s3.send.mockClear();
    const result = await status();

    expect(result.reasons).toMatchObject({
      inverseInvalid: baseline.reasons.inverseInvalid + 1,
      missingStorage: baseline.reasons.missingStorage + 1,
      missingExpectedVersion: baseline.reasons.missingExpectedVersion + 1,
      missingAssociation: baseline.reasons.missingAssociation + 1,
      wrongStorage: baseline.reasons.wrongStorage + 1,
      staleAssociation: baseline.reasons.staleAssociation + 1,
      headMismatch: baseline.reasons.headMismatch + 1,
    });
    expect(result.verified + result.unresolved).toBe(result.total);
    expect(
      Object.values(result.reasons).reduce((sum, count) => {
        return sum + count;
      }, 0),
    ).toBe(result.unresolved);
    expect(result.complete).toBeFalsy();
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("repairs an existing exact version without uploading", async () => {
    const actor = bdd.user({ orgRole: "org:admin" });
    const connector = await createTrackedConnector(
      actor,
      "Exact registered skill",
    );
    const before = await readState(connector.id);
    const expectedVersionId = requireVersionId(
      before.connector.skillStorageVersionId,
      "Expected the registered version",
    );
    await setConnectorState(connector.id, { skillStorageVersionId: null });
    context.mocks.s3.send.mockClear();

    const result = await repair();
    const repairedState = await readState(connector.id);

    expect(result.body).toMatchObject({
      success: true,
      attempted: 1,
      repaired: 1,
      conflicts: 0,
    });
    expect(repairedState.connector.skillStorageVersionId).toBe(
      expectedVersionId,
    );
    expect(repairedState.storage?.headVersionId).toBe(expectedVersionId);
    expect(s3PutCalls()).toHaveLength(0);
  });

  it("keeps user-created Feishu adapters on ordinary skill metadata", async () => {
    const actor = bdd.user({ orgRole: "org:admin" });
    const connector = await createTrackedOauthConnector(
      actor,
      "Custom Feishu adapter v1",
    );
    await setProviderAdapter(connector.id, "feishu");
    await setConnectorState(connector.id, {
      skillMarkdown: "Custom Feishu adapter v2",
    });
    context.mocks.s3.send.mockClear();

    const result = await repair();
    const repairedState = await readState(connector.id);
    const repairedSkill = uploadedSkillMarkdown();

    expect(result.body).toMatchObject({ attempted: 1, repaired: 1 });
    expect(repairedState.connector).toMatchObject({
      oauthProviderAdapter: "feishu",
      managedFeishuInstallationId: null,
    });
    expect(repairedState.storage?.headVersionId).toBe(
      repairedState.connector.skillStorageVersionId,
    );
    expect(repairedSkill).toContain(
      `name: ${getCustomConnectorSkillName(connector.slug, connector.id)}`,
    );
    expect(repairedSkill).toContain(`description: ${connector.displayName}`);
    expect(repairedSkill).toContain("Custom Feishu adapter v2");
  });

  it("uses the live managed Feishu skill metadata during repair", async () => {
    const actor = bdd.user({ orgRole: "org:admin" });
    const agent = await bdd.createAgent(actor, {
      displayName: "Managed Feishu repair agent",
    });
    const installationId = randomUUID();
    const connector = await createTrackedOauthConnector(
      actor,
      "Managed Feishu repair instruction",
    );
    const initialVersionId = requireVersionId(
      (await readState(connector.id)).connector.skillStorageVersionId,
      "Expected the initial ordinary version",
    );
    await setManagedFeishuInstallation(
      connector.id,
      installationId,
      agent.agentId,
    );
    managedFeishuInstallations.push({
      connectorId: connector.id,
      installationId,
    });
    context.mocks.s3.send.mockClear();

    const result = await repair();
    const repairedState = await readState(connector.id);
    const repairedSkill = uploadedSkillMarkdown();

    expect(result.body).toMatchObject({ attempted: 1, repaired: 1 });
    expect(repairedState.connector).toMatchObject({
      oauthProviderAdapter: "standard",
      managedFeishuInstallationId: installationId,
    });
    expect(repairedState.connector.skillStorageVersionId).not.toBe(
      initialVersionId,
    );
    expect(repairedState.storage?.headVersionId).toBe(
      repairedState.connector.skillStorageVersionId,
    );
    expect(repairedSkill).toContain("---\nname: feishu\n");
    expect(repairedSkill).toContain(
      "description: Feishu OpenAPI for user-authorized messaging, people search, cloud",
    );
    expect(repairedSkill).not.toContain(connector.displayName);
    expect(repairedSkill).not.toContain(connector.id);
  });

  it("aligns stale HEAD and clears inverse-invalid pointers without uploading", async () => {
    const actor = bdd.user({ orgRole: "org:admin" });
    const headConnector = await createTrackedConnector(actor, "HEAD old");
    const previousHeadId = requireVersionId(
      (await readState(headConnector.id)).storage?.headVersionId ?? null,
      "Expected an old HEAD",
    );
    await updateSkill(actor, headConnector, "HEAD current");
    const expectedHeadId = requireVersionId(
      (await readState(headConnector.id)).connector.skillStorageVersionId,
      "Expected the current version",
    );
    await setHead(headConnector.id, previousHeadId);

    const noSkillConnector = await createTrackedConnector(
      actor,
      "Temporary skill",
    );
    const noSkillBefore = await readState(noSkillConnector.id);
    await setConnectorState(noSkillConnector.id, { skillMarkdown: null });
    context.mocks.s3.send.mockClear();

    const result = await repair();
    const repairedHead = await readState(headConnector.id);
    const repairedNoSkill = await readState(noSkillConnector.id);

    expect(result.body).toMatchObject({ attempted: 2, repaired: 2 });
    expect(repairedHead.connector.skillStorageVersionId).toBe(expectedHeadId);
    expect(repairedHead.storage?.headVersionId).toBe(expectedHeadId);
    expect(repairedNoSkill.connector).toMatchObject({
      skillMarkdown: null,
      skillStorageVersionId: null,
    });
    expect(repairedNoSkill.storage).toStrictEqual(noSkillBefore.storage);
    expect(s3PutCalls()).toHaveLength(0);
  });

  it("bounds each mutation invocation to five unresolved connectors", async () => {
    const actor = bdd.user({ orgRole: "org:admin" });
    const connectors: CustomConnectorHttpResponse[] = [];
    for (let index = 0; index < 6; index += 1) {
      const connector = await createTrackedConnector(actor, null);
      await setConnectorState(connector.id, {
        skillMarkdown: `Backfilled skill ${index}`,
      });
      connectors.push(connector);
    }

    const first = await repair();
    const firstStates = await Promise.all(
      connectors.map(({ id }) => {
        return readState(id);
      }),
    );
    const firstRepaired = firstStates.filter((state) => {
      return (
        state.connector.skillStorageVersionId !== null &&
        state.storage?.headVersionId === state.connector.skillStorageVersionId
      );
    });

    expect(first.body).toMatchObject({ attempted: 5, repaired: 5 });
    expect(firstRepaired).toHaveLength(5);

    const second = await repair();
    const secondStates = await Promise.all(
      connectors.map(({ id }) => {
        return readState(id);
      }),
    );
    expect(second.body).toMatchObject({ attempted: 1, repaired: 1 });
    expect(
      secondStates.every((state) => {
        return (
          state.connector.skillStorageVersionId !== null &&
          state.storage?.headVersionId === state.connector.skillStorageVersionId
        );
      }),
    ).toBeTruthy();
  });

  it("leaves a failed upload unresolved and repairs it on retry", async () => {
    const actor = bdd.user({ orgRole: "org:admin" });
    const connector = await createTrackedConnector(actor, "Upload v1");
    const initial = await readState(connector.id);
    await setConnectorState(connector.id, { skillMarkdown: "Upload v2" });
    context.mocks.s3.send.mockResolvedValue({ ContentLength: 1024 });
    context.mocks.s3.send.mockRejectedValueOnce(
      new Error("Injected repair upload failure"),
    );

    await accept(cronClient().repair({ headers: cronHeaders() }), [500]);
    const failedState = await readState(connector.id);
    expect(failedState.connector.skillStorageVersionId).toBe(
      initial.connector.skillStorageVersionId,
    );
    expect(failedState.storage?.headVersionId).toBe(
      initial.storage?.headVersionId,
    );

    context.mocks.s3.send.mockResolvedValue({ ContentLength: 1024 });
    const retried = await repair();
    const repairedState = await readState(connector.id);
    expect(retried.body).toMatchObject({ attempted: 1, repaired: 1 });
    expect(repairedState.connector.skillStorageVersionId).not.toBe(
      initial.connector.skillStorageVersionId,
    );
    expect(repairedState.storage?.headVersionId).toBe(
      repairedState.connector.skillStorageVersionId,
    );
  });

  it("does not bind a prepared artifact after authoritative source changes", async () => {
    const actor = bdd.user({ orgRole: "org:admin" });
    const connector = await createTrackedConnector(actor, "Concurrent v1");
    const initial = await readState(connector.id);
    await setConnectorState(connector.id, { skillMarkdown: "Concurrent v2" });
    const uploadReached = createDeferredPromise<void>(context.signal);
    const uploadRelease = createDeferredPromise<unknown>(context.signal);
    let heldUpload = false;
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (!heldUpload && commandName(command) === "PutObjectCommand") {
        heldUpload = true;
        uploadReached.resolve();
        return uploadRelease.promise;
      }
      return Promise.resolve({ ContentLength: 1024 });
    });

    const pendingRepair = cronClient().repair({ headers: cronHeaders() });
    await uploadReached.promise;
    await setConnectorState(connector.id, { skillMarkdown: "Concurrent v3" });
    uploadRelease.resolve({});
    const result = await accept(pendingRepair, [200]);
    const finalState = await readState(connector.id);

    expect(result.body).toMatchObject({
      attempted: 1,
      repaired: 0,
      conflicts: 1,
    });
    expect(finalState.connector).toMatchObject({
      skillMarkdown: "Concurrent v3",
      skillStorageVersionId: initial.connector.skillStorageVersionId,
    });
    expect(finalState.storage?.headVersionId).toBe(
      initial.storage?.headVersionId,
    );
  });
});
