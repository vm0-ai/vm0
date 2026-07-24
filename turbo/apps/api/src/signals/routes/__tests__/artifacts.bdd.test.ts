import { createHash, randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { testContext } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import {
  createChatFilesBddApi,
  hostedTextFile,
} from "./helpers/api-bdd-chat-files";
import { createHostMapsBddApi } from "./helpers/api-bdd-host-maps";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { readRunUploadedFileSources } from "./helpers/runtime-state";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const host = createHostMapsBddApi(context);
const webhooks = createWebhookCallbackApi(context);
const CLOUDFLARE_SNAPSHOT_URL =
  "https://api.cloudflare.com/client/v4/accounts/test-account/browser-rendering/snapshot";
const CLOUDFLARE_MEDIA_FRAME_URL =
  /^https:\/\/cdn\.vm7\.io\/cdn-cgi\/media\/mode=frame,time=1s,width=640,format=jpg\//;
const ARTIFACT_PREVIEW_WAF_SECRET = "test-artifact-preview-waf-secret-value";
type RunnerClaim = Awaited<ReturnType<typeof api.claimRunnerJob>>;
type ChatObjectStorage = ReturnType<
  typeof chatCallbacks.acceptChatObjectStorage
>;

interface ArtifactActor {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly objectStore: ChatObjectStorage;
}

interface SnapshotRequest {
  readonly authorization: string | null;
  readonly url: string;
  readonly body: unknown;
}

interface SnapshotFixture {
  readonly content?: string;
  readonly screenshot?: string;
  readonly status?: number;
  readonly title?: string;
}

interface MediaFrameRequest {
  readonly url: string;
}

function mockCloudflareSnapshot(
  fixture: SnapshotFixture = {},
): SnapshotRequest[] {
  const requests: SnapshotRequest[] = [];
  server.use(
    http.post(CLOUDFLARE_SNAPSHOT_URL, async ({ request }) => {
      requests.push({
        authorization: request.headers.get("authorization"),
        url: request.url,
        body: await request.json(),
      });
      return HttpResponse.json({
        meta: {
          status: fixture.status ?? 200,
          title: fixture.title ?? "Artifact",
        },
        success: true,
        errors: [],
        result: {
          content:
            fixture.content ??
            "<!doctype html><html><body>artifact</body></html>",
          screenshot: fixture.screenshot ?? "UklGRg==",
        },
      });
    }),
  );
  return requests;
}

function mockCloudflareVideoFrame(
  userId: string,
  status = 200,
): MediaFrameRequest[] {
  const requests: MediaFrameRequest[] = [];
  server.use(
    http.get(CLOUDFLARE_MEDIA_FRAME_URL, ({ request }) => {
      if (!request.url.includes(`/artifacts/${userId}/`)) {
        return new HttpResponse("foreign test artifact", { status: 415 });
      }
      requests.push({ url: request.url });
      if (status !== 200) {
        return new HttpResponse("unsupported video", { status });
      }
      return new HttpResponse(new Uint8Array([0xff, 0xd8, 0xff]), {
        headers: { "Content-Type": "image/jpeg" },
      });
    }),
  );
  return requests;
}

async function artifactActor(
  displayName: string,
  actor: ApiTestUser = bdd.user(),
): Promise<ArtifactActor> {
  const objectStore = chatCallbacks.acceptChatObjectStorage();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  chatCallbacks.disableVapid();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName,
    visibility: "private",
  });
  return { actor, agentId: agent.agentId, runnerGroup, objectStore };
}

async function setVideoArtifactPosters(
  actor: ApiTestUser,
  enabled: boolean,
): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected video preview test actor to have an org");
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId: actor.orgId },
    { [FeatureSwitchKey.VideoArtifactPosters]: enabled },
  );
}

async function sendChatRun(
  actor: ApiTestUser,
  body: {
    readonly agentId: string;
    readonly prompt: string;
    readonly threadId?: string;
  },
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

function fileWriteToken(owner: ArtifactActor, runId: string): string {
  if (!owner.actor.orgId) {
    throw new Error("Expected artifact test actor to have an org");
  }
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "zero",
    userId: owner.actor.userId,
    orgId: owner.actor.orgId,
    runId,
    capabilities: ["file:write"],
    iat: seconds,
    exp: seconds + 60,
  });
}

