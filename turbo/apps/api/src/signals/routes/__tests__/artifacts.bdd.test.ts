import { createHash, randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import type { ArtifactSummary } from "@vm0/api-contracts/contracts/artifact-catalog";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { testContext } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import {
  createChatFilesBddApi,
  hostedTextFile,
} from "./helpers/api-bdd-chat-files";
import { createHostMapsBddApi } from "./helpers/api-bdd-host-maps";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
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
  if (!actor.orgId) {
    throw new Error("Expected artifact test actor to have an org");
  }
  // Preview coverage reads the artifact catalog, which the `Artifacts` switch
  // gates. Overrides merge, so later per-test switch updates still apply.
  await updateFeatureSwitchesForUser(
    context,
    { userId: actor.userId, orgId: actor.orgId },
    { [FeatureSwitchKey.Artifacts]: true },
  );
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
  it("leaves video preview empty when immediate posters are disabled", async () => {
    const owner = await artifactActor(
      "Artifacts API disabled video preview agent",
    );
    await setVideoArtifactPosters(owner.actor, false);
    const frameRequests = mockCloudflareVideoFrame(owner.actor.userId);

    await createRunUploadedFile({
      owner,
      prompt: "upload video without poster generation",
      filename: "poster-disabled.mp4",
      contentType: "video/mp4",
    });
    await flushWaitUntilForTest();

    expect(frameRequests).toHaveLength(0);
    expect(
      owner.objectStore.puts.some((put) => {
        return put.key.endsWith("/poster-v2.jpg");
      }),
    ).toBeFalsy();
    const artifact = await findCatalogArtifact(
      owner.actor,
      "poster-disabled.mp4",
    );
    expect(artifact).toMatchObject({ kind: "file" });
    expect(artifact?.thumbnail).toBeNull();
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
      return put.key.endsWith("/poster-v2.jpg");
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
    expect(previewedArtifact?.thumbnail?.url).toMatch(/\/poster-v2\.jpg$/);
  }, 180_000);

  it("reuses an existing write-once poster after a concurrent upload", async () => {
    const owner = await artifactActor(
      "Artifacts API concurrent video preview agent",
    );
    await setVideoArtifactPosters(owner.actor, true);
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
    expect(previewedArtifact?.thumbnail?.url).toMatch(/\/poster-v2\.jpg$/);
  }, 180_000);

  it("leaves video preview empty when media frame extraction fails", async () => {
    const owner = await artifactActor("Artifacts API video preview fail agent");
    await setVideoArtifactPosters(owner.actor, true);
    const frameRequests = mockCloudflareVideoFrame(owner.actor.userId, 415);

    await createRunUploadedFile({
      owner,
      prompt: "create unsupported video artifact",
      filename: "unsupported-video.webm",
      contentType: "video/webm",
    });
    await flushWaitUntilForTest();

    expect(frameRequests).toHaveLength(1);
    expect(
      owner.objectStore.puts.some((put) => {
        return put.key.endsWith("/poster-v2.jpg");
      }),
    ).toBeFalsy();

    const failedArtifact = await findCatalogArtifact(
      owner.actor,
      "unsupported-video.webm",
    );
    expect(failedArtifact).toMatchObject({ kind: "file" });
    expect(failedArtifact?.thumbnail).toBeNull();
  }, 180_000);
});

