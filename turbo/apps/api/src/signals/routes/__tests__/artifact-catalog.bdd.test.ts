import { createHash, randomUUID } from "node:crypto";

import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { testContext } from "../../../__tests__/test-helpers";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import {
  createChatFilesBddApi,
  hostedTextFile,
} from "./helpers/api-bdd-chat-files";
import { createHostMapsBddApi } from "./helpers/api-bdd-host-maps";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  insertHostedDeploymentAsPreviousApi,
  insertHostedSiteAsPreviousApi,
  insertLegacyArtifactCatalogFile,
} from "./helpers/runtime-state";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const host = createHostMapsBddApi(context);
const webhooks = createWebhookCallbackApi(context);

type RunnerClaim = Awaited<ReturnType<typeof api.claimRunnerJob>>;
interface CatalogActor {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
}

/**
 * Stage an uploadable object. The object-storage mock is global, so the store
 * is re-accepted per upload to keep tests with more than one actor working.
 */
function stageUploadObject(key: string, size: number): void {
  chatCallbacks
    .acceptChatObjectStorage()
    .addObject({ bucket: "test-user-artifacts", key, size });
}

async function catalogActor(
  displayName: string,
  actor: ApiTestUser = bdd.user(),
  switches: Readonly<Partial<Record<FeatureSwitchKey, boolean>>> = {},
  options: { readonly bootstrapOrg?: boolean } = {},
): Promise<CatalogActor> {
  chatCallbacks.acceptChatObjectStorage();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  chatCallbacks.disableVapid();
  const runnerGroup = api.configureRunnerGroup();
  if (options.bootstrapOrg !== false) {
    await api.grantProEntitlement(actor);
    await api.ensureOrgModelProvider(actor);
  }
  if (!actor.orgId) {
    throw new Error("Expected artifact catalog test actor to have an org");
  }
  await updateFeatureSwitchesForUser(
    context,
    { userId: actor.userId, orgId: actor.orgId },
    { [FeatureSwitchKey.Artifacts]: true, ...switches },
  );
  const agent = await bdd.createAgent(actor, {
    displayName,
    visibility: "private",
  });
  return { actor, agentId: agent.agentId, runnerGroup };
}

async function sendChatRun(
  actor: ApiTestUser,
  body: {
    readonly agentId: string;
    readonly prompt: string;
    readonly threadId?: string;
  },
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const sent = await chat.requestSendEvent(actor, body, [201]);
  if (sent.status !== 201 || sent.body.runId === null) {
    throw new Error("Expected chat send to create a run");
  }
  return { runId: sent.body.runId, threadId: sent.body.threadId };
}

async function claimChatRun(
  runnerGroup: string,
  runId: string,
): Promise<{
  readonly claim: RunnerClaim;
  readonly sandboxHeaders: { readonly authorization: string };
}> {
  await api.heartbeatRunner(runnerGroup);
  const claim = await api.claimRunnerJob(runId);
  return {
    claim,
    sandboxHeaders: { authorization: `Bearer ${claim.sandboxToken}` },
  };
}

function zeroTokenFromClaim(claim: RunnerClaim): string {
  const token = claim.environment?.ZERO_TOKEN;
  if (!token || !token.startsWith("vm0_sandbox_")) {
    throw new Error("Expected the claim environment to carry a ZERO_TOKEN");
  }
  return token;
}

async function completeChatRunOk(
  runId: string,
  sandboxHeaders: { readonly authorization: string },
): Promise<void> {
  const historyHash = createHash("sha256")
    .update(`bdd artifact catalog history ${runId}`)
    .digest("hex");
  await webhooks.requestAgentCheckpoint(
    {
      runId,
      cliAgentType: "claude-code",
      cliAgentSessionId: `bdd-cli-${runId}`,
      cliAgentSessionHistoryHash: historyHash,
    },
    sandboxHeaders,
    [200],
  );
  await webhooks.requestAgentComplete(
    { runId, exitCode: 0 },
    sandboxHeaders,
    [200],
  );
}