async function completeChatRunOk(
  runId: string,
  sandboxHeaders: { readonly authorization: string },
): Promise<void> {
  const historyHash = createHash("sha256")
    .update(`bdd artifacts history ${runId}`)
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

async function createHostedArtifact(args: {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly site: string;
  readonly artifactKind?: "hosted-site" | "presentation-html";
}): Promise<{
  readonly runId: string;
  readonly threadId: string;
  readonly fileId: string;
  readonly url: string;
  readonly deploymentId: string;
}> {
  const run = await sendChatRun(args.actor, {
    agentId: args.agentId,
    prompt: `create ${args.site}`,
  });
  const { claim, sandboxHeaders } = await claimChatRun(
    args.runnerGroup,
    run.runId,
  );
  const bearer = `Bearer ${zeroTokenFromClaim(claim)}`;
  const prepared = await chat.prepareHostedSiteWithBearer(bearer, {
    site: args.site,
    artifactKind: args.artifactKind ?? "hosted-site",
    spaFallback: false,
    files: [hostedTextFile("/index.html", `<main>${args.site}</main>`)],
  });
  await chat.completeHostedSiteWithBearer(bearer, prepared.deploymentId);
  await completeChatRunOk(run.runId, sandboxHeaders);
  return {
    runId: run.runId,
    threadId: run.threadId,
    fileId: prepared.url,
    url: prepared.url,
    deploymentId: prepared.deploymentId,
  };
}

async function createRunUploadedFile(args: {
  readonly owner: ArtifactActor;
  readonly prompt: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes?: number;
}): Promise<{
  readonly runId: string;
  readonly threadId: string;
  readonly fileId: string;
  readonly url: string;
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
  const fileId = randomUUID();
  args.owner.objectStore.addObject({
    bucket: "test-user-artifacts",
    key: `artifacts/${args.owner.actor.userId}/${fileId}/${args.filename}`,
    size: args.sizeBytes ?? 1024,
  });
  const completed = await chat.completeUploadWithBearer(
    bearer,
    { id: fileId, contentType: args.contentType },
    [200],
  );
  if (completed.status !== 200) {
    throw new Error("Expected run upload completion to succeed");
  }
  await completeChatRunOk(run.runId, sandboxHeaders);
  return {
    runId: run.runId,
    threadId: run.threadId,
    fileId,
    url: completed.body.url,
  };
}

describe("video Artifact previews", () => {
  it("leaves video preview empty when immediate posters are disabled", async () => {
    const owner = await artifactActor(
      "Artifacts API disabled video preview agent",
    );
    await setVideoArtifactPosters(owner.actor, false);
    const frameRequests = mockCloudflareVideoFrame(owner.actor.userId);

    const videoArtifact = await createRunUploadedFile({
      owner,
      prompt: "upload video without poster generation",
      filename: "poster-disabled.mp4",
      contentType: "video/mp4",
    });
    await flushWaitUntilForTest();

    expect(frameRequests).toHaveLength(0);
    expect(
      owner.objectStore.puts.some((put) => {
        return put.key.endsWith("/poster.jpg");
      }),
    ).toBeFalsy();
    const response = await chat.listArtifacts(owner.actor);
    const artifact = response.artifacts.find((item) => {
      return item.fileId === videoArtifact.fileId;
    });
    expect(artifact).toBeDefined();
    expect(artifact).not.toHaveProperty("previewImageUrl");
  }, 180_000);

  it("generates a poster immediately for an ordinary video upload", async () => {
    const owner = await artifactActor("Artifacts API video preview agent");
    await setVideoArtifactPosters(owner.actor, true);
    const frameRequests = mockCloudflareVideoFrame(owner.actor.userId);

    const videoArtifact = await createRunUploadedFile({
      owner,
      prompt: "upload reference footage",
      filename: "reference-footage.mp4",
      contentType: "video/mp4",
    });
    await flushWaitUntilForTest();

    expect(frameRequests).toHaveLength(1);
    expect(frameRequests[0]?.url).toBe(
      `https://cdn.vm7.io/cdn-cgi/media/mode=frame,time=1s,width=640,format=jpg/${videoArtifact.url}`,
    );
    const posterPuts = owner.objectStore.puts.filter((put) => {
      return put.key.endsWith("/poster.jpg");
    });
    expect(posterPuts).toHaveLength(1);
    expect(posterPuts[0]).toMatchObject({
      bucket: "test-user-artifacts",
      contentType: "image/jpeg",
    });

    const response = await chat.listArtifacts(owner.actor);
    const previewedArtifact = response.artifacts.find((item) => {
      return item.fileId === videoArtifact.fileId;
    });
    expect(previewedArtifact?.previewImageUrl).toMatch(/\/poster\.jpg$/);
  }, 180_000);

  it("leaves video preview empty when media frame extraction fails", async () => {
    const owner = await artifactActor("Artifacts API video preview fail agent");
    await setVideoArtifactPosters(owner.actor, true);
    const frameRequests = mockCloudflareVideoFrame(owner.actor.userId, 415);

    const videoArtifact = await createRunUploadedFile({
      owner,
      prompt: "create unsupported video artifact",
      filename: "unsupported-video.webm",
      contentType: "video/webm",
    });
    await flushWaitUntilForTest();

    expect(frameRequests).toHaveLength(1);
    expect(
      owner.objectStore.puts.some((put) => {
        return put.key.endsWith("/poster.jpg");
      }),
    ).toBeFalsy();

    const response = await chat.listArtifacts(owner.actor);
    const failedArtifact = response.artifacts.find((item) => {
      return item.fileId === videoArtifact.fileId;
    });
    expect(failedArtifact).toBeDefined();
    expect(failedArtifact).not.toHaveProperty("previewImageUrl");
  }, 180_000);
});

describe("GET /api/zero/artifacts", () => {
  it.each(["workflow-schedule", "workflow-event"] as const)(
    "attributes run uploads to the %s source",
    async (triggerSource) => {
      const owner = await artifactActor(
        `Artifacts API ${triggerSource} source agent`,
      );
      const run = await api.createDirectRun(owner.actor, {
        agentComposeId: owner.agentId,
        prompt: `create ${triggerSource} artifact`,
        modelProviderType: "anthropic-api-key",
        triggerSource,
        vars: { ZERO_AGENT_ID: owner.agentId },
        secrets: { ZERO_TOKEN: "bdd-artifact-zero-token" },
      });
      const fileId = randomUUID();
      owner.objectStore.addObject({
        bucket: "test-user-artifacts",
        key: `artifacts/${owner.actor.userId}/${fileId}/workflow-output.txt`,
        size: 128,
      });

      await chat.completeUploadWithBearer(
        `Bearer ${fileWriteToken(owner, run.runId)}`,
        { id: fileId, contentType: "text/plain" },
        [200],
      );

      await expect(
        readRunUploadedFileSources(context, run.runId),
      ).resolves.toStrictEqual([triggerSource]);
    },
  );

  it("lists chat-thread artifacts for the active organization and hides uploads shadowed by hosted artifacts", async () => {
    const userId = `user_${randomUUID()}`;
    const actor = bdd.user({ userId, orgId: `org_${randomUUID()}` });
    const otherOrgActor = bdd.user({
      userId,
      orgId: `org_${randomUUID()}`,
    });
    const current = await artifactActor("Artifacts API org agent", actor);
    const standaloneUpload = await createRunUploadedFile({
      owner: current,
      prompt: "upload standalone artifact",
      filename: "standalone-notes.txt",
      contentType: "text/plain",
      sizeBytes: 256,
    });
    const otherOrg = await artifactActor(
      "Artifacts API other org agent",
      otherOrgActor,
    );
    const objectStore = chatCallbacks.acceptChatObjectStorage();

    const run = await sendChatRun(actor, {
      agentId: current.agentId,
      prompt: "create artifact with ordinary upload",
    });
    const { claim } = await claimChatRun(current.runnerGroup, run.runId);
    const bearer = `Bearer ${zeroTokenFromClaim(claim)}`;
    const ordinaryUploadId = randomUUID();
    objectStore.addObject({
      bucket: "test-user-artifacts",
      key: `artifacts/${actor.userId}/${ordinaryUploadId}/notes.txt`,
      size: 128,
    });
    await chat.completeUploadWithBearer(
      bearer,
      { id: ordinaryUploadId, contentType: "text/plain" },
      [200],
    );
    const hostedFile = hostedTextFile("/index.html", "<main>active org</main>");
    const prepared = await chat.prepareHostedSiteWithBearer(bearer, {
      site: `active-org-${randomUUID().slice(0, 8)}`,
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [hostedFile],
    });
    await chat.completeHostedSiteWithBearer(bearer, prepared.deploymentId);

    const otherOrgArtifact = await createHostedArtifact({
      actor: otherOrg.actor,
      agentId: otherOrg.agentId,
      runnerGroup: otherOrg.runnerGroup,
      site: `other-org-${randomUUID().slice(0, 8)}`,
    });

    const response = await chat.listArtifacts(actor);
    expect(response.artifacts).toHaveLength(2);
    expect(response.artifacts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: run.threadId,
          runId: run.runId,
          fileId: prepared.url,
          url: prepared.url,
          size: hostedFile.size,
          updatedAt: expect.any(String),
          artifactKind: "hosted-site",
        }),
        expect.objectContaining({
          threadId: standaloneUpload.threadId,
          runId: standaloneUpload.runId,
          fileId: standaloneUpload.fileId,
          url: standaloneUpload.url,
          size: 256,
          contentType: "text/plain",
          updatedAt: expect.any(String),
        }),
      ]),
    );
    const hostedArtifact = response.artifacts.find((artifact) => {
      return artifact.fileId === prepared.url;
    });
    expect(hostedArtifact).not.toHaveProperty("previewImageUrl");
    expect(
      response.artifacts.some((artifact) => {
        return artifact.fileId === ordinaryUploadId;
      }),
    ).toBeFalsy();
    expect(
      response.artifacts.some((artifact) => {
        return artifact.fileId === otherOrgArtifact.fileId;
      }),
    ).toBeFalsy();
    expect(response.truncated).toBeFalsy();
  }, 120_000);

  it("keeps every hosted-site version as a separate immutable artifact", async () => {
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected hosted artifact actor to have an org");
    }
    await updateFeatureSwitchesForUser(
      context,
      { userId: actor.userId, orgId: actor.orgId },
      { [FeatureSwitchKey.HostedArtifactVersions]: true },
    );
    const owner = await artifactActor(
      "Artifacts API hosted versions agent",
      actor,
    );
    const run = await sendChatRun(actor, {
      agentId: owner.agentId,
      prompt: "publish two hosted-site versions",
    });
    const { claim } = await claimChatRun(owner.runnerGroup, run.runId);
    const bearer = `Bearer ${zeroTokenFromClaim(claim)}`;
    host.captureHostedSitesS3();

    const site = `artifact-versions-${randomUUID().slice(0, 8)}`;
    const body = {
      site,
      artifactKind: "hosted-site" as const,
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>versioned artifact</main>")],
    };
    const first = await chat.prepareHostedSiteWithBearer(bearer, body);
    await chat.completeHostedSiteWithBearer(bearer, first.deploymentId);
    const second = await chat.prepareHostedSiteWithBearer(bearer, body);
    await chat.completeHostedSiteWithBearer(bearer, second.deploymentId);

    expect(first).toMatchObject({
      publicSlug: site,
      deploymentVersion: 1,
      aliasUrl: first.url,
    });
    expect(second).toMatchObject({
      siteId: first.siteId,
      publicSlug: site,
      deploymentVersion: 2,
      aliasUrl: first.url,
    });
    expect(second.artifactUrl).not.toBe(first.artifactUrl);

    const response = await chat.listArtifacts(actor);
    const versionArtifacts = response.artifacts.filter((artifact) => {
      return artifact.runId === run.runId;
    });
    expect(versionArtifacts).toHaveLength(2);
    expect(versionArtifacts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fileId: first.deploymentId,
          filename: `${site}-v1.html`,
          url: first.artifactUrl,
          artifactKind: "hosted-site",
        }),
        expect.objectContaining({
          fileId: second.deploymentId,
          filename: `${site}-v2.html`,
          url: second.artifactUrl,
          artifactKind: "hosted-site",
        }),
      ]),
    );
  }, 120_000);

  it("generates deploy-time preview images and refreshes them after redeploy", async () => {
    const owner = await artifactActor("Artifacts API preview image agent");
    if (!owner.actor.orgId) {
      throw new Error("Expected preview image test actor to have an org");
    }
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
    mockEnv("ARTIFACT_PREVIEW_WAF_SECRET", ARTIFACT_PREVIEW_WAF_SECRET);
    const snapshotRequests = mockCloudflareSnapshot();

    const artifact = await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      site: `preview-artifact-${randomUUID().slice(0, 8)}`,
    });
    await flushWaitUntilForTest();

    const firstResponse = await chat.listArtifacts(owner.actor);
    const firstArtifact = firstResponse.artifacts.find((item) => {
      return item.fileId === artifact.fileId;
    });
    expect(firstArtifact?.previewImageUrl).toContain(
      `/preview-v2-${artifact.deploymentId}.webp`,
    );
    expect(snapshotRequests).toHaveLength(1);
    expect(snapshotRequests[0]).toMatchObject({
      authorization: "Bearer preview-token",
      url: `${CLOUDFLARE_SNAPSHOT_URL}?cacheTTL=0`,
      body: {
        url: artifact.url,
        cookies: [
          {
            name: "vm0_artifact_preview",
            value: ARTIFACT_PREVIEW_WAF_SECRET,
            url: new URL(artifact.url).origin,
            httpOnly: true,
            secure: true,
            sameSite: "Strict",
          },
        ],
        formats: ["content", "screenshot"],
        viewport: {
          width: 1280,
          height: 800,
          deviceScaleFactor: 0.5,
        },
        screenshotOptions: { type: "webp", quality: 80 },
      },
    });
    expect(
      owner.objectStore.puts.some((put) => {
        return (
          put.bucket === "test-user-artifacts" &&
          put.key.endsWith(`/preview-v2-${artifact.deploymentId}.webp`) &&
          put.contentType === "image/webp"
        );
      }),
    ).toBeTruthy();
    if (!firstResponse.syncUntil) {
      throw new Error("Expected artifact sync timestamp");
    }

    host.captureHostedSitesS3();
    const redeployed = await host.redeployHtml(owner.actor, {
      url: artifact.url,
      html: "<!doctype html><html><body>redeployed preview</body></html>",
    });
    await flushWaitUntilForTest();

    const refreshedResponse = await chat.listArtifacts(owner.actor, {
      updatedAfter: firstResponse.syncUntil,
    });
    const refreshedArtifact = refreshedResponse.artifacts.find((item) => {
      return item.fileId === artifact.fileId;
    });
    expect(refreshedArtifact?.previewImageUrl).toContain(
      `/preview-v2-${redeployed.deploymentId}.webp`,
    );
    expect(refreshedArtifact?.previewImageUrl).not.toBe(
      firstArtifact?.previewImageUrl,
    );
    expect(snapshotRequests).toHaveLength(2);
    expect(snapshotRequests[1]?.body).toMatchObject({ url: artifact.url });
  }, 120_000);

  it("rejects page errors and Cloudflare challenges instead of saving them as previews", async () => {
    const owner = await artifactActor("Artifacts API challenge preview agent");
    if (!owner.actor.orgId) {
      throw new Error("Expected challenge preview test actor to have an org");
    }
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
    mockEnv("ARTIFACT_PREVIEW_WAF_SECRET", ARTIFACT_PREVIEW_WAF_SECRET);
    const pageErrorRequests = mockCloudflareSnapshot({
      status: 403,
      title: "Forbidden",
      content: "<!doctype html><html><body>forbidden</body></html>",
    });

    const pageErrorArtifact = await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      site: `error-preview-${randomUUID().slice(0, 8)}`,
    });
    await flushWaitUntilForTest();

    const challengeRequests = mockCloudflareSnapshot({
      title: "Just a moment...",
      content:
        "<!doctype html><html><body><h1>Performing security verification</h1><p>Incompatible browser extension or network configuration</p><script>window.__cf_chl_opt={}</script></body></html>",
    });

    const challengeArtifact = await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      site: `challenge-preview-${randomUUID().slice(0, 8)}`,
    });
    await flushWaitUntilForTest();

    const response = await chat.listArtifacts(owner.actor);
    for (const artifact of [pageErrorArtifact, challengeArtifact]) {
      const rejectedArtifact = response.artifacts.find((item) => {
        return item.fileId === artifact.fileId;
      });
      expect(rejectedArtifact).toBeDefined();
      expect(rejectedArtifact).not.toHaveProperty("previewImageUrl");
      expect(
        owner.objectStore.puts.some((put) => {
          return put.key.endsWith(`/preview-v2-${artifact.deploymentId}.webp`);
        }),
      ).toBeFalsy();
    }
    expect(pageErrorRequests).toHaveLength(1);
    expect(challengeRequests).toHaveLength(1);
  }, 180_000);

  it("returns every artifact for the org in one bulk response", async () => {
    const first = await artifactActor("Artifacts API bulk agent");
    const secondAgent = await bdd.createAgent(first.actor, {
      displayName: "Artifacts API bulk second agent",
      visibility: "private",
    });

    const firstArtifact = await createHostedArtifact({
      actor: first.actor,
      agentId: first.agentId,
      runnerGroup: first.runnerGroup,
      site: `alpha-artifact-${randomUUID().slice(0, 8)}`,
    });
    const secondArtifact = await createHostedArtifact({
      actor: first.actor,
      agentId: secondAgent.agentId,
      runnerGroup: first.runnerGroup,
      site: `deck-artifact-${randomUUID().slice(0, 8)}`,
      artifactKind: "presentation-html",
    });
    const thirdArtifact = await createHostedArtifact({
      actor: first.actor,
      agentId: first.agentId,
      runnerGroup: first.runnerGroup,
      site: `beta-artifact-${randomUUID().slice(0, 8)}`,
    });

    const response = await chat.listArtifacts(first.actor);
    expect(response.truncated).toBeFalsy();
    expect(
      new Set(
        response.artifacts.map((artifact) => {
          return artifact.fileId;
        }),
      ),
    ).toStrictEqual(
      new Set([
        firstArtifact.fileId,
        secondArtifact.fileId,
        thirdArtifact.fileId,
      ]),
    );
  }, 120_000);

  it("walks the full set via keyset pagination with a small page size", async () => {
    const owner = await artifactActor("Artifacts API paging agent");

    const created: string[] = [];
    for (const label of ["one", "two", "three"]) {
      const artifact = await createHostedArtifact({
        actor: owner.actor,
        agentId: owner.agentId,
        runnerGroup: owner.runnerGroup,
        site: `page-${label}-${randomUUID().slice(0, 8)}`,
      });
      created.push(artifact.fileId);
    }

    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await chat.listArtifacts(owner.actor, { limit: 1, cursor });
      expect(page.artifacts.length).toBeLessThanOrEqual(1);
      for (const artifact of page.artifacts) {
        collected.push(artifact.fileId);
      }
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(10);
    } while (cursor);

    // Every visible artifact row surfaced exactly once across pages with no
    // cursor drift, repeated rows, or skips.
    expect(collected).toHaveLength(created.length);
    expect(new Set(collected)).toStrictEqual(new Set(created));
  }, 120_000);

  it("paginates caller-scoped artifacts across the incremental replay window", async () => {
    const owner = await artifactActor("Artifacts API incremental agent");
    await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      site: `existing-${randomUUID().slice(0, 8)}`,
    });
    const baseline = await chat.listArtifacts(owner.actor);
    const syncUntil = baseline.syncUntil;
    if (!syncUntil) {
      throw new Error("Expected artifact sync timestamp");
    }

    const created = [];
    for (const label of ["first", "second"]) {
      created.push(
        await createHostedArtifact({
          actor: owner.actor,
          agentId: owner.agentId,
          runnerGroup: owner.runnerGroup,
          site: `incremental-${label}-${randomUUID().slice(0, 8)}`,
        }),
      );
    }
    const outsider = await artifactActor("Artifacts API incremental outsider");
    const outsideArtifact = await createHostedArtifact({
      actor: outsider.actor,
      agentId: outsider.agentId,
      runnerGroup: outsider.runnerGroup,
      site: `incremental-outside-${randomUUID().slice(0, 8)}`,
    });

    const collected: string[] = [];
    let cursor: string | undefined;
    let responseSyncUntil: string | undefined;
    do {
      const page = await chat.listArtifacts(owner.actor, {
        limit: 1,
        cursor,
        // Move the requested watermark one minute ahead. The replay overlap
        // must still recover rows that committed just behind that watermark.
        updatedAfter: new Date(Date.parse(syncUntil) + 60_000).toISOString(),
      });
      responseSyncUntil ??= page.syncUntil;
      expect(page.syncUntil).toBe(responseSyncUntil);
      collected.push(
        ...page.artifacts.map((artifact) => {
          return artifact.fileId;
        }),
      );
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(collected).toHaveLength(new Set(collected).size);
    for (const artifact of created) {
      expect(collected).toContain(artifact.fileId);
    }
    expect(collected).not.toContain(outsideArtifact.fileId);
  }, 120_000);

  it("returns updated thread metadata in incremental mode", async () => {
    const owner = await artifactActor("Artifacts API metadata sync agent");
    const artifact = await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      site: `metadata-${randomUUID().slice(0, 8)}`,
    });
    const baseline = await chat.listArtifacts(owner.actor);
    if (!baseline.syncUntil) {
      throw new Error("Expected artifact sync timestamp");
    }

    const title = `Renamed artifact thread ${randomUUID().slice(0, 8)}`;
    await chat.renameThread(owner.actor, artifact.threadId, title);

    const changed = await chat.listArtifacts(owner.actor, {
      // Combined with the five-minute overlap, this makes the effective lower
      // bound the baseline itself, excluding the older file timestamp.
      updatedAfter: new Date(
        Date.parse(baseline.syncUntil) + 5 * 60_000,
      ).toISOString(),
    });
    const changedArtifact = changed.artifacts.find((item) => {
      return item.fileId === artifact.fileId;
    });
    if (!changedArtifact) {
      throw new Error("Expected renamed artifact to be incrementally listed");
    }
    expect(changedArtifact.threadTitle).toBe(title);
  }, 120_000);
});

