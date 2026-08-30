import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";
import type { Capability } from "@okouai/api-contracts/contracts/capabilities";

import { testContext } from "../../../__tests__/test-context";
import { now } from "../../../lib/time";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { deleteAgentRunFixture } from "../../../test-fixtures/chat-events";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const runsApi = createRunsApi(context);

type ChatObjectStore = ReturnType<typeof chatCallbacks.acceptChatObjectStorage>;

interface RunUploadFixture {
  readonly actor: ApiTestUser & { readonly orgId: string };
  readonly runId: string;
  readonly bearer: string;
  readonly objectStore: ChatObjectStore;
}

function requireOrgId(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected upload completion actor to have an org");
  }
  return actor.orgId;
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function okouToken(args: {
  userId: string;
  orgId: string;
  runId: string;
  capabilities: readonly Capability[];
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "okou",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: args.capabilities,
    iat: seconds,
    exp: seconds + 60,
  });
}

function zeroBearer(
  capabilities: readonly Capability[] = ["file:write"],
): string {
  const actor = bdd.user();
  const orgId = requireOrgId(actor);
  mockClerkMembership(context, { ...actor, orgId }, "org:admin");
  return `Bearer ${okouToken({
    userId: actor.userId,
    orgId,
    runId: randomUUID(),
    capabilities,
  })}`;
}

async function createRunUploadFixture(
  options: { readonly chatThread?: boolean } = {},
): Promise<RunUploadFixture> {
  const actor = bdd.user();
  const orgId = requireOrgId(actor);
  const objectStore = chatCallbacks.acceptChatObjectStorage();
  runsApi.acceptStorageDownloads();
  runsApi.acceptTelemetryIngest();

  const runnerGroup = runsApi.configureRunnerGroup();
  await runsApi.grantProEntitlement(actor);
  await runsApi.ensureOrgModelProvider(actor);
  await runsApi.heartbeatRunner(runnerGroup);
  const agent = await bdd.createAgent(actor, {
    displayName: `BDD upload completion ${randomUUID().slice(0, 8)}`,
    visibility: "private",
  });

  let runId: string;
  if (options.chatThread) {
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "produce a thread-linked uploaded artifact",
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected chat send to create a thread-linked run");
    }
    runId = sent.body.runId;
  } else {
    const run = await runsApi.createRun(actor, {
      agentId: agent.agentId,
      prompt: "produce an uploaded artifact",
      modelProvider: "anthropic-api-key",
    });
    runId = run.runId;
  }
  const orgActor = { ...actor, orgId };
  mockClerkMembership(context, orgActor, "org:admin");

  return {
    actor: orgActor,
    runId,
    bearer: `Bearer ${okouToken({
      userId: actor.userId,
      orgId,
      runId,
      capabilities: ["file:write"],
    })}`,
    objectStore,
  };
}

function addUploadObject(
  fixture: Pick<RunUploadFixture, "actor" | "objectStore">,
  fileId: string,
  filename: string,
  size = 1234,
): void {
  fixture.objectStore.addObject({
    bucket: "test-user-artifacts",
    key: `artifacts/${fixture.actor.userId}/${fileId}/${filename}`,
    size,
  });
}

