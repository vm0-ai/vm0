import { randomUUID } from "node:crypto";

import { chatThreadArtifactsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { connectors } from "@vm0/db/schema/connector";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import { secrets } from "@vm0/db/schema/secret";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterEach } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import { encryptSecretForTests } from "./helpers/encrypt-secret";
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
  readonly metadata?: Record<string, unknown>;
  readonly createdAt?: Date;
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
    metadata: args.metadata ?? {},
    ...(args.createdAt ? { createdAt: args.createdAt } : {}),
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

async function seedGoogleDriveConnector(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
}): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(connectors).values({
    orgId: args.orgId,
    userId: args.userId,
    type: "google-drive",
    authMethod: "oauth",
    needsReconnect: false,
  });
  await writeDb.insert(secrets).values({
    orgId: args.orgId,
    userId: args.userId,
    name: "GOOGLE_DRIVE_ACCESS_TOKEN",
    type: "connector",
    encryptedValue: encryptSecretForTests(args.accessToken),
  });
  if (args.refreshToken) {
    await writeDb.insert(secrets).values({
      orgId: args.orgId,
      userId: args.userId,
      name: "GOOGLE_DRIVE_REFRESH_TOKEN",
      type: "connector",
      encryptedValue: encryptSecretForTests(args.refreshToken),
    });
  }
}

describe("GET /api/zero/chat-threads/:threadId/artifacts", () => {
  const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
    return store.set(deleteUsageInsightFixture$, fixture, context.signal);
  });

  // connectors + secrets are NOT cascaded by deleteUsageInsightFixture$;
  // tests that seed Drive credentials track their orgId here for explicit
  // cleanup so subsequent runs start clean.
  const seededDriveOrgs: string[] = [];
  afterEach(async () => {
    while (seededDriveOrgs.length > 0) {
      const orgId = seededDriveOrgs.pop();
      if (!orgId) {
        continue;
      }
      const writeDb = store.set(writeDb$);
      await writeDb.delete(connectors).where(eq(connectors.orgId, orgId));
      await writeDb.delete(secrets).where(eq(secrets.orgId, orgId));
    }
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
    expect(response.body.runs[0]?.files[0]?.googleDriveSync).toStrictEqual({
      status: "disconnected",
    });
  });

  it("deduplicates artifacts by URL", async () => {
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
    const url = "https://demo-site.sites.example.com";
    await seedRunUploadedFile({
      runId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      externalId: "old-artifact",
      filename: "old-site.html",
      contentType: "text/html",
      sizeBytes: 512,
      url,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await seedRunUploadedFile({
      runId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      externalId: "new-artifact",
      filename: "new-site.html",
      contentType: "text/html",
      sizeBytes: 640,
      url,
      createdAt: new Date("2026-01-02T00:00:00Z"),
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
    expect(response.body.runs[0]?.files).toHaveLength(1);
    expect(response.body.runs[0]?.files[0]).toMatchObject({
      id: "new-artifact",
      filename: "new-site.html",
      size: 640,
      url,
    });
  });

  it("only returns hosted site artifacts for website runs", async () => {
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
      externalId: "website-zip",
      filename: "website.zip",
      contentType: "application/zip",
      sizeBytes: 2048,
      url: `http://localhost:3000/f/${fixture.userId}/website-zip/website.zip`,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const siteUrl = "https://demo-site.sites.example.com";
    await seedRunUploadedFile({
      runId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      externalId: siteUrl,
      filename: "demo-site.html",
      contentType: "text/html",
      sizeBytes: 640,
      url: siteUrl,
      metadata: {
        generatedBy: "zero-official-website",
        artifactKind: "hosted-site",
      },
      createdAt: new Date("2026-01-02T00:00:00Z"),
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
    expect(response.body.runs[0]?.files).toStrictEqual([
      expect.objectContaining({
        id: siteUrl,
        filename: "demo-site.html",
        contentType: "text/html",
        size: 640,
        url: siteUrl,
      }),
    ]);
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
    expect(response.body.runs[0]?.files[0]?.googleDriveSync).toStrictEqual({
      status: "disconnected",
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

  it("returns googleDriveSync status synced when the artifact is mirrored to Drive", async () => {
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
    await seedGoogleDriveConnector({
      orgId: fixture.orgId,
      userId: fixture.userId,
      accessToken: "drive-access-token",
    });
    seededDriveOrgs.push(fixture.orgId);

    let observedAuth: string | null = null;
    let observedQuery = "";
    server.use(
      http.get("https://www.googleapis.com/drive/v3/files", ({ request }) => {
        const url = new URL(request.url);
        observedAuth = request.headers.get("authorization");
        observedQuery = url.searchParams.get("q") ?? "";
        return HttpResponse.json({
          files: [
            {
              id: "drive-file-id",
              name: "data.csv",
              webViewLink: "https://drive.google.com/file/d/drive-file-id/view",
              appProperties: {
                vm0Artifact: "true",
                vm0ThreadId: threadId,
                vm0RunId: runId,
                vm0FileId: "file-1",
              },
            },
          ],
        });
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadArtifactsContract);
    const response = await accept(
      client.list({
        params: { threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(observedAuth).toBe("Bearer drive-access-token");
    expect(observedQuery).toContain("vm0Artifact");
    expect(observedQuery).toContain(`value='${threadId}'`);
    expect(response.body.runs[0]?.files[0]?.googleDriveSync).toStrictEqual({
      status: "synced",
      id: "drive-file-id",
      name: "data.csv",
      webViewLink: "https://drive.google.com/file/d/drive-file-id/view",
    });
  });

  it("returns googleDriveSync status unknown when Drive rejects the access token and refresh fails", async () => {
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
    await seedGoogleDriveConnector({
      orgId: fixture.orgId,
      userId: fixture.userId,
      accessToken: "stale-token",
      refreshToken: "refresh-token",
    });
    seededDriveOrgs.push(fixture.orgId);

    // Mock OAuth client credentials so the refresh attempt actually runs;
    // without them refreshDriveAccessToken short-circuits to null without
    // exercising the upstream POST.
    mockEnv("GOOGLE_OAUTH_CLIENT_ID", "test-client-id");
    mockEnv("GOOGLE_OAUTH_CLIENT_SECRET", "test-client-secret");

    server.use(
      http.get("https://www.googleapis.com/drive/v3/files", () => {
        return new HttpResponse(null, { status: 401 });
      }),
      http.post("https://oauth2.googleapis.com/token", () => {
        return new HttpResponse(null, { status: 401 });
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadArtifactsContract);
    const response = await accept(
      client.list({
        params: { threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.runs[0]?.files[0]?.googleDriveSync).toStrictEqual({
      status: "unknown",
    });
  });
});
