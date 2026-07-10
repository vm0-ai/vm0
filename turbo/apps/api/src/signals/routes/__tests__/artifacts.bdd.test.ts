import { createHash, randomUUID } from "node:crypto";

import { cronArtifactPreviewContract } from "@vm0/api-contracts/contracts/cron";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { markHostedArtifactEligibleForPreviewCron } from "./helpers/artifact-preview-state";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import {
  createChatFilesBddApi,
  hostedTextFile,
} from "./helpers/api-bdd-chat-files";
import { createHostMapsBddApi } from "./helpers/api-bdd-host-maps";
import { createRunsAutomationsApi } from "./helpers/api-bdd-runs-automations";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsAutomationsApi(context);
const chat = createChatFilesBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const host = createHostMapsBddApi(context);
const webhooks = createWebhookCallbackApi(context);
const CLOUDFLARE_SCREENSHOT_URL =
  "https://api.cloudflare.com/client/v4/accounts/test-account/browser-rendering/screenshot";
const CLOUDFLARE_MEDIA_FRAME_URL =
  /^https:\/\/cdn\.vm7\.io\/cdn-cgi\/media\/mode=frame,time=1s,width=640,format=jpg\//;
const CRON_SECRET = "test-cron-secret";

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

interface ScreenshotRequest {
  readonly authorization: string | null;
  readonly body: unknown;
}

interface MediaFrameRequest {
  readonly url: string;
}

function cronClient() {
  return setupApp({ context })(cronArtifactPreviewContract);
}

function cronHeaders(secret = CRON_SECRET) {
  return { authorization: `Bearer ${secret}` };
}

function mockCloudflareScreenshot(): ScreenshotRequest[] {
  const requests: ScreenshotRequest[] = [];
  server.use(
    http.post(CLOUDFLARE_SCREENSHOT_URL, async ({ request }) => {
      requests.push({
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      });
      return new HttpResponse(new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
        headers: { "Content-Type": "image/webp" },
      });
    }),
  );
  return requests;
}