async function uploadFile(args: {
  readonly owner: CatalogActor;
  readonly prompt: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes?: number;
  readonly fileId?: string;
}): Promise<{
  readonly fileId: string;
  readonly url: string;
  readonly threadId: string;
}> {
  const run = await sendChatRun(args.owner.actor, {
    agentId: args.owner.agentId,
    prompt: args.prompt,
  });
  const { claim, sandboxHeaders } = await claimChatRun(
    args.owner.runnerGroup,
    run.runId,
  );
  const bearer = `Bearer ${zeroTokenFromClaim(claim)}`;
  const fileId = args.fileId ?? randomUUID();
  stageUploadObject(
    `artifacts/${args.owner.actor.userId}/${fileId}/${args.filename}`,
    args.sizeBytes ?? 1024,
  );
  const completed = await chat.completeUploadWithBearer(
    bearer,
    { id: fileId, contentType: args.contentType },
    [200],
  );
  if (completed.status !== 200) {
    throw new Error("Expected run upload completion to succeed");
  }
  await completeChatRunOk(run.runId, sandboxHeaders);
  return { fileId, url: completed.body.url, threadId: run.threadId };
}

async function insertLegacyCatalogFile(args: {
  readonly owner: CatalogActor;
  readonly filename: string;
  readonly url: string;
}): Promise<string> {
  if (!args.owner.actor.orgId) {
    throw new Error("Expected artifact catalog actor to have an org");
  }

  // The previous API version cannot be invoked through the current route
  // boundary. The guarded test route reproduces its schema-compatible insert
  // so the public catalog endpoint proves migration-trigger reconciliation.
  return await insertLegacyArtifactCatalogFile(context, {
    userId: args.owner.actor.userId,
    orgId: args.owner.actor.orgId,
    filename: args.filename,
    url: args.url,
  });
}

async function publishHostedSite(args: {
  readonly owner: CatalogActor;
  readonly site: string;
  readonly artifactKind?: "hosted-site" | "presentation-html";
  readonly deployments?: number;
  readonly threadId?: string;
  readonly claimRun?: boolean;
}): Promise<{
  readonly url: string;
  readonly siteId: string;
  readonly publicSlug: string;
  readonly deploymentId: string;
  readonly deploymentVersion?: number;
  readonly runId: string;
  readonly threadId: string;
}> {
  const run = await sendChatRun(args.owner.actor, {
    agentId: args.owner.agentId,
    prompt: `publish ${args.site}`,
    ...(args.threadId === undefined ? {} : { threadId: args.threadId }),
  });
  const claimed =
    args.claimRun === false
      ? null
      : await claimChatRun(args.owner.runnerGroup, run.runId);
  const bearer =
    claimed === null
      ? `Bearer ${scopedZeroToken(args.owner, run.runId, ["host:write"])}`
      : `Bearer ${zeroTokenFromClaim(claimed.claim)}`;
  const body = {
    site: args.site,
    artifactKind: args.artifactKind ?? ("hosted-site" as const),
    spaFallback: false,
    files: [hostedTextFile("/index.html", `<main>${args.site}</main>`)],
  };

  let prepared = await chat.prepareHostedSiteWithBearer(bearer, body);
  await chat.completeHostedSiteWithBearer(bearer, prepared.deploymentId);
  for (let index = 1; index < (args.deployments ?? 1); index += 1) {
    prepared = await chat.prepareHostedSiteWithBearer(bearer, body);
    await chat.completeHostedSiteWithBearer(bearer, prepared.deploymentId);
  }
  if (claimed !== null) {
    await completeChatRunOk(run.runId, claimed.sandboxHeaders);
  }
  return {
    url: prepared.url,
    siteId: prepared.siteId,
    publicSlug: prepared.publicSlug,
    deploymentId: prepared.deploymentId,
    ...(prepared.deploymentVersion === undefined
      ? {}
      : { deploymentVersion: prepared.deploymentVersion }),
    runId: run.runId,
    threadId: run.threadId,
  };
}

