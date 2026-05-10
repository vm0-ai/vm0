import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { chatThreadArtifactsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { connectors } from "@vm0/db/schema/connector";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import { secrets } from "@vm0/db/schema/secret";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
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

async function seedRunUploadedFile(args: {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly externalId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly url: string;
  readonly metadata: Record<string, unknown>;
}): Promise<void> {
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
    metadata: args.metadata,
  });
}

async function seedGoogleDriveConnector(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly accessToken: string;
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
}

interface S3GetCommandLike {
  readonly input: { readonly Bucket?: string; readonly Key?: string };
}

function isS3GetCommandLike(command: unknown): command is S3GetCommandLike {
  return (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof (command as { input: unknown }).input === "object"
  );
}

function stubS3Buffer(buffer: Buffer): void {
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (!isS3GetCommandLike(command)) {
      return Promise.resolve({});
    }
    const stream = Readable.from([new Uint8Array(buffer)]);
    return Promise.resolve({ Body: stream });
  });
}

describe("POST /api/zero/chat-threads/:threadId/artifacts", () => {
  const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
    return store.set(deleteUsageInsightFixture$, fixture, context.signal);
  });

  // Connectors and secrets aren't cascaded by the usage-insight fixture
  // tracker; tests that seed Drive credentials track their orgId here for
  // explicit cleanup so subsequent runs start clean.
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

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(chatThreadArtifactsContract);
    const response = await accept(
      client.syncGoogleDrive({
        params: { threadId: randomUUID() },
        body: { runId: randomUUID(), fileId: "file-1" },
        headers: {},
      }),
      [401],
    );
    expect(response.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("returns 401 when authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const client = setupApp({ context })(chatThreadArtifactsContract);
    const response = await accept(
      client.syncGoogleDrive({
        params: { threadId: randomUUID() },
        body: { runId: randomUUID(), fileId: "file-1" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(response.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("returns 400 with NOT_FOUND-equivalent when no Google Drive connector is configured", async () => {
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
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadArtifactsContract);
    const response = await accept(
      client.syncGoogleDrive({
        params: { threadId },
        body: {
          runId: "00000000-0000-4000-8000-000000000001",
          fileId: "file-1",
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(response.body).toStrictEqual({
      error: {
        message: "Connect Google Drive before syncing artifacts",
        code: "BAD_REQUEST",
      },
    });
  });

  it("returns 404 when the artifact is unknown to the caller's thread", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    await seedGoogleDriveConnector({
      orgId: fixture.orgId,
      userId: fixture.userId,
      accessToken: "drive-access-token",
    });
    seededDriveOrgs.push(fixture.orgId);

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
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadArtifactsContract);
    const response = await accept(
      client.syncGoogleDrive({
        params: { threadId },
        body: { runId: randomUUID(), fileId: "missing-file" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Artifact file not found", code: "NOT_FOUND" },
    });
  });

  it("returns 400 when the request body is invalid", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadArtifactsContract);
    const response = await accept(
      client.syncGoogleDrive({
        params: { threadId: randomUUID() },
        // Missing fileId.
        body: { runId: randomUUID() } as never,
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(response.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("syncs an artifact file to Google Drive (full MSW assertion)", async () => {
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
    const s3Key = `uploads/${fixture.userId}/file-1/data.csv`;
    await seedRunUploadedFile({
      runId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      externalId: "file-1",
      filename: "data.csv",
      contentType: "text/csv",
      sizeBytes: 2048,
      url: `http://localhost:3000/f/${fixture.userId}/file-1/data.csv`,
      metadata: { s3Key },
    });
    await seedGoogleDriveConnector({
      orgId: fixture.orgId,
      userId: fixture.userId,
      accessToken: "drive-access-token",
    });
    seededDriveOrgs.push(fixture.orgId);

    stubS3Buffer(Buffer.from("name,value\nalpha,1\n"));

    let authHeader: string | null = null;
    let contentType: string | null = null;
    let uploadType: string | null = null;
    let uploadBody = "";
    const folderQueries: string[] = [];
    const createdFolders: unknown[] = [];
    server.use(
      http.get("https://www.googleapis.com/drive/v3/files", ({ request }) => {
        const url = new URL(request.url);
        folderQueries.push(url.searchParams.get("q") ?? "");
        return HttpResponse.json({ files: [] });
      }),
      http.post(
        "https://www.googleapis.com/drive/v3/files",
        async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          createdFolders.push(body);
          return HttpResponse.json({
            id:
              createdFolders.length === 1
                ? "drive-folder-vm0-artifact"
                : "drive-folder-chat-thread",
            name: typeof body.name === "string" ? body.name : "folder",
          });
        },
      ),
      http.post(
        "https://www.googleapis.com/upload/drive/v3/files",
        async ({ request }) => {
          const url = new URL(request.url);
          authHeader = request.headers.get("authorization");
          contentType = request.headers.get("content-type");
          uploadType = url.searchParams.get("uploadType");
          uploadBody = await request.text();
          return HttpResponse.json({
            id: "drive-file-id",
            name: "data.csv",
            webViewLink: "https://drive.google.com/file/d/drive-file-id/view",
          });
        },
      ),
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadArtifactsContract);
    const response = await accept(
      client.syncGoogleDrive({
        params: { threadId },
        body: { runId, fileId: "file-1" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body).toStrictEqual({
      id: "drive-file-id",
      name: "data.csv",
      webViewLink: "https://drive.google.com/file/d/drive-file-id/view",
    });
    expect(authHeader).toBe("Bearer drive-access-token");
    expect(contentType).toContain("multipart/related");
    expect(uploadType).toBe("multipart");
    expect(folderQueries).toHaveLength(2);
    expect(folderQueries[0]).toContain("name = 'vm0-artifact'");
    expect(folderQueries[0]).toContain("'root' in parents");
    expect(folderQueries[1]).toContain(`name = 'chat-${threadId}'`);
    expect(folderQueries[1]).toContain(
      "'drive-folder-vm0-artifact' in parents",
    );
    expect(createdFolders).toStrictEqual([
      {
        name: "vm0-artifact",
        mimeType: "application/vnd.google-apps.folder",
      },
      {
        name: `chat-${threadId}`,
        mimeType: "application/vnd.google-apps.folder",
        parents: ["drive-folder-vm0-artifact"],
      },
    ]);
    expect(uploadBody).toContain('"name":"data.csv"');
    expect(uploadBody).toContain('"parents":["drive-folder-chat-thread"]');
    expect(uploadBody).toContain('"vm0Artifact":"true"');
    expect(uploadBody).toContain(`"vm0ThreadId":"${threadId}"`);
    expect(uploadBody).toContain(`"vm0RunId":"${runId}"`);
    expect(uploadBody).toContain('"vm0FileId":"file-1"');
    expect(uploadBody).toContain("Content-Type: text/csv\r\n\r\nname,value");
  });
});
