import { randomUUID } from "node:crypto";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";

import {
  integrationsSlackUploadCompleteContract,
  integrationsSlackUploadInitContract,
  integrationsSlackUploadMaterializeContract,
} from "@vm0/api-contracts/contracts/integrations";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";
import {
  deleteSlackIntegrationFixture$,
  seedSlackOrgInstallation$,
  type SlackIntegrationFixture,
} from "./helpers/zero-integrations-slack";
import {
  deleteUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const bdd = createBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const chatApi = createChatFilesBddApi(context);
const runsApi = createRunsApi(context);

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
  readonly capabilities?: readonly string[];
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: (args.capabilities ?? ["slack:write"]) as never,
    iat: seconds,
    exp: seconds + 60,
  });
}

function sandboxToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "sandbox",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    iat: seconds,
    exp: seconds + 60,
  });
}

interface RunScopedContext {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly threadId: string;
}

describe("POST /api/zero/integrations/slack/upload-file/complete", () => {
  const slackFixtures: SlackIntegrationFixture[] = [];
  const insightFixtures: UsageInsightFixture[] = [];

  function actorFor(args: { readonly orgId: string; readonly userId: string }) {
    return {
      orgId: args.orgId,
      userId: args.userId,
      orgRole: "org:admin",
      email: `${args.userId}@example.test`,
    } satisfies ApiTestUser;
  }

  async function visibleUploadedFiles(args: {
    readonly orgId: string;
    readonly userId: string;
    readonly threadId: string;
    readonly runId: string;
  }) {
    const artifacts = await chatApi.listThreadArtifacts(
      actorFor(args),
      args.threadId,
    );
    return (
      artifacts.runs.find((run) => {
        return run.runId === args.runId;
      })?.files ?? []
    );
  }

  beforeEach(() => {
    context.mocks.slack.files.completeUploadExternal.mockResolvedValue({
      ok: true,
    });
  });

  afterEach(async () => {
    while (slackFixtures.length > 0) {
      const fixture = slackFixtures.pop();
      if (fixture) {
        await store.set(
          deleteSlackIntegrationFixture$,
          fixture,
          context.signal,
        );
      }
    }
    while (insightFixtures.length > 0) {
      const fixture = insightFixtures.pop();
      if (fixture) {
        await store.set(deleteUsageInsightFixture$, fixture, context.signal);
      }
    }
  });

  function mockSlackFileInfo(fileId: string): void {
    context.mocks.slack.files.info.mockResolvedValue({
      ok: true,
      file: {
        id: fileId,
        name: "report.csv",
        title: "Slack Report",
        mimetype: "text/csv",
        filetype: "csv",
        size: 42,
        permalink: `https://slack.example/files/${fileId}`,
      },
    });
  }

  async function seedBaseContext(): Promise<{
    orgId: string;
    userId: string;
  }> {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    await store.set(
      seedOrgMembership$,
      { orgId, userId, role: "admin" },
      context.signal,
    );
    insightFixtures.push({ orgId, userId });
    return { orgId, userId };
  }

  async function seedWithInstallation(): Promise<{
    orgId: string;
    userId: string;
  }> {
    const base = await seedBaseContext();
    const fixture = await store.set(
      seedSlackOrgInstallation$,
      { orgId: base.orgId },
      context.signal,
    );
    slackFixtures.push(fixture);
    return base;
  }

  async function seedRunScoped(): Promise<RunScopedContext> {
    const base = await seedWithInstallation();
    const actor = actorFor(base);
    await runsApi.grantProEntitlement(actor);
    await runsApi.ensureOrgModelProvider(actor);
    const runnerGroup = runsApi.configureRunnerGroup();
    await runsApi.heartbeatRunner(runnerGroup);
    const agent = await bdd.createAgent(actor, {
      displayName: `Slack upload ${randomUUID().slice(0, 8)}`,
    });
    const sent = await chatApi.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        prompt: "Create a run for Slack upload completion",
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected chat send to create a run for Slack upload");
    }
    return {
      orgId: base.orgId,
      userId: base.userId,
      runId: sent.body.runId,
      threadId: sent.body.threadId,
    };
  }

  it("returns 401 when no auth token is provided", async () => {
    const client = setupApp({ context })(
      integrationsSlackUploadCompleteContract,
    );
    const response = await accept(
      client.complete({
        body: { fileId: "F123", channel: "C123" },
        headers: {},
      }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 when sandbox token lacks slack:write", async () => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const runId = `run_${randomUUID()}`;
    const token = sandboxToken({ userId, orgId, runId });

    const client = setupApp({ context })(
      integrationsSlackUploadCompleteContract,
    );
    const response = await accept(
      client.complete({
        body: { fileId: "F123", channel: "C123" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );
    expect(response.body.error.message).toContain("slack:write");
  });

  it("returns 404 when no Slack installation exists for org", async () => {
    const { orgId, userId } = await seedBaseContext();
    const token = zeroToken({ userId, orgId, runId: `run_${randomUUID()}` });

    const client = setupApp({ context })(
      integrationsSlackUploadCompleteContract,
    );
    const response = await accept(
      client.complete({
        body: { fileId: "F123", channel: "C123" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [404],
    );
    expect(response.body.error.message).toContain("No Slack installation");
  });

  it("forwards Slack file info errors as 400 SLACK_ERROR", async () => {
    const { orgId, userId, runId, threadId } = await seedRunScoped();
    const fileId = `F-${randomUUID().slice(0, 8)}`;
    const token = zeroToken({ userId, orgId, runId });
    context.mocks.slack.files.info.mockRejectedValueOnce(
      Object.assign(new Error("file_not_found"), {
        data: { ok: false, error: "file_not_found" },
      }),
    );

    const client = setupApp({ context })(
      integrationsSlackUploadCompleteContract,
    );
    const response = await accept(
      client.complete({
        body: { fileId, channel: "C123" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("SLACK_ERROR");
    expect(response.body.error.message).toContain("file_not_found");
    const files = await visibleUploadedFiles({
      orgId,
      userId,
      runId,
      threadId,
    });
    expect(files).toStrictEqual([]);
  });

  it("records a Slack upload for a run-scoped zero token", async () => {
    const { orgId, userId, runId, threadId } = await seedRunScoped();
    const fileId = `F-${randomUUID().slice(0, 8)}`;
    mockSlackFileInfo(fileId);
    const token = zeroToken({ userId, orgId, runId });

    const client = setupApp({ context })(
      integrationsSlackUploadCompleteContract,
    );
    const response = await accept(
      client.complete({
        body: {
          fileId,
          channel: "C123",
          threadTs: "123.456",
          title: "Quarterly report",
          initialComment: "Uploaded from a run",
        },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      fileId,
      permalink: `https://slack.example/files/${fileId}`,
    });

    expect(
      context.mocks.slack.files.completeUploadExternal,
    ).toHaveBeenLastCalledWith({
      files: [{ id: fileId, title: "Quarterly report" }],
      channel_id: "C123",
      thread_ts: "123.456",
      initial_comment: "Uploaded from a run",
    });

    const files = await visibleUploadedFiles({
      orgId,
      userId,
      runId,
      threadId,
    });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      id: fileId,
      filename: "Quarterly report",
      contentType: "text/csv",
      size: 42,
      url: `https://slack.example/files/${fileId}`,
    });
  });

  it("uses one canonical asset for VM0 publication and Slack delivery", async () => {
    const { orgId, userId, runId, threadId } = await seedRunScoped();
    await updateFeatureSwitchesForUser(context, actorFor({ orgId, userId }), {
      [FeatureSwitchKey.CanonicalSlackAssets]: true,
    });
    const objectStore = chatCallbacks.acceptChatObjectStorage();
    const operationId = randomUUID();
    const token = zeroToken({ userId, orgId, runId });
    context.mocks.slack.files.getUploadURLExternal.mockClear();
    context.mocks.slack.files.getUploadURLExternal.mockResolvedValue({
      ok: true,
      upload_url: "https://files.slack.com/upload/v1/canonical",
      file_id: "F-CANONICAL",
    });
    mockSlackFileInfo("F-CANONICAL");

    const initClient = setupApp({ context })(
      integrationsSlackUploadInitContract,
    );
    const initialized = await accept(
      initClient.init({
        body: {
          filename: "report.csv",
          length: 42,
          canonical: {
            operationId,
            contentType: "text/csv",
            checksumSha256: "a".repeat(64),
            channel: "C123",
            threadTs: "123.456",
            title: "Canonical report",
          },
        },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    if (!("kind" in initialized.body)) {
      throw new Error("Expected canonical Slack upload initialization");
    }
    const canonicalAssetId = initialized.body.assetId;
    expect(initialized.body.kind).toBe("canonical");
    expect(
      context.mocks.slack.files.getUploadURLExternal,
    ).not.toHaveBeenCalled();
    objectStore.addObject({
      bucket: "test-user-artifacts",
      key: `artifacts/${userId}/${canonicalAssetId}/report.csv`,
      size: 42,
      body: Buffer.alloc(42, "a"),
    });

    const materializeClient = setupApp({ context })(
      integrationsSlackUploadMaterializeContract,
    );
    const materialized = await accept(
      materializeClient.materialize({
        body: {
          assetId: canonicalAssetId,
          operationId,
        },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(materialized.body).toMatchObject({
      assetId: canonicalAssetId,
      delivery: {
        status: "pending",
        fileId: "F-CANONICAL",
      },
    });
    expect(
      context.mocks.slack.files.getUploadURLExternal,
    ).toHaveBeenCalledTimes(1);

    const completeClient = setupApp({ context })(
      integrationsSlackUploadCompleteContract,
    );
    const completed = await accept(
      completeClient.complete({
        body: {
          fileId: "F-CANONICAL",
          channel: "C123",
          threadTs: "123.456",
          canonicalAssetId,
          operationId,
        },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(completed.body).toMatchObject({
      fileId: "F-CANONICAL",
      assetId: canonicalAssetId,
      deliveryStatus: "delivered",
    });

    const files = await visibleUploadedFiles({
      orgId,
      userId,
      runId,
      threadId,
    });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      id: canonicalAssetId,
      filename: "report.csv",
      url: initialized.body.url,
      assetRef: {
        id: canonicalAssetId,
        classification: "published-output",
        access: "published",
        materialization: { status: "ready" },
      },
    });
    const artifacts = await chatApi.listArtifacts(actorFor({ orgId, userId }));
    expect(
      artifacts.artifacts.find((artifact) => {
        return artifact.assetRef?.id === canonicalAssetId;
      }),
    ).toMatchObject({
      fileId: canonicalAssetId,
      assetRef: { id: canonicalAssetId },
    });
  });

  it("keeps one Slack delivery authoritative across concurrent retries", async () => {
    const { orgId, userId, runId } = await seedRunScoped();
    await updateFeatureSwitchesForUser(context, actorFor({ orgId, userId }), {
      [FeatureSwitchKey.CanonicalSlackAssets]: true,
    });
    const objectStore = chatCallbacks.acceptChatObjectStorage();
    const operationId = randomUUID();
    const token = zeroToken({ userId, orgId, runId });
    const allocations: string[] = [];
    const bothAllocationsStarted = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!bothAllocationsStarted.settled()) {
        bothAllocationsStarted.resolve(undefined);
      }
    });
    context.mocks.slack.files.getUploadURLExternal.mockImplementation(
      async () => {
        const fileId = `F-CONCURRENT-${allocations.length + 1}`;
        allocations.push(fileId);
        if (allocations.length === 2 && !bothAllocationsStarted.settled()) {
          bothAllocationsStarted.resolve(undefined);
        }
        await bothAllocationsStarted.promise;
        return {
          ok: true,
          upload_url: `https://files.slack.com/upload/v1/${fileId}`,
          file_id: fileId,
        };
      },
    );

    const initClient = setupApp({ context })(
      integrationsSlackUploadInitContract,
    );
    const initialized = await accept(
      initClient.init({
        body: {
          filename: "report.csv",
          length: 42,
          canonical: {
            operationId,
            contentType: "text/csv",
            checksumSha256: "a".repeat(64),
            channel: "C123",
            threadTs: "123.456",
            title: "Canonical report",
          },
        },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    if (!("kind" in initialized.body)) {
      throw new Error("Expected canonical Slack upload initialization");
    }
    const canonicalAssetId = initialized.body.assetId;
    objectStore.addObject({
      bucket: "test-user-artifacts",
      key: `artifacts/${userId}/${canonicalAssetId}/report.csv`,
      size: 42,
      body: Buffer.alloc(42, "a"),
    });

    const materializeClient = setupApp({ context })(
      integrationsSlackUploadMaterializeContract,
    );
    const materialize = () => {
      return accept(
        materializeClient.materialize({
          body: {
            assetId: canonicalAssetId,
            operationId,
          },
          headers: { authorization: `Bearer ${token}` },
        }),
        [200],
      );
    };
    const materialized = await Promise.all([materialize(), materialize()]);
    const deliveries = materialized.map((response) => {
      return response.body.delivery;
    });
    const pendingDeliveries = deliveries.filter((delivery) => {
      return delivery.status === "pending";
    });
    const failedDeliveries = deliveries.filter((delivery) => {
      return delivery.status === "failed";
    });
    expect(pendingDeliveries).toHaveLength(1);
    expect(failedDeliveries).toHaveLength(1);
    expect(failedDeliveries[0]).toMatchObject({
      status: "failed",
      message: expect.stringContaining("already in progress"),
      retryable: true,
    });
    const pendingDelivery = pendingDeliveries[0];
    if (!pendingDelivery || pendingDelivery.status !== "pending") {
      throw new Error("Expected one authoritative pending Slack delivery");
    }
    const staleFileId = allocations.find((fileId) => {
      return fileId !== pendingDelivery.fileId;
    });
    if (!staleFileId) {
      throw new Error("Expected a stale concurrent Slack file allocation");
    }

    const completeClient = setupApp({ context })(
      integrationsSlackUploadCompleteContract,
    );
    const staleCompletion = await accept(
      completeClient.complete({
        body: {
          fileId: staleFileId,
          channel: "C123",
          threadTs: "123.456",
          canonicalAssetId,
          operationId,
        },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(staleCompletion.body).toMatchObject({
      fileId: staleFileId,
      assetId: canonicalAssetId,
      deliveryStatus: "failed",
      deliveryError: expect.stringContaining("already in progress"),
    });

    mockSlackFileInfo(pendingDelivery.fileId);
    const completed = await accept(
      completeClient.complete({
        body: {
          fileId: pendingDelivery.fileId,
          channel: "C123",
          threadTs: "123.456",
          canonicalAssetId,
          operationId,
        },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(completed.body).toMatchObject({
      fileId: pendingDelivery.fileId,
      assetId: canonicalAssetId,
      deliveryStatus: "delivered",
    });

    const staleFailure = await accept(
      completeClient.complete({
        body: {
          fileId: staleFileId,
          channel: "C123",
          threadTs: "123.456",
          canonicalAssetId,
          operationId,
          uploadError: "stale upload failed",
        },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(staleFailure.body).toMatchObject({
      fileId: pendingDelivery.fileId,
      assetId: canonicalAssetId,
      deliveryStatus: "delivered",
    });

    const rematerialized = await materialize();
    expect(rematerialized.body.delivery).toMatchObject({
      status: "delivered",
      fileId: pendingDelivery.fileId,
      permalink: `https://slack.example/files/${pendingDelivery.fileId}`,
    });
  });

  it("generates a poster immediately for a Slack video Artifact", async () => {
    const { orgId, userId, runId } = await seedRunScoped();
    await updateFeatureSwitchesForUser(context, actorFor({ orgId, userId }), {
      [FeatureSwitchKey.VideoArtifactPosters]: true,
    });
    const fileId = `F-${randomUUID().slice(0, 8)}`;
    const permalink = `https://slack.example/files/${fileId}`;
    context.mocks.slack.files.info.mockResolvedValue({
      ok: true,
      file: {
        id: fileId,
        name: "demo.mp4",
        title: "Demo video",
        mimetype: "video/mp4",
        filetype: "mp4",
        size: 1024,
        permalink,
      },
    });
    const objectStore = chatCallbacks.acceptChatObjectStorage();
    const frameRequests: string[] = [];
    server.use(
      http.get(
        /^https:\/\/cdn\.vm7\.io\/cdn-cgi\/media\/mode=frame,time=1s,width=640,format=jpg\//,
        ({ request }) => {
          frameRequests.push(request.url);
          return new HttpResponse(new Uint8Array([0xff, 0xd8, 0xff]), {
            headers: { "Content-Type": "image/jpeg" },
          });
        },
      ),
    );
    const token = zeroToken({ userId, orgId, runId });

    const client = setupApp({ context })(
      integrationsSlackUploadCompleteContract,
    );
    await accept(
      client.complete({
        body: { fileId, channel: "C123", title: "Demo video" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    await flushWaitUntilForTest();

    expect(frameRequests).toStrictEqual([
      `https://cdn.vm7.io/cdn-cgi/media/mode=frame,time=1s,width=640,format=jpg/${permalink}`,
    ]);
    expect(
      objectStore.puts.some((put) => {
        return (
          put.bucket === "test-user-artifacts" &&
          put.key.endsWith("/poster.jpg") &&
          put.contentType === "image/jpeg"
        );
      }),
    ).toBeTruthy();
    const artifacts = await chatApi.listArtifacts(actorFor({ orgId, userId }));
    const videoArtifact = artifacts.artifacts.find((artifact) => {
      return artifact.fileId === fileId;
    });
    expect(videoArtifact?.previewImageUrl).toMatch(/\/poster\.jpg$/);
  });

  it("does not record a run association for ordinary clerk session auth", async () => {
    const { orgId, userId, runId, threadId } = await seedRunScoped();
    const fileId = `F-${randomUUID().slice(0, 8)}`;
    mockSlackFileInfo(fileId);
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(
      integrationsSlackUploadCompleteContract,
    );
    const response = await accept(
      client.complete({
        body: { fileId, channel: "C123", title: "Session upload" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      fileId,
      permalink: `https://slack.example/files/${fileId}`,
    });

    const files = await visibleUploadedFiles({
      orgId,
      userId,
      runId,
      threadId,
    });
    expect(files).toStrictEqual([]);
  });

  it("is idempotent for repeated completion calls for the same run file", async () => {
    const { orgId, userId, runId, threadId } = await seedRunScoped();
    const fileId = `F-${randomUUID().slice(0, 8)}`;
    mockSlackFileInfo(fileId);
    const token = zeroToken({ userId, orgId, runId });

    const client = setupApp({ context })(
      integrationsSlackUploadCompleteContract,
    );
    const body = { fileId, channel: "C123", title: "Retry upload" };

    await accept(
      client.complete({ body, headers: { authorization: `Bearer ${token}` } }),
      [200],
    );
    await accept(
      client.complete({ body, headers: { authorization: `Bearer ${token}` } }),
      [200],
    );

    const files = await visibleUploadedFiles({
      orgId,
      userId,
      runId,
      threadId,
    });
    expect(files).toHaveLength(1);
  });
});
