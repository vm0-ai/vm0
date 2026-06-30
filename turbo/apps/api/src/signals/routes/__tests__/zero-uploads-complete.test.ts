import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";

import { testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsAutomationsApi } from "./helpers/api-bdd-runs-automations";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const runsApi = createRunsAutomationsApi(context);

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

function zeroToken(args: {
  userId: string;
  orgId: string;
  runId: string;
  capabilities: readonly ZeroCapability[];
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: args.capabilities,
    iat: seconds,
    exp: seconds + 60,
  });
}

function zeroBearer(
  capabilities: readonly ZeroCapability[] = ["file:write"],
): string {
  const actor = bdd.user();
  const orgId = requireOrgId(actor);
  mockClerkMembership(context, { ...actor, orgId }, "org:admin");
  return `Bearer ${zeroToken({
    userId: actor.userId,
    orgId,
    runId: randomUUID(),
    capabilities,
  })}`;
}

async function createRunUploadFixture(): Promise<RunUploadFixture> {
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

  const run = await runsApi.createRun(actor, {
    agentId: agent.agentId,
    prompt: "produce an uploaded artifact",
    modelProvider: "anthropic-api-key",
  });
  const orgActor = { ...actor, orgId };
  mockClerkMembership(context, orgActor, "org:admin");

  return {
    actor: orgActor,
    runId: run.runId,
    bearer: `Bearer ${zeroToken({
      userId: actor.userId,
      orgId,
      runId: run.runId,
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

describe("POST /api/zero/uploads/complete", () => {
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

  it("uses the validated complete content type when provided", async () => {
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
    await bdd.setupOnboarding(actor, {
      displayName: "BDD suspended upload completion",
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

  it("returns 403 for a zero token without file:write capability", async () => {
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

  it("returns 400 for unsupported content types", async () => {
    const response = await chat.completeUploadWithBearer(
      zeroBearer(),
      {
        id: randomUUID(),
        contentType: "application/x-msdownload",
      },
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Unsupported file type: application/x-msdownload",
        code: "BAD_REQUEST",
      },
    });
  });
});
