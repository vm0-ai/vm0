import { createHash, randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import type { ArtifactSummary } from "@okouai/api-contracts/contracts/artifact-catalog";
import { cronBackfillArtifactPreviewsContract } from "@okouai/api-contracts/contracts/cron";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { describe, expect, it } from "vitest";

import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createHostMapsBddApi } from "./helpers/api-bdd-host-maps";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { readRunUploadedFileSources } from "./helpers/runtime-state";
import { cronBackfillArtifactPreviewsRoutes } from "../cron-backfill-artifact-previews";

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
const CRON_SECRET = "test-artifact-preview-cron-secret";
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
  readonly error?: {
    readonly code: number;
    readonly detail: string;
    readonly message: string;
    readonly status: number;
  };
  readonly screenshot?: string;
  readonly status?: number;
  readonly title?: string;
}

interface MediaFrameRequest {
  readonly url: string;
}

function mockCloudflareSnapshot(
  fixtures: readonly SnapshotFixture[] = [{}],
): SnapshotRequest[] {
  const requests: SnapshotRequest[] = [];
  server.use(
    http.post(CLOUDFLARE_SNAPSHOT_URL, async ({ request }) => {
      requests.push({
        authorization: request.headers.get("authorization"),
        url: request.url,
        body: await request.json(),
      });
      const fixture = fixtures[requests.length - 1];
      if (!fixture) {
        throw new Error("Missing Cloudflare snapshot fixture");
      }
      if (fixture.error) {
        return HttpResponse.json(
          {
            success: false,
            errors: [
              {
                code: fixture.error.code,
                message: fixture.error.message,
                detail: fixture.error.detail,
              },
            ],
            messages: [],
            result: null,
          },
          { status: fixture.error.status },
        );
      }
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

function videoSnapshotFixture(
  state: "ready" | "no-video-track" | "media-error-3" = "ready",
): SnapshotFixture {
  return {
    content: `<!doctype html><html><body><video id="preview" class="frame-settled" data-preview-state="${state}"></video></body></html>`,
    screenshot: "/9j/",
  };
}

function artifactPreviewCronClient() {
  return setupApp({
    context,
    routes: cronBackfillArtifactPreviewsRoutes,
  })(cronBackfillArtifactPreviewsContract);
}

function mockCloudflareVideoFrame(
  userId: string,
  status = 200,
  failureBody = "unsupported video",
): MediaFrameRequest[] {
  const requests: MediaFrameRequest[] = [];
  server.use(
    http.get(CLOUDFLARE_MEDIA_FRAME_URL, ({ request }) => {
      if (!request.url.includes(`/artifacts/${userId}/`)) {
        return new HttpResponse("foreign test artifact", { status: 415 });
      }
      requests.push({ url: request.url });
      if (status !== 200) {
        return new HttpResponse(failureBody, { status });
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

async function sendChatRun(
  actor: ApiTestUser,
  body: {
    readonly agentId: string;
    readonly prompt: string;
    readonly threadId?: string;
  },
  publicBrand: PublicBrand = "vm0",
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const sent = await chat.requestSendEvent(actor, body, [201], { publicBrand });
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

function okouTokenFromClaim(claim: RunnerClaim): string {
  const token = claim.platformEnvironment.OKOU_TOKEN;
  if (!token || !token.startsWith("vm0_sandbox_")) {
    throw new Error(
      "Expected the claim platform environment to carry an OKOU_TOKEN",
    );
  }
  return token;
}

function fileWriteToken(owner: ArtifactActor, runId: string): string {
  if (!owner.actor.orgId) {
    throw new Error("Expected artifact test actor to have an org");
  }
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "okou",
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
  await webhooks.requestAgentComplete(
    {
      runId,
      exitCode: 0,
      checkpoint: {
        cliAgentType: "claude-code",
        cliAgentSessionId: `bdd-cli-${runId}`,
        cliAgentSessionHistoryHash: historyHash,
      },
    },
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
  readonly publicBrand?: PublicBrand;
}): Promise<{
  readonly threadId: string;
  readonly url: string;
  readonly aliasUrl: string;
  readonly deploymentId: string;
  readonly bearer: string;
}> {
  const run = await sendChatRun(
    args.actor,
    {
      agentId: args.agentId,
      prompt: `create ${args.site}`,
    },
    args.publicBrand,
  );
  const { claim, sandboxHeaders } = await claimChatRun(
    args.runnerGroup,
    run.runId,
  );
  const bearer = `Bearer ${okouTokenFromClaim(claim)}`;
  const prepared = await chat.prepareHostedSiteWithBearer(bearer, {
    site: args.site,
    artifactKind: args.artifactKind ?? "hosted-site",
    spaFallback: false,
    files: [hostedTextFile("/index.html", `<main>${args.site}</main>`)],
  });
  if (!prepared.artifactUrl) {
    throw new Error("Expected a versioned hosted artifact URL");
  }
  await chat.completeHostedSiteWithBearer(bearer, prepared.deploymentId);
  await completeChatRunOk(run.runId, sandboxHeaders);
  return {
    threadId: run.threadId,
    url: prepared.artifactUrl,
    aliasUrl: prepared.url,
    deploymentId: prepared.deploymentId,
    bearer,
  };
}

async function createRunUploadedFile(args: {
  readonly owner: ArtifactActor;
  readonly prompt: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes?: number;
}): Promise<{
  readonly url: string;
  readonly fileId: string;
  readonly bearer: string;
}> {
  const run = await sendChatRun(args.owner.actor, {
    agentId: args.owner.agentId,
    prompt: args.prompt,
  });
  const bearer = `Bearer ${fileWriteToken(args.owner, run.runId)}`;
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
  return { url: completed.body.url, fileId, bearer };
}

async function previewStateForArtifact(actor: ApiTestUser, title: string) {
  const artifact = await findCatalogArtifact(actor, title);
  if (!artifact) {
    throw new Error("Expected a catalog artifact");
  }
  const detail = await chat.getArtifactCatalogEntry(actor, artifact.id);
  if (!("file" in detail)) {
    throw new Error("Expected a file-backed catalog artifact");
  }
  return detail.file.preview;
}

async function findCatalogArtifact(
  actor: ApiTestUser,
  title: string,
): Promise<ArtifactSummary | undefined> {
  const catalog = await chat.listArtifactCatalog(actor);
  return catalog.artifacts.find((artifact) => {
    return artifact.title === title;
  });
}

describe("video Artifact previews", () => {
  it("generates a poster immediately for an ordinary video upload", async () => {
    const owner = await artifactActor("Artifacts API video preview agent");
    if (!owner.actor.orgId) {
      throw new Error("Expected video preview test actor to have an org");
    }
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
      return /^artifacts\/[0-9a-z]{10}\.jpg$/u.test(put.key);
    });
    expect(posterPuts).toHaveLength(1);
    expect(posterPuts[0]).toMatchObject({
      bucket: "test-user-artifacts",
      cacheControl: "public, max-age=31536000, immutable",
      contentType: "image/jpeg",
      ifNoneMatch: "*",
    });

    const previewedArtifact = await findCatalogArtifact(
      owner.actor,
      "reference-footage.mp4",
    );
    expect(previewedArtifact?.thumbnail?.url).toMatch(
      /\/artifacts\/[0-9a-z]{10}\.jpg$/u,
    );
    await expect(
      previewStateForArtifact(owner.actor, "reference-footage.mp4"),
    ).resolves.toMatchObject({ status: "ready", error: null, attemptCount: 1 });
  }, 180_000);

  it("uses the browser fallback for a WebM recording", async () => {
    const owner = await artifactActor("Artifacts API webm preview agent");
    if (!owner.actor.orgId) {
      throw new Error("Expected webm preview test actor to have an org");
    }
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
    const frameRequests = mockCloudflareVideoFrame(owner.actor.userId);
    const snapshotRequests = mockCloudflareSnapshot(videoSnapshotFixture());

    const videoArtifact = await createRunUploadedFile({
      owner,
      prompt: "upload a webm recording",
      filename: "session-recording.webm",
      contentType: "video/webm",
    });
    await flushWaitUntilForTest();

    expect(frameRequests).toHaveLength(0);
    expect(snapshotRequests).toHaveLength(1);
    expect(snapshotRequests[0]).toMatchObject({
      authorization: "Bearer preview-token",
      body: {
        html: expect.stringContaining('data-preview-state="pending"'),
        addScriptTag: [{ content: expect.stringContaining(videoArtifact.url) }],
        waitForSelector: {
          selector: ".frame-settled",
          visible: true,
          timeout: 15_000,
        },
        actionTimeout: 15_000,
        allowResourceTypes: ["media"],
        screenshotOptions: { type: "jpeg", quality: 80 },
      },
    });
    const previewedArtifact = await findCatalogArtifact(
      owner.actor,
      "session-recording.webm",
    );
    expect(previewedArtifact?.thumbnail?.url).toMatch(
      /\/artifacts\/[0-9a-z]{10}\.jpg$/u,
    );
    await expect(
      previewStateForArtifact(owner.actor, "session-recording.webm"),
    ).resolves.toMatchObject({
      status: "ready",
      error: null,
      attemptCount: 1,
    });
  }, 180_000);

  it("uses the browser fallback at Cloudflare's input-size boundary", async () => {
    const owner = await artifactActor(
      "Artifacts API large video preview agent",
    );
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
    const frameRequests = mockCloudflareVideoFrame(owner.actor.userId);
    const snapshotRequests = mockCloudflareSnapshot(videoSnapshotFixture());

    await createRunUploadedFile({
      owner,
      prompt: "upload a large video",
      filename: "large-video.mp4",
      contentType: "video/mp4",
      sizeBytes: 100_000_000,
    });
    await flushWaitUntilForTest();

    expect(frameRequests).toHaveLength(0);
    expect(snapshotRequests).toHaveLength(1);
    await expect(
      previewStateForArtifact(owner.actor, "large-video.mp4"),
    ).resolves.toMatchObject({
      status: "ready",
      error: null,
      attemptCount: 1,
    });
  }, 180_000);

  it("reuses an existing write-once poster after a concurrent upload", async () => {
    const owner = await artifactActor(
      "Artifacts API concurrent video preview agent",
    );
    mockCloudflareVideoFrame(owner.actor.userId);
    owner.objectStore.rejectNextImmutablePutAsExisting();

    await createRunUploadedFile({
      owner,
      prompt: "upload video with concurrent poster generation",
      filename: "concurrent-poster.mp4",
      contentType: "video/mp4",
    });
    await flushWaitUntilForTest();

    const previewedArtifact = await findCatalogArtifact(
      owner.actor,
      "concurrent-poster.mp4",
    );
    expect(previewedArtifact?.thumbnail?.url).toMatch(
      /\/artifacts\/[0-9a-z]{10}\.jpg$/u,
    );
  }, 180_000);

  it("falls back after 9412 and persists a browser-decoded frame", async () => {
    const owner = await artifactActor(
      "Artifacts API video preview fallback agent",
    );
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
    const frameRequests = mockCloudflareVideoFrame(
      owner.actor.userId,
      400,
      "MEDIA_TRANSFORMATION_ERROR 9412: Unable to determine media duration",
    );
    const snapshotRequests = mockCloudflareSnapshot(videoSnapshotFixture());

    await createRunUploadedFile({
      owner,
      prompt: "create durationless web-compatible video artifact",
      filename: "durationless-video.mp4",
      contentType: "video/mp4",
    });
    await flushWaitUntilForTest();

    expect(frameRequests).toHaveLength(1);
    expect(snapshotRequests).toHaveLength(1);
    await expect(
      previewStateForArtifact(owner.actor, "durationless-video.mp4"),
    ).resolves.toMatchObject({
      status: "ready",
      error: null,
      attemptCount: 1,
    });
  }, 180_000);

  it("rejects audio mislabeled as MP4 video after the 9412 fallback", async () => {
    const owner = await artifactActor("Artifacts API video preview fail agent");
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
    const frameRequests = mockCloudflareVideoFrame(
      owner.actor.userId,
      400,
      "MEDIA_TRANSFORMATION_ERROR 9412: Input is not a video file",
    );
    const snapshotRequests = mockCloudflareSnapshot(
      videoSnapshotFixture("no-video-track"),
    );

    const videoArtifact = await createRunUploadedFile({
      owner,
      prompt: "create unsupported video artifact",
      filename: "unsupported-video.mp4",
      contentType: "video/mp4",
    });
    await flushWaitUntilForTest();

    expect(frameRequests).toHaveLength(1);
    expect(snapshotRequests).toHaveLength(1);
    expect(
      owner.objectStore.puts.some((put) => {
        return put.key.endsWith("/poster-v2.jpg");
      }),
    ).toBeFalsy();

    const failedArtifact = await findCatalogArtifact(
      owner.actor,
      "unsupported-video.mp4",
    );
    expect(failedArtifact).toMatchObject({ kind: "file" });
    expect(failedArtifact?.thumbnail).toBeNull();
    await expect(
      previewStateForArtifact(owner.actor, "unsupported-video.mp4"),
    ).resolves.toMatchObject({
      status: "permanent_failure",
      error: { code: "browser_video_no_visual_track", retryable: false },
      attemptCount: 1,
    });

    await chat.completeUploadWithBearer(
      videoArtifact.bearer,
      { id: videoArtifact.fileId, contentType: "video/mp4" },
      [200],
    );
    await flushWaitUntilForTest();
    expect(frameRequests).toHaveLength(1);
    expect(snapshotRequests).toHaveLength(1);
  }, 180_000);

  it("retries 9523 outcomes but caps provider attempts", async () => {
    const owner = await artifactActor(
      "Artifacts API transient video preview agent",
    );
    const frameRequests = mockCloudflareVideoFrame(
      owner.actor.userId,
      503,
      "MEDIA_TRANSFORMATION_ERROR 9523: Internal service error",
    );
    const videoArtifact = await createRunUploadedFile({
      owner,
      prompt: "create temporarily unavailable video preview",
      filename: "transient-video.mp4",
      contentType: "video/mp4",
    });
    await flushWaitUntilForTest();

    for (let replay = 0; replay < 3; replay += 1) {
      await chat.completeUploadWithBearer(
        videoArtifact.bearer,
        { id: videoArtifact.fileId, contentType: "video/mp4" },
        [200],
      );
      await flushWaitUntilForTest();
    }

    expect(frameRequests).toHaveLength(3);
    await expect(
      previewStateForArtifact(owner.actor, "transient-video.mp4"),
    ).resolves.toMatchObject({
      status: "transient_failure",
      error: { code: "cloudflare_media_9523", retryable: true },
      attemptCount: 3,
    });
  }, 180_000);

  it("backfills a legacy null-state WebM once with the same row claim", async () => {
    const owner = await artifactActor(
      "Artifacts API legacy webm backfill agent",
    );
    mockOptionalEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", undefined);

    const videoArtifact = await createRunUploadedFile({
      owner,
      prompt: "upload legacy webm recording",
      filename: "legacy-recording.webm",
      contentType: "video/webm",
    });
    await flushWaitUntilForTest();
    await expect(
      previewStateForArtifact(owner.actor, "legacy-recording.webm"),
    ).resolves.toBeNull();

    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
    mockEnv("CRON_SECRET", CRON_SECRET);
    const snapshotRequests = mockCloudflareSnapshot(videoSnapshotFixture());
    let targetReady = false;
    for (let attempt = 0; attempt < 10 && !targetReady; attempt += 1) {
      const response = await accept(
        artifactPreviewCronClient().backfill({
          headers: { authorization: `Bearer ${CRON_SECRET}` },
        }),
        [200],
      );
      expect(response.body.success).toBeTruthy();
      expect(response.body.selected).toBeLessThanOrEqual(4);
      expect(response.body.claimed + response.body.skipped).toBe(
        response.body.selected,
      );
      targetReady =
        (await previewStateForArtifact(owner.actor, "legacy-recording.webm"))
          ?.status === "ready";
    }
    expect(targetReady).toBeTruthy();
    const targetSnapshotRequests = snapshotRequests.filter((request) => {
      return JSON.stringify(request.body).includes(videoArtifact.url);
    });
    expect(targetSnapshotRequests).toHaveLength(1);

    await accept(
      artifactPreviewCronClient().backfill({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [200],
    );
    expect(
      snapshotRequests.filter((request) => {
        return JSON.stringify(request.body).includes(videoArtifact.url);
      }),
    ).toHaveLength(1);
  }, 180_000);
});

describe("artifact upload provenance", () => {
  it.each([
    "automation-schedule",
    "automation-event",
    "automation-schedule",
    "automation-event",
    "goal",
  ] as const)(
    "attributes run uploads to the %s source",
    async (triggerSource) => {
      const owner = await artifactActor(
        `Artifacts API ${triggerSource} source agent`,
      );
      const run = await api.createDirectRun(owner.actor, {
        agentId: owner.agentId,
        prompt: `create ${triggerSource} artifact`,
        modelProviderType: "anthropic-api-key",
        triggerSource,
        vars: { OKOU_AGENT_ID: owner.agentId },
        secrets: { OKOU_TOKEN: "bdd-artifact-okou-token" },
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
});

describe("GET /api/zero/chat-threads/:threadId/artifacts", () => {
  it("keeps every hosted-site version as a separate immutable artifact", async () => {
    const actor = bdd.user();
    const owner = await artifactActor(
      "Artifacts API hosted versions agent",
      actor,
    );
    const run = await sendChatRun(actor, {
      agentId: owner.agentId,
      prompt: "publish two hosted-site versions",
    });
    const { claim } = await claimChatRun(owner.runnerGroup, run.runId);
    const bearer = `Bearer ${okouTokenFromClaim(claim)}`;
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

    const threadArtifacts = await chat.listThreadArtifacts(actor, run.threadId);
    expect(threadArtifacts.runs).toHaveLength(1);
    expect(threadArtifacts.runs[0]?.files).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: first.artifactUrl,
          aliasUrl: first.url,
        }),
        expect.objectContaining({
          url: second.artifactUrl,
          aliasUrl: first.url,
        }),
      ]),
    );
  }, 120_000);
});

describe("hosted Artifact previews", () => {
  it("renders Okou deployments from their branded hosted-site domain", async () => {
    const owner = await artifactActor("Artifacts API Okou preview image agent");
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
    mockEnv("ARTIFACT_PREVIEW_WAF_SECRET", ARTIFACT_PREVIEW_WAF_SECRET);
    mockEnv("OKOU_PUBLIC_HOST_DOMAIN", "okou.app");
    mockEnv("OKOU_HOST_SCHEME", "https");
    const snapshotRequests = mockCloudflareSnapshot();
    const site = `okou-preview-${randomUUID().slice(0, 8)}`;

    const artifact = await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      site,
      publicBrand: "okou",
    });
    await flushWaitUntilForTest();

    expect(artifact.aliasUrl).toBe(`https://${site}.okou.app`);
    expect(artifact.url).toBe(`https://dpl-${artifact.deploymentId}.okou.app`);
    expect(snapshotRequests).toHaveLength(1);
    expect(snapshotRequests[0]).toMatchObject({
      body: {
        url: artifact.url,
        cookies: [
          expect.objectContaining({
            url: new URL(artifact.url).origin,
          }),
        ],
      },
    });
    const previewedArtifact = await findCatalogArtifact(owner.actor, site);
    expect(previewedArtifact?.thumbnail?.url).toMatch(
      /^https:\/\/cdn\.okou\.io\/artifacts\/[0-9a-z]{10}\.webp$/u,
    );
    expect(owner.objectStore.puts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bucket: "test-user-artifacts",
          contentType: "image/webp",
          metadata: expect.objectContaining({ "public-brand": "okou" }),
        }),
      ]),
    );
  }, 120_000);

  it("generates deploy-time preview images once per deployment", async () => {
    const owner = await artifactActor("Artifacts API preview image agent");
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
    mockEnv("ARTIFACT_PREVIEW_WAF_SECRET", ARTIFACT_PREVIEW_WAF_SECRET);
    const snapshotRequests = mockCloudflareSnapshot();
    const site = `preview-artifact-${randomUUID().slice(0, 8)}`;

    const artifact = await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      site,
    });
    await flushWaitUntilForTest();

    const firstArtifact = await findCatalogArtifact(owner.actor, site);
    expect(firstArtifact?.thumbnail?.url).toMatch(
      /\/artifacts\/[0-9a-z]{10}\.webp$/u,
    );
    const threadArtifacts = await chat.listThreadArtifacts(
      owner.actor,
      artifact.threadId,
    );
    expect(threadArtifacts.runs[0]?.files).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: artifact.url,
          aliasUrl: artifact.aliasUrl,
          previewImageUrl: firstArtifact?.thumbnail?.url,
        }),
      ]),
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
        gotoOptions: { waitUntil: "networkidle2", timeout: 20_000 },
        actionTimeout: 30_000,
        screenshotOptions: { type: "webp", quality: 80 },
      },
    });
    expect(
      owner.objectStore.puts.find((put) => {
        return /^artifacts\/[0-9a-z]{10}\.webp$/u.test(put.key);
      }),
    ).toMatchObject({
      bucket: "test-user-artifacts",
      cacheControl: "public, max-age=31536000, immutable",
      contentType: "image/webp",
      ifNoneMatch: "*",
    });

    await chat.completeHostedSiteWithBearer(
      artifact.bearer,
      artifact.deploymentId,
    );
    await flushWaitUntilForTest();

    const retriedArtifact = await findCatalogArtifact(owner.actor, site);
    expect(retriedArtifact?.thumbnail?.url).toBe(firstArtifact?.thumbnail?.url);
    expect(snapshotRequests).toHaveLength(1);
  }, 120_000);

  it("retries navigation timeouts once with explicit DOM readiness", async () => {
    const owner = await artifactActor("Artifacts API navigation retry agent");
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
    mockEnv("ARTIFACT_PREVIEW_WAF_SECRET", ARTIFACT_PREVIEW_WAF_SECRET);
    const snapshotRequests = mockCloudflareSnapshot([
      {
        error: {
          code: 6002,
          message:
            "A timeout was reached. Check gotoOptions/waitForSelector/waitForTimeout/actionTimeout options.",
          detail: "Navigation timeout of 20000 ms exceeded",
          status: 422,
        },
      },
      {},
    ]);
    const site = `navigation-retry-${randomUUID().slice(0, 8)}`;

    await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      site,
    });
    await flushWaitUntilForTest();

    expect(snapshotRequests).toHaveLength(2);
    expect(snapshotRequests[0]?.body).toMatchObject({
      gotoOptions: { waitUntil: "networkidle2", timeout: 20_000 },
      actionTimeout: 30_000,
    });
    expect(snapshotRequests[1]?.body).toMatchObject({
      gotoOptions: { waitUntil: "domcontentloaded", timeout: 15_000 },
      waitForSelector: {
        selector: "body > *",
        visible: true,
        timeout: 10_000,
      },
      actionTimeout: 30_000,
    });
    const previewedArtifact = await findCatalogArtifact(owner.actor, site);
    expect(previewedArtifact?.thumbnail?.url).toMatch(
      /\/artifacts\/[0-9a-z]{10}\.webp$/u,
    );
  }, 120_000);

  it("does not retry non-navigation browser rendering timeouts", async () => {
    const owner = await artifactActor("Artifacts API screenshot timeout agent");
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
    mockEnv("ARTIFACT_PREVIEW_WAF_SECRET", ARTIFACT_PREVIEW_WAF_SECRET);
    const snapshotRequests = mockCloudflareSnapshot([
      {
        error: {
          code: 6002,
          message:
            "A timeout was reached. Check gotoOptions/waitForSelector/waitForTimeout/actionTimeout options.",
          detail: "Screenshot timed out after 30000 ms",
          status: 422,
        },
      },
    ]);
    const site = `screenshot-timeout-${randomUUID().slice(0, 8)}`;

    const artifact = await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      site,
    });
    await flushWaitUntilForTest();

    expect(snapshotRequests).toHaveLength(1);
    const unpreviewedArtifact = await findCatalogArtifact(owner.actor, site);
    expect(unpreviewedArtifact?.thumbnail).toBeNull();
    expect(
      owner.objectStore.puts.some((put) => {
        return put.key.endsWith(`/preview-v3-${artifact.deploymentId}.webp`);
      }),
    ).toBeFalsy();
  }, 120_000);

  it("rejects page errors and Cloudflare challenges instead of saving them as previews", async () => {
    const owner = await artifactActor("Artifacts API challenge preview agent");
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
    mockEnv("ARTIFACT_PREVIEW_WAF_SECRET", ARTIFACT_PREVIEW_WAF_SECRET);
    const pageErrorRequests = mockCloudflareSnapshot([
      {
        status: 403,
        title: "Forbidden",
        content: "<!doctype html><html><body>forbidden</body></html>",
      },
    ]);
    const pageErrorSite = `error-preview-${randomUUID().slice(0, 8)}`;

    const pageErrorArtifact = await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      site: pageErrorSite,
    });
    await flushWaitUntilForTest();

    const challengeRequests = mockCloudflareSnapshot([
      {
        title: "Just a moment...",
        content:
          "<!doctype html><html><body><h1>Performing security verification</h1><p>Incompatible browser extension or network configuration</p><script>window.__cf_chl_opt={}</script></body></html>",
      },
    ]);
    const challengeSite = `challenge-preview-${randomUUID().slice(0, 8)}`;

    const challengeArtifact = await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      site: challengeSite,
    });
    await flushWaitUntilForTest();

    for (const rejected of [
      {
        site: pageErrorSite,
        deploymentId: pageErrorArtifact.deploymentId,
      },
      {
        site: challengeSite,
        deploymentId: challengeArtifact.deploymentId,
      },
    ]) {
      const rejectedArtifact = await findCatalogArtifact(
        owner.actor,
        rejected.site,
      );
      expect(rejectedArtifact).toMatchObject({ kind: "hosted-site" });
      expect(rejectedArtifact?.thumbnail).toBeNull();
      expect(
        owner.objectStore.puts.some((put) => {
          return put.key.endsWith(`/preview-v3-${rejected.deploymentId}.webp`);
        }),
      ).toBeFalsy();
    }
    expect(pageErrorRequests).toHaveLength(1);
    expect(challengeRequests).toHaveLength(1);
  }, 180_000);
});