async function publishHostedSiteFromDirectRun(args: {
  readonly owner: CatalogActor;
  readonly site: string;
  readonly artifactKind?: "hosted-site" | "presentation-html";
  readonly runId?: string;
}): Promise<{
  readonly url: string;
  readonly siteId: string;
  readonly publicSlug: string;
  readonly runId: string;
}> {
  const runId =
    args.runId ??
    (
      await api.createDirectRun(args.owner.actor, {
        agentComposeId: args.owner.agentId,
        prompt: `publish ${args.site}`,
        modelProviderType: "anthropic-api-key",
        triggerSource: "workflow-schedule",
        vars: { ZERO_AGENT_ID: args.owner.agentId },
        secrets: { ZERO_TOKEN: "bdd-artifact-catalog-token" },
      })
    ).runId;
  const bearer = `Bearer ${scopedZeroToken(args.owner, runId, ["host:write"])}`;
  const prepared = await chat.prepareHostedSiteWithBearer(bearer, {
    site: args.site,
    artifactKind: args.artifactKind ?? "hosted-site",
    spaFallback: false,
    files: [hostedTextFile("/index.html", `<main>${args.site}</main>`)],
  });
  await chat.completeHostedSiteWithBearer(bearer, prepared.deploymentId);
  return {
    url: prepared.url,
    siteId: prepared.siteId,
    publicSlug: prepared.publicSlug,
    runId,
  };
}

function scopedZeroToken(
  owner: CatalogActor,
  runId: string,
  capabilities: readonly ("file:write" | "host:read" | "host:write")[],
): string {
  if (!owner.actor.orgId) {
    throw new Error("Expected artifact catalog actor to have an org");
  }
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "zero",
    userId: owner.actor.userId,
    orgId: owner.actor.orgId,
    runId,
    capabilities,
    iat: seconds,
    exp: seconds + 60,
  });
}

