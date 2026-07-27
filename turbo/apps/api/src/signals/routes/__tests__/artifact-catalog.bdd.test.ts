import { createHash, randomUUID } from "node:crypto";

import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { testContext } from "../../../__tests__/test-helpers";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import {
  createChatFilesBddApi,
  hostedTextFile,
} from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { insertLegacyArtifactCatalogFile } from "./helpers/runtime-state";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
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
  body: { readonly agentId: string; readonly prompt: string },
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const sent = await chat.requestSendMessage(actor, body, [201]);
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
}): Promise<{ readonly fileId: string; readonly url: string }> {
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
  return { fileId, url: completed.body.url };
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
}): Promise<{ readonly url: string; readonly siteId: string }> {
  const run = await sendChatRun(args.owner.actor, {
    agentId: args.owner.agentId,
    prompt: `publish ${args.site}`,
  });
  const { claim, sandboxHeaders } = await claimChatRun(
    args.owner.runnerGroup,
    run.runId,
  );
  const bearer = `Bearer ${zeroTokenFromClaim(claim)}`;
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
  await completeChatRunOk(run.runId, sandboxHeaders);
  return { url: prepared.url, siteId: prepared.siteId };
}

async function publishHostedSiteFromDirectRun(args: {
  readonly owner: CatalogActor;
  readonly site: string;
  readonly artifactKind?: "hosted-site" | "presentation-html";
  readonly runId?: string;
}): Promise<{
  readonly url: string;
  readonly siteId: string;
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
  return { url: prepared.url, siteId: prepared.siteId, runId };
}

function scopedZeroToken(
  owner: CatalogActor,
  runId: string,
  capabilities: readonly ("file:write" | "host:write")[],
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

  it("refuses the catalog when the feature switch is off", async () => {
    const owner = await catalogActor(
      "Artifact catalog disabled owner",
      bdd.user(),
      { [FeatureSwitchKey.Artifacts]: false },
    );

    const denied = await chat.requestListArtifactCatalog(owner.actor, [403]);

    if (denied.status !== 403) {
      throw new Error("Expected the disabled catalog to be forbidden");
    }
    expect(denied.body.error.code).toBe("FORBIDDEN");
  }, 180_000);
});