describe("POST /api/zero/artifacts/favorite", () => {
  it("stores favorite state without changing artifact synchronization", async () => {
    const owner = await artifactActor("Artifacts API favorites agent");
    const artifact = await createRunUploadedFile({
      owner,
      prompt: "create a favorite artifact",
      filename: `favorite-${randomUUID().slice(0, 8)}.txt`,
      contentType: "text/plain",
    });
    const baseline = await chat.listArtifacts(owner.actor);
    if (!baseline.syncUntil) {
      throw new Error("Expected artifact sync timestamp");
    }

    await expect(
      chat.listArtifactFavorites(owner.actor),
    ).resolves.toStrictEqual({ artifactUrls: [] });

    await chat.favoriteArtifact(owner.actor, artifact.url);

    await expect(
      chat.listArtifactFavorites(owner.actor),
    ).resolves.toStrictEqual({ artifactUrls: [artifact.url] });

    const favorited = await chat.listArtifacts(owner.actor, {
      updatedAfter: new Date(
        Date.parse(baseline.syncUntil) + 5 * 60_000,
      ).toISOString(),
    });
    expect(favorited.artifacts).not.toContainEqual(
      expect.objectContaining({ fileId: artifact.fileId }),
    );

    await chat.unfavoriteArtifact(owner.actor, artifact.url);

    await expect(
      chat.listArtifactFavorites(owner.actor),
    ).resolves.toStrictEqual({ artifactUrls: [] });

    const unfavorited = await chat.listArtifacts(owner.actor, {
      updatedAfter: new Date(
        Date.parse(baseline.syncUntil) + 5 * 60_000,
      ).toISOString(),
    });
    expect(unfavorited.artifacts).not.toContainEqual(
      expect.objectContaining({ fileId: artifact.fileId }),
    );
  }, 120_000);

  it("rejects favorite requests for artifacts outside the caller visibility set", async () => {
    const userId = `user_${randomUUID()}`;
    const owner = await artifactActor(
      "Artifacts API favorites visibility",
      bdd.user({ userId, orgId: `org_${randomUUID()}` }),
    );
    const otherOrg = await artifactActor(
      "Artifacts API other-org favorite",
      bdd.user({ userId, orgId: `org_${randomUUID()}` }),
    );
    const otherOrgArtifact = await createRunUploadedFile({
      owner: otherOrg,
      prompt: "create an artifact outside the favorite visibility scope",
      filename: `other-org-${randomUUID().slice(0, 8)}.txt`,
      contentType: "text/plain",
    });

    const missing = await chat.requestFavoriteArtifact(
      owner.actor,
      `https://artifacts.example.com/${randomUUID()}.html`,
      [404],
    );

    if (missing.status !== 404) {
      throw new Error("Expected missing artifact favorite request to 404");
    }
    expect(missing.body.error.code).toBe("NOT_FOUND");

    const otherOrganization = await chat.requestFavoriteArtifact(
      owner.actor,
      otherOrgArtifact.url,
      [404],
    );
    if (otherOrganization.status !== 404) {
      throw new Error("Expected other-organization favorite request to 404");
    }
    expect(otherOrganization.body.error.code).toBe("NOT_FOUND");
  }, 120_000);
});