describe("POST /api/uploads/complete", () => {
  it("completes a run-scoped upload after the object exists", async () => {
    const fixture = await createRunUploadFixture();
    const fileId = randomUUID();
    addUploadObject(fixture, fileId, "report.pdf");

    const response = await chat.completeUploadWithBearer(
      fixture.bearer,
      { id: fileId },
      [200],
    );

    expect(response.body).toMatchObject({
      id: fileId,
      filename: "report.pdf",
      contentType: "application/pdf",
      size: 1234,
    });
  });

  it("keeps a completed upload successful when realtime invalidation fails", async () => {
    const fixture = await createRunUploadFixture({ chatThread: true });
    const fileId = randomUUID();
    addUploadObject(fixture, fileId, "realtime-independent.pdf");
    await flushWaitUntilForTest();
    context.mocks.ably.publish.mockClear();
    context.mocks.ably.publish.mockRejectedValue(
      new Error("realtime publication failed"),
    );

    const response = await chat.completeUploadWithBearer(
      fixture.bearer,
      { id: fileId },
      [200],
    );
    await flushWaitUntilForTest();

    expect(response.body).toMatchObject({
      id: fileId,
      filename: "realtime-independent.pdf",
      contentType: "application/pdf",
      size: 1234,
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      expect.stringMatching(/^chatThreadArtifactsChanged:/u),
      null,
    );
  });

  it("completes an ordinary session upload without a run artifact association", async () => {
    const actor = bdd.user();
    const objectStore = chatCallbacks.acceptChatObjectStorage();
    const fileId = randomUUID();
    addUploadObject(
      { actor: { ...actor, orgId: requireOrgId(actor) }, objectStore },
      fileId,
      "plain.txt",
      5,
    );

    const response = await chat.completeUpload(actor, { id: fileId });

    expect(response).toMatchObject({
      id: fileId,
      filename: "plain.txt",
      size: 5,
    });
  });

  it("keeps legacy v2 objects without brand metadata on the VM0 CDN", async () => {
    const fixture = await createRunUploadFixture();
    const prepared = await chat.prepareUpload(fixture.actor, {
      filename: "财务 报告.pdf",
      contentType: "application/pdf",
      size: 17,
    });
    const key = new URL(prepared.url).pathname.replace(/^\/+/u, "");
    fixture.objectStore.addObject({
      bucket: "test-user-artifacts",
      key,
      size: 17,
      contentType: "application/pdf",
      metadata: {
        "artifact-id": prepared.id,
        filename: encodeURIComponent("财务 报告.pdf"),
        "user-id": encodeURIComponent(fixture.actor.userId),
      },
    });
    const response = await chat.completeUploadWithBearer(
      fixture.bearer,
      { id: prepared.id },
      [200],
    );

    expect(response.body).toMatchObject({
      id: prepared.id,
      filename: "财务 报告.pdf",
      contentType: "application/pdf",
      size: 17,
      url: prepared.url,
    });
    if ("error" in response.body) {
      throw new Error("Expected the upload to complete successfully");
    }
    expect(response.body.url).toMatch(/^https:\/\/cdn\.vm7\.io\//u);
  });

  it("resolves the CDN from immutable object brand metadata", async () => {
    const fixture = await createRunUploadFixture();
    const prepared = await chat.prepareUpload(fixture.actor, {
      filename: "okou-report.pdf",
      contentType: "application/pdf",
      size: 17,
    });
    const key = new URL(prepared.url).pathname.replace(/^\/+/u, "");
    fixture.objectStore.addObject({
      bucket: "test-user-artifacts",
      key,
      size: 17,
      contentType: "application/pdf",
      metadata: {
        "artifact-id": prepared.id,
        filename: "okou-report.pdf",
        "public-brand": "okou",
        "user-id": encodeURIComponent(fixture.actor.userId),
      },
    });

    const response = await chat.completeUploadWithBearer(
      fixture.bearer,
      { id: prepared.id },
      [200],
    );

    expect(response.body).toMatchObject({
      id: prepared.id,
      filename: "okou-report.pdf",
      url: expect.stringMatching(/^https:\/\/cdn\.okou\.io\//u),
    });
  });

  it("rejects corrupt persisted artifact brand metadata", async () => {
    const fixture = await createRunUploadFixture();
    const prepared = await chat.prepareUpload(fixture.actor, {
      filename: "corrupt-brand.pdf",
      contentType: "application/pdf",
      size: 17,
    });
    const key = new URL(prepared.url).pathname.replace(/^\/+/u, "");
    fixture.objectStore.addObject({
      bucket: "test-user-artifacts",
      key,
      size: 17,
      contentType: "application/pdf",
      metadata: {
        "artifact-id": prepared.id,
        filename: "corrupt-brand.pdf",
        "public-brand": "unexpected",
        "user-id": encodeURIComponent(fixture.actor.userId),
      },
    });

    const response = await chat.completeUploadWithBearer(
      fixture.bearer,
      { id: prepared.id },
      [500],
    );

    expect(response.body).toStrictEqual({ error: "Internal server error" });
  });

  it("uses a recognized complete content type when provided", async () => {
    const fixture = await createRunUploadFixture();
    const fileId = randomUUID();
    addUploadObject(fixture, fileId, "data.bin", 9);

    const response = await chat.completeUploadWithBearer(
      fixture.bearer,
      { id: fileId, contentType: "text/csv" },
      [200],
    );

    expect(response.body).toMatchObject({
      id: fileId,
      filename: "data.bin",
      contentType: "text/csv",
    });
  });

  it("infers audio content type from uploaded filename", async () => {
    const fixture = await createRunUploadFixture();
    const fileId = randomUUID();
    addUploadObject(fixture, fileId, "clip.mp3", 2048);

    const response = await chat.completeUploadWithBearer(
      fixture.bearer,
      { id: fileId },
      [200],
    );

    expect(response.body).toMatchObject({
      id: fileId,
      filename: "clip.mp3",
      contentType: "audio/mpeg",
      size: 2048,
    });
  });

  it("is idempotent for repeated completion calls for the same run file", async () => {
    const fixture = await createRunUploadFixture();
    const fileId = randomUUID();
    addUploadObject(fixture, fileId, "retry.txt", 7);

    const first = await chat.completeUploadWithBearer(
      fixture.bearer,
      { id: fileId },
      [200],
    );
    const second = await chat.completeUploadWithBearer(
      fixture.bearer,
      { id: fileId },
      [200],
    );

    expect(second.body).toStrictEqual(first.body);
  });

  it("acknowledges a late upload after its run root was deleted", async () => {
    const fixture = await createRunUploadFixture();
    const fileId = randomUUID();
    addUploadObject(fixture, fileId, "late.txt", 11);
    await deleteAgentRunFixture({ runId: fixture.runId });

    const response = await chat.completeUploadWithBearer(
      fixture.bearer,
      { id: fileId },
      [200],
    );

    expect(response.body).toMatchObject({
      id: fileId,
      filename: "late.txt",
      size: 11,
    });
  });

  it("returns 404 when the uploaded object cannot be found", async () => {
    const fixture = await createRunUploadFixture();
    const fileId = randomUUID();

    const response = await chat.completeUploadWithBearer(
      fixture.bearer,
      { id: fileId },
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Uploaded file not found", code: "NOT_FOUND" },
    });
  });

  it("rejects suspended orgs before completing the upload", async () => {
    const actor = bdd.user();
    const completed = await bdd.completeOnboarding(actor);
    expect(completed.status).toBe(200);
    await seedOrgMetadata({
      orgId: requireOrgId(actor),
      tier: "pro-suspend",
      credits: 0,
    });

    const response = await chat.requestCompleteUpload(
      actor,
      { id: randomUUID() },
      [402],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const response = await chat.requestCompleteUpload(
      null,
      { id: randomUUID() },
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 403 for an agent token without file:write capability", async () => {
    const response = await chat.completeUploadWithBearer(
      zeroBearer(["file:read"]),
      { id: randomUUID() },
      [403],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.message).toContain("file:write");
  });

  it("returns 400 when the request body is invalid", async () => {
    const response = await chat.completeUploadWithBearer(
      zeroBearer(),
      { id: "not-a-uuid" },
      [400],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Invalid request body", code: "BAD_REQUEST" },
    });
  });

  it("falls back to a generic complete content type for unrecognized MIME values", async () => {
    const actor = bdd.user();
    const objectStore = chatCallbacks.acceptChatObjectStorage();
    const fileId = randomUUID();
    addUploadObject(
      { actor: { ...actor, orgId: requireOrgId(actor) }, objectStore },
      fileId,
      "capture.custom",
      10,
    );

    const response = await chat.completeUpload(actor, {
      id: fileId,
      contentType: "application/x-custom",
    });

    expect(response).toMatchObject({
      id: fileId,
      filename: "capture.custom",
      contentType: "application/octet-stream",
      size: 10,
    });
  });
});
