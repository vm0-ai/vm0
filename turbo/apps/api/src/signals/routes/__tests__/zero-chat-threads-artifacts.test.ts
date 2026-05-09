import { randomUUID } from "node:crypto";

import { chatThreadArtifactsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUsageInsightFixture$,
  seedChatThread$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

interface RunUploadedFileSeed {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly externalId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly url: string;
}

async function seedRunUploadedFile(args: RunUploadedFileSeed): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(runUploadedFiles).values({
    runId: args.runId,
    source: "web",
    externalId: args.externalId,
    userId: args.userId,
    orgId: args.orgId,
    filename: args.filename,
    contentType: args.contentType,
    sizeBytes: args.sizeBytes,
    url: args.url,
  });
}

async function seedChatMessage(args: {
  readonly threadId: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly runId: string;
}): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(chatMessages).values({
    chatThreadId: args.threadId,
    role: args.role,
    content: args.content,
    runId: args.runId,
  });
}

describe("GET /api/zero/chat-threads/:threadId/artifacts", () => {
  const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
    return store.set(deleteUsageInsightFixture$, fixture, context.signal);
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(chatThreadArtifactsContract);
    const response = await accept(
      client.list({ params: { threadId: randomUUID() }, headers: {} }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns run uploaded files grouped by run", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const threadId = await store.set(
      seedChatThread$,
      { userId: fixture.userId, composeId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        status: "completed",
        chatThreadId: threadId,
      },
      context.signal,
    );
    await seedRunUploadedFile({
      runId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      externalId: "file-1",
      filename: "data.csv",
      contentType: "text/csv",
      sizeBytes: 2048,
      url: `http://localhost:3000/f/${fixture.userId}/file-1/data.csv`,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadArtifactsContract);
    const response = await accept(
      client.list({
        params: { threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.runs).toHaveLength(1);
    expect(response.body.runs[0]?.runId).toBe(runId);
    expect(response.body.runs[0]?.files).toHaveLength(1);
    expect(response.body.runs[0]?.files[0]).toMatchObject({
      id: "file-1",
      filename: "data.csv",
      contentType: "text/csv",
      size: 2048,
    });
    expect(response.body.runs[0]?.files[0]?.url).toContain("/f/");
  });

  it("uses chat message run ownership when zero run chat thread is missing", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const threadId = await store.set(
      seedChatThread$,
      { userId: fixture.userId, composeId },
      context.signal,
    );
    // Run is intentionally NOT linked to threadId on the zeroRuns row;
    // the chat message below provides the ownership link instead.
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        status: "completed",
      },
      context.signal,
    );
    await seedChatMessage({
      threadId,
      role: "user",
      content: "Uploaded during the run",
      runId,
    });
    await seedRunUploadedFile({
      runId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      externalId: "file-fallback",
      filename: "preview.html",
      contentType: "text/html",
      sizeBytes: 512,
      url: `http://localhost:3000/f/${fixture.userId}/file-fallback/preview.html`,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadArtifactsContract);
    const response = await accept(
      client.list({
        params: { threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.runs).toHaveLength(1);
    expect(response.body.runs[0]?.runId).toBe(runId);
    expect(response.body.runs[0]?.files[0]).toMatchObject({
      id: "file-fallback",
      filename: "preview.html",
      contentType: "text/html",
      size: 512,
    });
  });

  it("returns 404 when the thread is owned by a different user (no leak)", async () => {
    const otherUserId = `user_${randomUUID()}`;
    const otherFixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const callerFixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: otherFixture.orgId, userId: otherUserId },
      context.signal,
    );
    const otherThreadId = await store.set(
      seedChatThread$,
      { userId: otherUserId, composeId },
      context.signal,
    );
    mocks.clerk.session(callerFixture.userId, callerFixture.orgId);

    const client = setupApp({ context })(chatThreadArtifactsContract);
    const response = await accept(
      client.list({
        params: { threadId: otherThreadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body.error).toStrictEqual({
      message: "Chat thread not found",
      code: "NOT_FOUND",
    });
  });
});