function mockCloudflareVideoFrame(status = 200): MediaFrameRequest[] {
  const requests: MediaFrameRequest[] = [];
  server.use(
    http.get(CLOUDFLARE_MEDIA_FRAME_URL, ({ request }) => {
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

function featureSwitchActor(actor: ApiTestUser): {
  readonly userId: string;
  readonly orgId: string;
  readonly orgRole?: "org:admin" | "org:member";
} {
  if (actor.orgId === null) {
    throw new Error("Expected artifact test actor to have an org");
  }
  if (actor.orgRole === undefined) {
    return { userId: actor.userId, orgId: actor.orgId };
  }
  return {
    userId: actor.userId,
    orgId: actor.orgId,
    orgRole: actor.orgRole,
  };
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

async function createHostedArtifactsInRun(args: {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly sites: readonly string[];
  readonly artifactKind?: "hosted-site" | "presentation-html";
}): Promise<
  readonly {
    readonly runId: string;
    readonly threadId: string;
    readonly fileId: string;
    readonly url: string;
    readonly deploymentId: string;
  }[]
> {
  const run = await sendChatRun(args.actor, {
    agentId: args.agentId,
    prompt: `create ${args.sites.join(", ")}`,
  });
  const { claim, sandboxHeaders } = await claimChatRun(
    args.runnerGroup,
    run.runId,
  );
  const bearer = `Bearer ${zeroTokenFromClaim(claim)}`;
  const artifacts = [];
  for (const site of args.sites) {
    const prepared = await chat.prepareHostedSiteWithBearer(bearer, {
      site,
      artifactKind: args.artifactKind ?? "hosted-site",
      spaFallback: false,
      files: [hostedTextFile("/index.html", `<main>${site}</main>`)],
    });
    await chat.completeHostedSiteWithBearer(bearer, prepared.deploymentId);
    artifacts.push({
      runId: run.runId,
      threadId: run.threadId,
      fileId: prepared.url,
      url: prepared.url,
      deploymentId: prepared.deploymentId,
    });
  }
  await completeChatRunOk(run.runId, sandboxHeaders);
  return artifacts;
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

describe("GET /api/cron/artifact-preview", () => {
  it("rejects invalid cron secrets and no-ops when browser rendering is unconfigured", async () => {
    mockEnv("CRON_SECRET", CRON_SECRET);

    const rejected = await accept(
      cronClient().generate({ headers: cronHeaders("wrong-secret") }),
      [401],
    );
    expect(rejected.body.error.message).toBe("Invalid cron secret");

    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", undefined);
    const generated = await accept(
      cronClient().generate({ headers: cronHeaders() }),
      [200],
    );
    expect(generated.body).toStrictEqual({ generated: 0 });
  });

  it("generates stale hosted artifact previews through the cron fallback", async () => {
    const owner = await artifactActor("Artifacts API cron preview agent");
    const disabledOwner = await artifactActor(
      "Artifacts API cron disabled preview agent",
    );
    if (!owner.actor.orgId) {
      throw new Error("Expected cron preview test actor to have an org");
    }
    if (!disabledOwner.actor.orgId) {
      throw new Error(
        "Expected cron preview disabled test actor to have an org",
      );
    }
    mockEnv("CRON_SECRET", CRON_SECRET);
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", undefined);
    const screenshotRequests = mockCloudflareScreenshot();

    const artifact = await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      site: `cron-preview-${randomUUID().slice(0, 8)}`,
    });
    const disabledArtifacts = await createHostedArtifactsInRun({
      actor: disabledOwner.actor,
      agentId: disabledOwner.agentId,
      runnerGroup: disabledOwner.runnerGroup,
      sites: Array.from({ length: 10 }, (_, index) => {
        return `cron-disabled-${index}-${randomUUID().slice(0, 8)}`;
      }),
    });
    await flushWaitUntilForTest();
    expect(screenshotRequests).toHaveLength(0);

    await markHostedArtifactEligibleForPreviewCron(context, artifact);
    for (const disabledArtifact of disabledArtifacts) {
      await markHostedArtifactEligibleForPreviewCron(context, disabledArtifact);
    }
    const previewObjectStore = chatCallbacks.acceptChatObjectStorage();
    await updateFeatureSwitchesForUser(
      context,
      {
        userId: owner.actor.userId,
        orgId: owner.actor.orgId,
        orgRole: owner.actor.orgRole,
      },
      {
        [FeatureSwitchKey.ArtifactPreviewImage]: true,
      },
    );
    await updateFeatureSwitchesForUser(
      context,
      {
        userId: disabledOwner.actor.userId,
        orgId: disabledOwner.actor.orgId,
        orgRole: disabledOwner.actor.orgRole,
      },
      {
        [FeatureSwitchKey.ArtifactPreviewImage]: false,
      },
    );
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");

    const generated = await accept(
      cronClient().generate({ headers: cronHeaders() }),
      [200],
    );
    expect(generated.body).toStrictEqual({ generated: 1 });

    const response = await chat.listArtifacts(owner.actor);
    const previewedArtifact = response.artifacts.find((item) => {
      return item.fileId === artifact.fileId;
    });
    expect(previewedArtifact?.previewImageUrl).toContain(
      `/preview-${artifact.deploymentId}.webp`,
    );
    expect(screenshotRequests).toHaveLength(1);
    expect(screenshotRequests[0]).toMatchObject({
      authorization: "Bearer preview-token",
      body: {
        url: artifact.url,
        viewport: {
          width: 1280,
          height: 800,
          deviceScaleFactor: 0.5,
        },
        screenshotOptions: { type: "webp", quality: 80 },
      },
    });
    expect(
      previewObjectStore.puts.some((put) => {
        return (
          put.bucket === "test-user-artifacts" &&
          put.key.endsWith(`/preview-${artifact.deploymentId}.webp`) &&
          put.contentType === "image/webp"
        );
      }),
    ).toBeTruthy();

    const disabledResponse = await chat.listArtifacts(disabledOwner.actor);
    for (const disabledArtifact of disabledArtifacts) {
      const item = disabledResponse.artifacts.find((candidate) => {
        return candidate.fileId === disabledArtifact.fileId;
      });
      expect(item).toBeDefined();
      expect(item).not.toHaveProperty("previewImageUrl");
    }
  }, 180_000);

  it("generates poster frames for generated video artifacts and ignores ordinary video uploads", async () => {
    const owner = await artifactActor("Artifacts API video preview agent");
    if (!owner.actor.orgId) {
      throw new Error("Expected video preview test actor to have an org");
    }
    mockEnv("CRON_SECRET", CRON_SECRET);
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", undefined);
    const frameRequests = mockCloudflareVideoFrame();

    const videoArtifact = await createRunUploadedFile({
      owner,
      prompt: "create generated video artifact",
      filename: "launch-video.mp4",
      contentType: "video/mp4",
    });
    const ordinaryVideoUpload = await createRunUploadedFile({
      owner,
      prompt: "upload reference footage",
      filename: "reference-footage.mp4",
      contentType: "video/mp4",
    });
    const videoArtifactRowId = await markHostedArtifactEligibleForPreviewCron(
      context,
      videoArtifact,
      {
        generatedBy: "zero-official-video",
      },
    );
    const ordinaryVideoUploadRowId =
      await markHostedArtifactEligibleForPreviewCron(
        context,
        ordinaryVideoUpload,
      );
    await updateFeatureSwitchesForUser(
      context,
      {
        userId: owner.actor.userId,
        orgId: owner.actor.orgId,
        orgRole: owner.actor.orgRole,
      },
      {
        [FeatureSwitchKey.ArtifactVideoPreview]: true,
      },
    );

    const generated = await accept(
      cronClient().generate({ headers: cronHeaders() }),
      [200],
    );
    expect(generated.body).toStrictEqual({ generated: 1 });
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
    expect(posterPuts[0]?.key).toContain(`/${videoArtifactRowId}/poster.jpg`);
    expect(posterPuts[0]?.key).not.toContain(`/${ordinaryVideoUploadRowId}/`);

    const response = await chat.listArtifacts(owner.actor);
    const previewedArtifact = response.artifacts.find((item) => {
      return item.fileId === videoArtifact.fileId;
    });
    expect(previewedArtifact?.previewImageUrl).toContain(
      `/${videoArtifactRowId}/poster.jpg`,
    );
    expect(
      response.artifacts.some((item) => {
        return item.fileId === ordinaryVideoUpload.fileId;
      }),
    ).toBeFalsy();
  }, 180_000);

  it("does not render video posters when the video preview switch is disabled", async () => {
    const owner = await artifactActor("Artifacts API video preview off agent");
    if (!owner.actor.orgId) {
      throw new Error(
        "Expected video preview disabled test actor to have an org",
      );
    }
    mockEnv("CRON_SECRET", CRON_SECRET);
    const frameRequests = mockCloudflareVideoFrame();

    const videoArtifact = await createRunUploadedFile({
      owner,
      prompt: "create disabled generated video artifact",
      filename: "disabled-video.mp4",
      contentType: "video/mp4",
    });
    await markHostedArtifactEligibleForPreviewCron(context, videoArtifact, {
      generatedBy: "zero-official-video",
    });
    await updateFeatureSwitchesForUser(
      context,
      {
        userId: owner.actor.userId,
        orgId: owner.actor.orgId,
        orgRole: owner.actor.orgRole,
      },
      {
        [FeatureSwitchKey.ArtifactVideoPreview]: false,
      },
    );

    const generated = await accept(
      cronClient().generate({ headers: cronHeaders() }),
      [200],
    );
    expect(generated.body).toStrictEqual({ generated: 0 });
    expect(frameRequests).toHaveLength(0);
    expect(
      owner.objectStore.puts.some((put) => {
        return put.key.endsWith("/poster.jpg");
      }),
    ).toBeFalsy();

    const response = await chat.listArtifacts(owner.actor);
    const disabledArtifact = response.artifacts.find((item) => {
      return item.fileId === videoArtifact.fileId;
    });
    expect(disabledArtifact).toBeDefined();
    expect(disabledArtifact).not.toHaveProperty("previewImageUrl");
  }, 180_000);

  it("leaves video preview empty when media frame extraction fails", async () => {
    const owner = await artifactActor("Artifacts API video preview fail agent");
    if (!owner.actor.orgId) {
      throw new Error(
        "Expected video preview failure test actor to have an org",
      );
    }
    mockEnv("CRON_SECRET", CRON_SECRET);
    const frameRequests = mockCloudflareVideoFrame(415);

    const videoArtifact = await createRunUploadedFile({
      owner,
      prompt: "create unsupported video artifact",
      filename: "unsupported-video.webm",
      contentType: "video/webm",
    });
    await markHostedArtifactEligibleForPreviewCron(context, videoArtifact, {
      generatedBy: "zero-official-video",
    });
    await updateFeatureSwitchesForUser(
      context,
      {
        userId: owner.actor.userId,
        orgId: owner.actor.orgId,
        orgRole: owner.actor.orgRole,
      },
      {
        [FeatureSwitchKey.ArtifactVideoPreview]: true,
      },
    );

    const generated = await accept(
      cronClient().generate({ headers: cronHeaders() }),
      [200],
    );
    expect(generated.body).toStrictEqual({ generated: 0 });
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
  it("lists generated artifacts for the active organization and excludes ordinary uploads", async () => {
    const userId = `user_${randomUUID()}`;
    const actor = bdd.user({ userId, orgId: `org_${randomUUID()}` });
    const otherOrgActor = bdd.user({
      userId,
      orgId: `org_${randomUUID()}`,
    });
    const current = await artifactActor("Artifacts API org agent", actor);
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
    expect(response.artifacts).toHaveLength(1);
    expect(response.artifacts[0]).toMatchObject({
      threadId: run.threadId,
      runId: run.runId,
      fileId: prepared.url,
      url: prepared.url,
      size: hostedFile.size,
      artifactKind: "hosted-site",
    });
    expect(response.artifacts[0]).not.toHaveProperty("previewImageUrl");
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

  it("generates deploy-time preview images and refreshes them after redeploy", async () => {
    const owner = await artifactActor("Artifacts API preview image agent");
    if (!owner.actor.orgId) {
      throw new Error("Expected preview image test actor to have an org");
    }
    await updateFeatureSwitchesForUser(
      context,
      {
        userId: owner.actor.userId,
        orgId: owner.actor.orgId,
        orgRole: owner.actor.orgRole,
      },
      {
        [FeatureSwitchKey.ArtifactPreviewImage]: true,
      },
    );
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
    const screenshotRequests = mockCloudflareScreenshot();

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
      `/preview-${artifact.deploymentId}.webp`,
    );
    expect(screenshotRequests).toHaveLength(1);
    expect(screenshotRequests[0]).toMatchObject({
      authorization: "Bearer preview-token",
      body: {
        url: artifact.url,
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
          put.key.endsWith(`/preview-${artifact.deploymentId}.webp`) &&
          put.contentType === "image/webp"
        );
      }),
    ).toBeTruthy();

    host.captureHostedSitesS3();
    const redeployed = await host.redeployHtml(owner.actor, {
      url: artifact.url,
      html: "<!doctype html><html><body>redeployed preview</body></html>",
    });
    await flushWaitUntilForTest();

    const refreshedResponse = await chat.listArtifacts(owner.actor);
    const refreshedArtifact = refreshedResponse.artifacts.find((item) => {
      return item.fileId === artifact.fileId;
    });
    expect(refreshedArtifact?.previewImageUrl).toContain(
      `/preview-${redeployed.deploymentId}.webp`,
    );
    expect(refreshedArtifact?.previewImageUrl).not.toBe(
      firstArtifact?.previewImageUrl,
    );
    expect(screenshotRequests).toHaveLength(2);
    expect(screenshotRequests[1]?.body).toMatchObject({ url: artifact.url });
  }, 120_000);

  it("does not render previews when the feature switch is disabled with browser rendering configured", async () => {
    const owner = await artifactActor("Artifacts API preview disabled agent");
    if (!owner.actor.orgId) {
      throw new Error("Expected preview disabled test actor to have an org");
    }
    await updateFeatureSwitchesForUser(
      context,
      {
        userId: owner.actor.userId,
        orgId: owner.actor.orgId,
        orgRole: owner.actor.orgRole,
      },
      {
        [FeatureSwitchKey.ArtifactPreviewImage]: false,
      },
    );
    mockEnv("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN", "preview-token");
    const screenshotRequests = mockCloudflareScreenshot();

    const artifact = await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      site: `preview-disabled-${randomUUID().slice(0, 8)}`,
    });
    await flushWaitUntilForTest();

    const response = await chat.listArtifacts(owner.actor);
    const disabledArtifact = response.artifacts.find((item) => {
      return item.fileId === artifact.fileId;
    });
    expect(disabledArtifact).toBeDefined();
    expect(disabledArtifact).not.toHaveProperty("previewImageUrl");
    expect(screenshotRequests).toHaveLength(0);
    expect(
      owner.objectStore.puts.some((put) => {
        return put.key.endsWith(`/preview-${artifact.deploymentId}.webp`);
      }),
    ).toBeFalsy();
  }, 120_000);

  it("returns every generated artifact for the org in one bulk response", async () => {
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

    // Every artifact surfaced exactly once across pages — no cursor-drift dups,
    // no skips — proving keyset walks the deduped winner set correctly.
    expect(collected).toHaveLength(created.length);
    expect(new Set(collected)).toStrictEqual(new Set(created));
  }, 120_000);
});

describe("POST /api/zero/artifacts/favorite", () => {
  it("creates and deletes user-scoped artifact favorite records", async () => {
    const owner = await artifactActor("Artifacts API favorites agent");
    const artifact = await createHostedArtifact({
      actor: owner.actor,
      agentId: owner.agentId,
      runnerGroup: owner.runnerGroup,
      site: `favorite-${randomUUID().slice(0, 8)}`,
    });

    const disabled = await chat.requestFavoriteArtifact(
      owner.actor,
      artifact.url,
      [204],
    );
    if (disabled.status !== 204) {
      throw new Error("Expected disabled favorite request to no-op");
    }

    const disabledList = await chat.listArtifacts(owner.actor);
    const disabledArtifact = disabledList.artifacts.find((item) => {
      return item.fileId === artifact.fileId;
    });
    if (!disabledArtifact) {
      throw new Error("Expected disabled favorite artifact to be listed");
    }
    expect(disabledArtifact.isFavorited).toBeFalsy();

    await updateFeatureSwitchesForUser(
      context,
      featureSwitchActor(owner.actor),
      {
        [FeatureSwitchKey.ArtifactFavorites]: true,
      },
    );

    await chat.favoriteArtifact(owner.actor, artifact.url);

    const favorited = await chat.listArtifacts(owner.actor);
    const favoritedArtifact = favorited.artifacts.find((item) => {
      return item.fileId === artifact.fileId;
    });
    if (!favoritedArtifact) {
      throw new Error("Expected favorite artifact to be listed");
    }
    expect(favoritedArtifact.isFavorited).toBeTruthy();

    await chat.unfavoriteArtifact(owner.actor, artifact.url);

    const unfavorited = await chat.listArtifacts(owner.actor);
    const unfavoritedArtifact = unfavorited.artifacts.find((item) => {
      return item.fileId === artifact.fileId;
    });
    if (!unfavoritedArtifact) {
      throw new Error("Expected unfavorited artifact to be listed");
    }
    expect(unfavoritedArtifact.isFavorited).toBeFalsy();
  }, 120_000);

  it("rejects favorite requests for artifacts outside the caller visibility set", async () => {
    const owner = await artifactActor("Artifacts API favorites visibility");
    await updateFeatureSwitchesForUser(
      context,
      featureSwitchActor(owner.actor),
      {
        [FeatureSwitchKey.ArtifactFavorites]: true,
      },
    );

    const missing = await chat.requestFavoriteArtifact(
      owner.actor,
      `https://artifacts.example.com/${randomUUID()}.html`,
      [404],
    );

    if (missing.status !== 404) {
      throw new Error("Expected missing artifact favorite request to 404");
    }
    expect(missing.body.error.code).toBe("NOT_FOUND");
  }, 120_000);
});