describe("GET /api/zero/artifacts/catalog", () => {
  it("lists an uploaded file as one artifact and hides other callers", async () => {
    const owner = await catalogActor("Artifact catalog owner");
    const outsider = await catalogActor("Artifact catalog outsider");
    const uploaded = await uploadFile({
      owner,
      prompt: "upload a report",
      filename: "quarterly-report.txt",
      contentType: "text/plain",
      sizeBytes: 256,
    });
    await uploadFile({
      owner: outsider,
      prompt: "upload another report",
      filename: "outsider-report.txt",
      contentType: "text/plain",
    });

    const catalog = await chat.listArtifactCatalog(owner.actor);

    expect(catalog.nextCursor).toBeNull();
    expect(catalog.artifacts).toStrictEqual([
      {
        id: expect.any(String),
        kind: "file",
        title: "quarterly-report.txt",
        thumbnail: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    ]);

    const artifactId = catalog.artifacts[0]?.id;
    if (!artifactId) {
      throw new Error("Expected the catalog to list the uploaded artifact");
    }
    const detail = await chat.getArtifactCatalogEntry(owner.actor, artifactId);
    if (detail.kind !== "file") {
      throw new Error("Expected an uploaded file to be catalogued as a file");
    }
    expect(detail.file).toStrictEqual({
      id: expect.any(String),
      filename: "quarterly-report.txt",
      contentType: "text/plain",
      size: 256,
      url: uploaded.url,
      previewImageUrl: null,
    });
  }, 180_000);

  it("keeps repeated projections of one file URL as one artifact", async () => {
    const owner = await catalogActor("Artifact catalog repeated URL owner");
    const fileId = randomUUID();

    await uploadFile({
      owner,
      prompt: "upload a report for the first run",
      filename: "repeatable-report.txt",
      contentType: "text/plain",
      fileId,
    });
    await uploadFile({
      owner,
      prompt: "upload the same report for a later run",
      filename: "repeatable-report.txt",
      contentType: "text/plain",
      fileId,
    });

    const catalog = await chat.listArtifactCatalog(owner.actor);

    expect(catalog.artifacts).toStrictEqual([
      expect.objectContaining({
        kind: "file",
        title: "repeatable-report.txt",
      }),
    ]);
  }, 180_000);

  it("reconciles a file written by the previous API after migration", async () => {
    const owner = await catalogActor("Artifact catalog promotion owner");
    const url = `https://files.vm0.test/${randomUUID()}/legacy-output.zip`;
    const fileId = await insertLegacyCatalogFile({
      owner,
      filename: "legacy-output.zip",
      url,
    });

    const catalog = await chat.listArtifactCatalog(owner.actor);
    expect(catalog.artifacts).toStrictEqual([
      expect.objectContaining({
        kind: "file",
        title: "legacy-output.zip",
      }),
    ]);

    const artifactId = catalog.artifacts[0]?.id;
    if (!artifactId) {
      throw new Error("Expected the reconciled artifact to be listed");
    }
    const detail = await chat.getArtifactCatalogEntry(owner.actor, artifactId);
    if (detail.kind !== "file") {
      throw new Error("Expected the reconciled artifact to be a file");
    }
    expect(detail.file).toMatchObject({ id: fileId, url });
  }, 180_000);

  it("removes catalog rows when deleting the backing agent", async () => {
    const owner = await catalogActor("Artifact catalog deletion owner");
    await uploadFile({
      owner,
      prompt: "upload a disposable report",
      filename: "disposable-report.txt",
      contentType: "text/plain",
    });
    expect(
      (await chat.listArtifactCatalog(owner.actor)).artifacts,
    ).toHaveLength(1);

    await flushWaitUntilForTest();
    await bdd.deleteAgent(owner.actor, owner.agentId);

    await expect(chat.listArtifactCatalog(owner.actor)).resolves.toStrictEqual({
      artifacts: [],
      nextCursor: null,
    });
  }, 180_000);

  it("collapses every deployment of a hosted site into one artifact", async () => {
    const owner = await catalogActor(
      "Artifact catalog hosted owner",
      bdd.user(),
      {
        [FeatureSwitchKey.HostedArtifactVersions]: true,
      },
    );
    const site = `catalog-site-${randomUUID().slice(0, 8)}`;
    const hosted = await publishHostedSite({ owner, site, deployments: 2 });

    const catalog = await chat.listArtifactCatalog(owner.actor);

    expect(catalog.artifacts).toHaveLength(1);
    expect(catalog.artifacts[0]).toMatchObject({
      kind: "hosted-site",
      title: site,
    });

    const artifactId = catalog.artifacts[0]?.id;
    if (!artifactId) {
      throw new Error("Expected the catalog to list the hosted site");
    }
    const detail = await chat.getArtifactCatalogEntry(owner.actor, artifactId);
    if (detail.kind !== "hosted-site") {
      throw new Error("Expected a hosted site to be catalogued as hosted-site");
    }
    expect(detail.site).toMatchObject({
      id: hosted.siteId,
      slug: site,
      deploymentVersion: 2,
      entrypoint: "/index.html",
      spaFallback: false,
    });
  }, 180_000);

  it("isolates same-slug hosted sites by chat thread", async () => {
    const owner = await catalogActor(
      "Artifact catalog chat-scoped hosted owner",
      bdd.user(),
      {
        [FeatureSwitchKey.HostedArtifactVersions]: true,
      },
    );
    host.captureHostedSitesS3();
    const site = `catalog-chat-scope-${randomUUID().slice(0, 8)}`;

    const first = await publishHostedSite({ owner, site });
    const firstRedeploy = await publishHostedSite({
      owner,
      site,
      threadId: first.threadId,
      claimRun: false,
    });
    const secondChat = await publishHostedSite({
      owner,
      site,
      claimRun: false,
    });

    expect(firstRedeploy).toMatchObject({
      siteId: first.siteId,
      publicSlug: first.publicSlug,
      url: first.url,
      deploymentVersion: 2,
      threadId: first.threadId,
    });
    expect(firstRedeploy.deploymentId).not.toBe(first.deploymentId);
    expect(secondChat).toMatchObject({ deploymentVersion: 1 });
    expect(secondChat.siteId).not.toBe(first.siteId);
    expect(secondChat.publicSlug).not.toBe(first.publicSlug);
    expect(secondChat.url).not.toBe(first.url);
    expect(secondChat.threadId).not.toBe(first.threadId);

    const firstHistory = await chat.readHostedSiteDeploymentsWithBearer(
      `Bearer ${scopedZeroToken(owner, firstRedeploy.runId, ["host:read"])}`,
      site,
    );
    const secondHistory = await chat.readHostedSiteDeploymentsWithBearer(
      `Bearer ${scopedZeroToken(owner, secondChat.runId, ["host:read"])}`,
      site,
    );
    expect(firstHistory).toMatchObject({
      siteId: first.siteId,
      publicSlug: first.publicSlug,
    });
    expect(firstHistory.deployments).toHaveLength(2);
    expect(secondHistory).toMatchObject({
      siteId: secondChat.siteId,
      publicSlug: secondChat.publicSlug,
    });
    expect(secondHistory.deployments).toHaveLength(1);

    const crossChatComplete = await chat.requestCompleteHostedSiteWithBearer(
      `Bearer ${scopedZeroToken(owner, secondChat.runId, ["host:write"])}`,
      firstRedeploy.deploymentId,
      [409],
    );
    expectApiError(crossChatComplete.body);
    expect(crossChatComplete.body.error).toStrictEqual({
      code: "CONFLICT",
      message: "Hosted deployment belongs to a different chat",
    });

    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/hosted-sites/download?sig=bdd",
    );
    const firstActive = await host.readHostedSiteFiles(
      owner.actor,
      first.publicSlug,
    );
    const secondActive = await host.readHostedSiteFiles(
      owner.actor,
      secondChat.publicSlug,
    );
    expect(firstActive).toMatchObject({
      siteId: first.siteId,
      deploymentId: firstRedeploy.deploymentId,
      deploymentVersion: 2,
    });
    expect(secondActive).toMatchObject({
      siteId: secondChat.siteId,
      deploymentId: secondChat.deploymentId,
      deploymentVersion: 1,
    });

    const catalog = await chat.listArtifactCatalog(owner.actor);
    const entries = catalog.artifacts.filter((artifact) => {
      return artifact.title === site;
    });
    expect(entries).toHaveLength(2);
    const details = await Promise.all(
      entries.map(async (entry) => {
        return await chat.getArtifactCatalogEntry(owner.actor, entry.id);
      }),
    );
    expect(
      details.map((detail) => {
        if (detail.kind !== "hosted-site") {
          throw new Error("Expected a chat-scoped hosted-site catalog entry");
        }
        return detail.site.id;
      }),
    ).toStrictEqual(expect.arrayContaining([first.siteId, secondChat.siteId]));
  }, 180_000);

  it("rejects chat adoption of an organization-scoped site", async () => {
    const owner = await catalogActor(
      "Artifact catalog mixed-scope hosted owner",
      bdd.user(),
      {
        [FeatureSwitchKey.HostedArtifactVersions]: true,
      },
    );
    host.captureHostedSitesS3();
    const site = `catalog-mixed-scope-${randomUUID().slice(0, 8)}`;

    const organizationSite = await publishHostedSiteFromDirectRun({
      owner,
      site,
    });
    const chatRun = await sendChatRun(owner.actor, {
      agentId: owner.agentId,
      prompt: `publish ${site} from a chat`,
    });
    const chatBearer = `Bearer ${scopedZeroToken(owner, chatRun.runId, [
      "host:write",
    ])}`;
    const rejected = await chat.requestPrepareHostedSiteWithBearer(
      chatBearer,
      {
        site,
        artifactKind: "hosted-site",
        spaFallback: false,
        files: [hostedTextFile("/index.html", `<main>${site}</main>`)],
      },
      [409],
    );
    const organizationRedeploy = await publishHostedSiteFromDirectRun({
      owner,
      site,
      runId: organizationSite.runId,
    });

    expectApiError(rejected.body);
    expect(rejected.body.error).toStrictEqual({
      code: "CONFLICT",
      message: `Hosted site slug "${site}" is owned outside this chat. Choose a different --site value and rerun the same zero host command.`,
    });
    expect(organizationRedeploy).toMatchObject({
      siteId: organizationSite.siteId,
      publicSlug: organizationSite.publicSlug,
    });

    const catalog = await chat.listArtifactCatalog(owner.actor);
    expect(
      catalog.artifacts.filter((artifact) => {
        return artifact.title === site;
      }),
    ).toHaveLength(1);
  }, 180_000);

  it("adopts previous-API site writes only within their owning chat", async () => {
    const owner = await catalogActor(
      "Artifact catalog previous API hosted owner",
      bdd.user(),
      {
        [FeatureSwitchKey.HostedArtifactVersions]: true,
      },
    );
    if (!owner.actor.orgId) {
      throw new Error("Expected previous API hosted owner to have an org");
    }
    host.captureHostedSitesS3();
    const site = `catalog-previous-api-${randomUUID().slice(0, 8)}`;
    const firstRun = await sendChatRun(owner.actor, {
      agentId: owner.agentId,
      prompt: `publish ${site} from the previous API`,
    });
    const previousSiteId = await insertHostedSiteAsPreviousApi(context, {
      userId: owner.actor.userId,
      orgId: owner.actor.orgId,
      runId: firstRun.runId,
      site,
      publicSlug: site,
    });
    const body = {
      site,
      artifactKind: "hosted-site" as const,
      spaFallback: false,
      files: [hostedTextFile("/index.html", `<main>${site}</main>`)],
    };

    const firstBearer = `Bearer ${scopedZeroToken(owner, firstRun.runId, [
      "host:write",
    ])}`;
    const first = await chat.prepareHostedSiteWithBearer(firstBearer, body);
    expect(first).toMatchObject({
      siteId: previousSiteId,
      publicSlug: site,
      deploymentVersion: 1,
    });
    await chat.completeHostedSiteWithBearer(firstBearer, first.deploymentId);

    const secondRun = await sendChatRun(owner.actor, {
      agentId: owner.agentId,
      prompt: `publish ${site} from another chat`,
    });
    const secondBearer = `Bearer ${scopedZeroToken(owner, secondRun.runId, [
      "host:write",
    ])}`;
    await expect(
      insertHostedDeploymentAsPreviousApi(context, {
        userId: owner.actor.userId,
        orgId: owner.actor.orgId,
        runId: secondRun.runId,
        hostedSiteId: previousSiteId,
      }),
    ).resolves.toBeTruthy();
    const second = await chat.prepareHostedSiteWithBearer(secondBearer, body);
    expect(second).toMatchObject({ deploymentVersion: 1 });
    expect(second.siteId).not.toBe(previousSiteId);
    expect(second.publicSlug).not.toBe(site);
  }, 180_000);

  it("catalogues a published deck as a presentation", async () => {
    const owner = await catalogActor("Artifact catalog deck owner");
    const site = `catalog-deck-${randomUUID().slice(0, 8)}`;
    await publishHostedSite({
      owner,
      site,
      artifactKind: "presentation-html",
    });

    const catalog = await chat.listArtifactCatalog(owner.actor, {
      kind: "presentation",
    });

    expect(catalog.artifacts).toHaveLength(1);
    expect(catalog.artifacts[0]).toMatchObject({
      kind: "presentation",
      title: site,
    });
  }, 180_000);

  it("keeps one card when a hosted site becomes a presentation", async () => {
    const owner = await catalogActor(
      "Artifact catalog hosted transition owner",
      bdd.user(),
      {
        [FeatureSwitchKey.HostedArtifactVersions]: true,
      },
    );
    const site = `catalog-transition-${randomUUID().slice(0, 8)}`;
    const hosted = await publishHostedSite({
      owner,
      site,
      artifactKind: "hosted-site",
    });
    const presentation = await publishHostedSite({
      owner,
      site,
      artifactKind: "presentation-html",
      threadId: hosted.threadId,
      claimRun: false,
    });

    expect(presentation.siteId).toBe(hosted.siteId);
    const catalog = await chat.listArtifactCatalog(owner.actor);
    expect(catalog.artifacts).toStrictEqual([
      expect.objectContaining({
        kind: "presentation",
        title: site,
      }),
    ]);
  }, 180_000);

  it("transfers one hosted artifact across same-org member redeploys", async () => {
    const orgId = `org_${randomUUID()}`;
    const firstOwner = await catalogActor(
      "Artifact catalog first org member",
      bdd.user({ orgId, orgRole: "org:admin" }),
      {
        [FeatureSwitchKey.HostedArtifactVersions]: true,
      },
    );
    const secondOwner = await catalogActor(
      "Artifact catalog second org member",
      bdd.user({ orgId, orgRole: "org:member" }),
      {
        [FeatureSwitchKey.HostedArtifactVersions]: true,
      },
      { bootstrapOrg: false },
    );
    const site = `catalog-shared-${randomUUID().slice(0, 8)}`;
    const firstDeployment = await publishHostedSiteFromDirectRun({
      owner: firstOwner,
      site,
    });
    const secondDeployment = await publishHostedSiteFromDirectRun({
      owner: secondOwner,
      site,
    });

    expect(secondDeployment.siteId).toBe(firstDeployment.siteId);
    await expect(
      chat.listArtifactCatalog(firstOwner.actor),
    ).resolves.toStrictEqual({
      artifacts: [],
      nextCursor: null,
    });
    const secondCatalog = await chat.listArtifactCatalog(secondOwner.actor);
    expect(secondCatalog.artifacts).toStrictEqual([
      expect.objectContaining({
        kind: "hosted-site",
        title: site,
      }),
    ]);

    const presentation = await publishHostedSiteFromDirectRun({
      owner: firstOwner,
      site,
      artifactKind: "presentation-html",
      runId: firstDeployment.runId,
    });

    expect(presentation.siteId).toBe(firstDeployment.siteId);
    await expect(
      chat.listArtifactCatalog(secondOwner.actor),
    ).resolves.toStrictEqual({
      artifacts: [],
      nextCursor: null,
    });
    const finalCatalog = await chat.listArtifactCatalog(firstOwner.actor);
    expect(finalCatalog.artifacts).toStrictEqual([
      expect.objectContaining({
        kind: "presentation",
        title: site,
      }),
    ]);
  }, 180_000);

  it("filters by kind without leaking other kinds", async () => {
    const owner = await catalogActor("Artifact catalog filter owner");
    await uploadFile({
      owner,
      prompt: "upload notes",
      filename: "notes.txt",
      contentType: "text/plain",
    });
    const site = `catalog-filter-${randomUUID().slice(0, 8)}`;
    await publishHostedSite({ owner, site });

    const files = await chat.listArtifactCatalog(owner.actor, { kind: "file" });
    const sites = await chat.listArtifactCatalog(owner.actor, {
      kind: "hosted-site",
    });

    expect(
      files.artifacts.map((artifact) => {
        return artifact.kind;
      }),
    ).toStrictEqual(["file"]);
    expect(
      sites.artifacts.map((artifact) => {
        return artifact.title;
      }),
    ).toStrictEqual([site]);
  }, 180_000);

  it("walks the whole catalog through the cursor without repeats or gaps", async () => {
    const owner = await catalogActor("Artifact catalog paging owner");
    const created: string[] = [];
    for (const label of ["one", "two", "three"]) {
      const uploaded = await uploadFile({
        owner,
        prompt: `upload ${label}`,
        filename: `page-${label}.txt`,
        contentType: "text/plain",
      });
      created.push(uploaded.fileId);
    }

    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await chat.listArtifactCatalog(owner.actor, {
        limit: 1,
        cursor,
      });
      expect(page.artifacts.length).toBeLessThanOrEqual(1);
      collected.push(
        ...page.artifacts.map((artifact) => {
          return artifact.title;
        }),
      );
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(10);
    } while (cursor);

    expect(collected).toStrictEqual([
      "page-three.txt",
      "page-two.txt",
      "page-one.txt",
    ]);
    expect(new Set(collected).size).toBe(created.length);
  }, 180_000);

  it("keeps a workflow run artifact under the owning vm0 user", async () => {
    const owner = await catalogActor("Artifact catalog workflow owner");
    const run = await api.createDirectRun(owner.actor, {
      agentComposeId: owner.agentId,
      prompt: "create a workflow artifact",
      modelProviderType: "anthropic-api-key",
      triggerSource: "workflow-schedule",
      vars: { ZERO_AGENT_ID: owner.agentId },
      secrets: { ZERO_TOKEN: "bdd-artifact-catalog-token" },
    });
    const fileId = randomUUID();
    stageUploadObject(
      `artifacts/${owner.actor.userId}/${fileId}/workflow-output.txt`,
      128,
    );
    await chat.completeUploadWithBearer(
      `Bearer ${scopedZeroToken(owner, run.runId, ["file:write"])}`,
      { id: fileId, contentType: "text/plain" },
      [200],
    );

    const catalog = await chat.listArtifactCatalog(owner.actor);

    expect(catalog.artifacts).toStrictEqual([
      expect.objectContaining({
        kind: "file",
        title: "workflow-output.txt",
      }),
    ]);
  }, 180_000);

  it("hides an artifact owned by another caller behind a 404", async () => {
    const owner = await catalogActor("Artifact catalog private owner");
    const outsider = await catalogActor("Artifact catalog prying outsider");
    await uploadFile({
      owner,
      prompt: "upload a private file",
      filename: "private.txt",
      contentType: "text/plain",
    });
    const catalog = await chat.listArtifactCatalog(owner.actor);
    const artifactId = catalog.artifacts[0]?.id;
    if (!artifactId) {
      throw new Error("Expected the owner to see their artifact");
    }

    const denied = await chat.requestArtifactCatalogEntry(
      outsider.actor,
      artifactId,
      [404],
    );

    if (denied.status !== 404) {
      throw new Error("Expected a foreign artifact request to 404");
    }
    expect(denied.body.error.code).toBe("NOT_FOUND");
  }, 180_000);

  it("serves the catalog regardless of the Artifacts feature switch", async () => {
    const owner = await catalogActor(
      "Artifact catalog switch-off owner",
      bdd.user(),
      { [FeatureSwitchKey.Artifacts]: false },
    );
    await uploadFile({
      owner,
      prompt: "upload despite the switch",
      filename: "ungated.txt",
      contentType: "text/plain",
    });

    const catalog = await chat.listArtifactCatalog(owner.actor);

    expect(catalog.artifacts).toStrictEqual([
      expect.objectContaining({ kind: "file", title: "ungated.txt" }),
    ]);
  }, 180_000);

  it("scopes the catalog to one chat thread when chatThreadId is set", async () => {
    const owner = await catalogActor("Artifact catalog thread owner");
    const first = await uploadFile({
      owner,
      prompt: "upload into the first thread",
      filename: "first-thread.txt",
      contentType: "text/plain",
    });
    await uploadFile({
      owner,
      prompt: "upload into the second thread",
      filename: "second-thread.txt",
      contentType: "text/plain",
    });

    const filtered = await chat.listArtifactCatalog(owner.actor, {
      chatThreadId: first.threadId,
    });

    expect(filtered.nextCursor).toBeNull();
    expect(filtered.artifacts).toStrictEqual([
      expect.objectContaining({ kind: "file", title: "first-thread.txt" }),
    ]);
  }, 180_000);
});