describe("hosted Artifact previews", () => {
  it("generates deploy-time preview images and refreshes them after redeploy", async () => {
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
    expect(firstArtifact?.thumbnail?.url).toContain(
      `/preview-v3-${artifact.deploymentId}.webp`,
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
      owner.objectStore.puts.find((put) => {
        return put.key.endsWith(`/preview-v3-${artifact.deploymentId}.webp`);
      }),
    ).toMatchObject({
      bucket: "test-user-artifacts",
      cacheControl: "public, max-age=31536000, immutable",
      contentType: "image/webp",
      ifNoneMatch: "*",
    });

    await chat.completeHostedSite(owner.actor, artifact.deploymentId);
    await flushWaitUntilForTest();

    const retriedArtifact = await findCatalogArtifact(owner.actor, site);
    expect(retriedArtifact?.thumbnail?.url).toBe(firstArtifact?.thumbnail?.url);
    expect(snapshotRequests).toHaveLength(1);

    host.captureHostedSitesS3();
    const redeployed = await host.redeployHtml(owner.actor, {
      url: artifact.url,
      html: "<!doctype html><html><body>redeployed preview</body></html>",
    });
    await flushWaitUntilForTest();

    // Redeploying keeps one catalog card for the site and repoints its
    // thumbnail at the newest deployment preview.
    const refreshedArtifact = await findCatalogArtifact(owner.actor, site);
    expect(refreshedArtifact?.id).toBe(firstArtifact?.id);
    expect(refreshedArtifact?.thumbnail?.url).toContain(
      `/preview-v3-${redeployed.deploymentId}.webp`,
    );
    expect(refreshedArtifact?.thumbnail?.url).not.toBe(
      firstArtifact?.thumbnail?.url,
    );
    expect(snapshotRequests).toHaveLength(2);
    expect(snapshotRequests[1]?.body).toMatchObject({ url: artifact.url });
  }, 120_000);

  it("rejects page errors and Cloudflare challenges instead of saving them as previews", async () => {
    const owner = await artifactActor("Artifacts API challenge preview agent");
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
    mockEnv("ARTIFACT_PREVIEW_WAF_SECRET", ARTIFACT_PREVIEW_WAF_SECRET);
    const pageErrorRequests = mockCloudflareSnapshot({
      status: 403,
      title: "Forbidden",
      content: "<!doctype html><html><body>forbidden</body></html>",
    });

    const pageErrorSite = `error-preview-${randomUUID().slice(0, 8)}`;
    const pageErrorArtifact = await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      site: pageErrorSite,
    });
    await flushWaitUntilForTest();

    const challengeRequests = mockCloudflareSnapshot({
      title: "Just a moment...",
      content:
        "<!doctype html><html><body><h1>Performing security verification</h1><p>Incompatible browser extension or network configuration</p><script>window.__cf_chl_opt={}</script></body></html>",
    });

    const challengeSite = `challenge-preview-${randomUUID().slice(0, 8)}`;
    const challengeArtifact = await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      site: challengeSite,
    });
    await flushWaitUntilForTest();

    for (const rejected of [
      { site: pageErrorSite, deploymentId: pageErrorArtifact.deploymentId },
      { site: challengeSite, deploymentId: challengeArtifact.deploymentId },
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

describe("POST /api/zero/artifacts/favorite", () => {
  it("stores and clears favorite state for a visible artifact", async () => {
    const owner = await artifactActor("Artifacts API favorites agent");
    const filename = `favorite-${randomUUID().slice(0, 8)}.txt`;
    const artifact = await createRunUploadedFile({
      owner,
      prompt: "create a favorite artifact",
      filename,
      contentType: "text/plain",
    });

    await expect(
      chat.listArtifactFavorites(owner.actor),
    ).resolves.toStrictEqual({ artifactUrls: [] });

    await chat.favoriteArtifact(owner.actor, artifact.url);

    await expect(
      chat.listArtifactFavorites(owner.actor),
    ).resolves.toStrictEqual({ artifactUrls: [artifact.url] });

    // Favoriting is caller-scoped state next to the catalog, so the artifact
    // itself keeps its single catalog card unchanged.
    const favorited = await findCatalogArtifact(owner.actor, filename);
    expect(favorited).toMatchObject({ kind: "file", title: filename });

    await chat.unfavoriteArtifact(owner.actor, artifact.url);

    await expect(
      chat.listArtifactFavorites(owner.actor),
    ).resolves.toStrictEqual({ artifactUrls: [] });

    const unfavorited = await findCatalogArtifact(owner.actor, filename);
    expect(unfavorited?.id).toBe(favorited?.id);
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
