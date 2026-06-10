import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import AdmZip from "adm-zip";
import { chatThreadArtifactsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { connectors } from "@vm0/db/schema/connector";
import { hostedDeployments, hostedSites } from "@vm0/db/schema/hosted-site";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import { secrets } from "@vm0/db/schema/secret";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

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
const HOSTED_BUCKET = "test-hosted-sites";

interface HostedArtifactFixtureFile {
  readonly body: Buffer;
  readonly contentType: string;
  readonly path: string;
}

interface HostedArtifactFixture {
  readonly objects: ReadonlyMap<string, Buffer>;
  readonly url: string;
}

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

async function seedHostedArtifact(args: {
  readonly files: readonly HostedArtifactFixtureFile[];
  readonly orgId: string;
  readonly publicSlug: string;
  readonly runId: string;
  readonly userId: string;
}): Promise<HostedArtifactFixture> {
  const deploymentId = randomUUID();
  const url = `https://${args.publicSlug}.sites.example.com`;
  const prefix = `sites/${args.publicSlug}/deployments/${deploymentId}`;
  const sizeBytes = args.files.reduce((sum, file) => {
    return sum + file.body.length;
  }, 0);
  const writeDb = store.set(writeDb$);
  const [site] = await writeDb
    .insert(hostedSites)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      slug: args.publicSlug,
      publicSlug: args.publicSlug,
      activeDeploymentId: deploymentId,
    })
    .returning({ id: hostedSites.id });
  if (!site) {
    throw new Error("Failed to seed hosted site");
  }

  await writeDb.insert(hostedDeployments).values({
    id: deploymentId,
    siteId: site.id,
    orgId: args.orgId,
    userId: args.userId,
    runId: args.runId,
    status: "ready",
    r2Prefix: prefix,
    manifest: {
      version: 1,
      deploymentId,
      siteId: site.id,
      publicSlug: args.publicSlug,
      createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      artifactKind: "hosted-site",
      spaFallback: false,
      files: Object.fromEntries(
        args.files.map((file) => {
          return [
            file.path,
            {
              path: file.path,
              size: file.body.length,
              sha256: "a".repeat(64),
              contentType: file.contentType,
            },
          ];
        }),
      ),
    },
    manifestHash: "b".repeat(64),
    contentHash: "c".repeat(64),
    entrypoint: "/index.html",
    spaFallback: false,
    fileCount: args.files.length,
    sizeBytes,
    url,
    readyAt: new Date("2026-01-01T00:00:00.000Z"),
  });

  await writeDb.insert(runUploadedFiles).values({
    runId: args.runId,
    source: "web",
    externalId: url,
    userId: args.userId,
    orgId: args.orgId,
    filename: `${args.publicSlug}.html`,
    contentType: "text/html",
    sizeBytes,
    url,
    metadata: {
      generatedBy: "zero-official-website",
      artifactKind: "hosted-site",
      siteId: site.id,
      deploymentId,
      publicSlug: args.publicSlug,
      fileCount: args.files.length,
      entrypoint: "/index.html",
      spaFallback: false,
    },
  });

  return {
    objects: new Map(
      args.files.map((file) => {
        return [`${prefix}${file.path}`, file.body];
      }),
    ),
    url,
  };
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

function s3CommandName(command: unknown): string {
  if (typeof command !== "object" || command === null) {
    return "";
  }
  return command.constructor.name;
}

function stubS3Buffer(
  buffer: Buffer,
  observe?: (command: S3GetCommandLike) => void,
): void {
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (!isS3GetCommandLike(command)) {
      return Promise.resolve({});
    }
    observe?.(command);
    const stream = Readable.from([new Uint8Array(buffer)]);
    return Promise.resolve({ Body: stream });
  });
}

function stubS3BuffersByKey(
  objects: ReadonlyMap<string, Buffer>,
  observe?: (command: S3GetCommandLike) => void,
): void {
  mockEnv("R2_HOSTED_SITES_BUCKET_NAME", HOSTED_BUCKET);
  mockEnv("R2_HOSTED_SITES_ACCESS_KEY_ID", "test-hosted-access-key");
  mockEnv("R2_HOSTED_SITES_SECRET_ACCESS_KEY", "test-hosted-secret-key");
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (!isS3GetCommandLike(command)) {
      return Promise.resolve({});
    }
    observe?.(command);
    const key = command.input.Key;
    const buffer = key ? objects.get(key) : undefined;
    if (!buffer) {
      return Promise.reject(new Error(`Missing S3 fixture for ${key ?? ""}`));
    }
    const stream = Readable.from([new Uint8Array(buffer)]);
    return Promise.resolve({ Body: stream });
  });
}

function multipartBoundary(contentType: string | null): string {
  const boundary = contentType?.match(/boundary=([^;]+)/)?.[1];
  if (!boundary) {
    throw new Error("Google Drive upload did not include a multipart boundary");
  }
  return boundary;
}

function extractMultipartFile(
  body: Buffer,
  contentType: string | null,
  fileContentType: string,
): Buffer {
  const boundary = multipartBoundary(contentType);
  const fileHeader = Buffer.from(
    `Content-Type: ${fileContentType}\r\n\r\n`,
    "utf8",
  );
  const start = body.indexOf(fileHeader);
  if (start === -1) {
    throw new Error(`Multipart file part ${fileContentType} was not found`);
  }
  const fileStart = start + fileHeader.length;
  const fileEnd = body.indexOf(
    Buffer.from(`\r\n--${boundary}`, "utf8"),
    fileStart,
  );
  if (fileEnd === -1) {
    throw new Error("Multipart file part terminator was not found");
  }
  return body.subarray(fileStart, fileEnd);
}

describe("POST /api/zero/chat-threads/:threadId/artifacts", () => {
  const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
    return store.set(deleteUsageInsightFixture$, fixture, context.signal);
  });

  // Connectors and secrets aren't cascaded by the usage-insight fixture
  // tracker; tests that seed Drive credentials track their orgId here for
  // explicit cleanup so subsequent runs start clean.
  const seededDriveOrgs: string[] = [];
  const seededHostedOrgs: string[] = [];
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
    while (seededHostedOrgs.length > 0) {
      const orgId = seededHostedOrgs.pop();
      if (!orgId) {
        continue;
      }
      const writeDb = store.set(writeDb$);
      await writeDb
        .delete(hostedDeployments)
        .where(eq(hostedDeployments.orgId, orgId));
      await writeDb.delete(hostedSites).where(eq(hostedSites.orgId, orgId));
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

  it("syncs hosted-site artifacts to Google Drive as a zip", async () => {
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
    const publicSlug = `drive-site-${randomUUID().slice(0, 8)}`;
    const indexHtml = "<!doctype html><h1>Site</h1>";
    const appJs = "console.log('ready');";
    const styleCss = "body { color: red; }";
    const hosted = await seedHostedArtifact({
      files: [
        {
          path: "/index.html",
          body: Buffer.from(indexHtml),
          contentType: "text/html; charset=utf-8",
        },
        {
          path: "/assets/app.js",
          body: Buffer.from(appJs),
          contentType: "text/javascript",
        },
        {
          path: "/styles/main.css",
          body: Buffer.from(styleCss),
          contentType: "text/css",
        },
      ],
      orgId: fixture.orgId,
      publicSlug,
      runId,
      userId: fixture.userId,
    });
    seededHostedOrgs.push(fixture.orgId);
    await seedGoogleDriveConnector({
      orgId: fixture.orgId,
      userId: fixture.userId,
      accessToken: "drive-access-token",
    });
    seededDriveOrgs.push(fixture.orgId);

    const s3Keys: string[] = [];
    stubS3BuffersByKey(hosted.objects, (command) => {
      if (s3CommandName(command) === "GetObjectCommand" && command.input.Key) {
        s3Keys.push(command.input.Key);
      }
    });

    let uploadContentType: string | null = null;
    let uploadBody = Buffer.alloc(0);
    server.use(
      http.get("https://www.googleapis.com/drive/v3/files", () => {
        return HttpResponse.json({
          files: [{ id: "drive-folder-id", name: "folder" }],
        });
      }),
      http.post(
        "https://www.googleapis.com/upload/drive/v3/files",
        async ({ request }) => {
          uploadContentType = request.headers.get("content-type");
          uploadBody = Buffer.from(await request.arrayBuffer());
          return HttpResponse.json({
            id: "drive-file-id",
            name: `${publicSlug}.zip`,
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
        body: { runId, fileId: hosted.url },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      id: "drive-file-id",
      name: `${publicSlug}.zip`,
      webViewLink: "https://drive.google.com/file/d/drive-file-id/view",
    });
    expect(s3Keys.sort()).toStrictEqual(
      Array.from(hosted.objects.keys()).sort(),
    );
    const uploadText = uploadBody.toString("utf8");
    expect(uploadText).toContain(`"name":"${publicSlug}.zip"`);
    expect(uploadText).toContain('"mimeType":"application/zip"');
    expect(uploadText).toContain(`"vm0FileId":"${hosted.url}"`);

    const zip = new AdmZip(
      extractMultipartFile(uploadBody, uploadContentType, "application/zip"),
    );
    const entryNames = zip.getEntries().map((entry) => {
      return entry.entryName;
    });
    expect(entryNames).toStrictEqual([
      "assets/app.js",
      "index.html",
      "styles/main.css",
    ]);
    expect(zip.readAsText("index.html")).toBe(indexHtml);
    expect(zip.readAsText("assets/app.js")).toBe(appJs);
    expect(zip.readAsText("styles/main.css")).toBe(styleCss);
  });

  it("syncs current artifact-bucket files to Google Drive", async () => {
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
    const s3Key = `artifacts/${encodeURIComponent(
      fixture.userId,
    )}/file-1/data.csv`;
    await seedRunUploadedFile({
      runId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      externalId: "file-1",
      filename: "data.csv",
      contentType: "text/csv",
      sizeBytes: 2048,
      url: `https://cdn.vm7.io/${s3Key}`,
      metadata: { s3Key },
    });
    await seedGoogleDriveConnector({
      orgId: fixture.orgId,
      userId: fixture.userId,
      accessToken: "drive-access-token",
    });
    seededDriveOrgs.push(fixture.orgId);

    let s3GetInput: S3GetCommandLike["input"] | null = null;
    stubS3Buffer(Buffer.from("name,value\nalpha,1\n"), (command) => {
      s3GetInput = command.input;
    });

    server.use(
      http.get("https://www.googleapis.com/drive/v3/files", () => {
        return HttpResponse.json({
          files: [{ id: "drive-folder-id", name: "folder" }],
        });
      }),
      http.post("https://www.googleapis.com/upload/drive/v3/files", () => {
        return HttpResponse.json({
          id: "drive-file-id",
          name: "data.csv",
          webViewLink: "https://drive.google.com/file/d/drive-file-id/view",
        });
      }),
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
    expect(s3GetInput).toMatchObject({
      Bucket: "test-user-artifacts",
      Key: s3Key,
    });
  });

  it("syncs artifact-bucket files resolved from persisted CDN URLs", async () => {
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
    const s3Key = `artifacts/${encodeURIComponent(
      fixture.userId,
    )}/file-1/data.csv`;
    const fileUrl = `https://cdn.vm7.io/${s3Key}`;
    await seedRunUploadedFile({
      runId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      externalId: "file-1",
      filename: "data.csv",
      contentType: "text/csv",
      sizeBytes: 2048,
      url: fileUrl,
      metadata: { sourceUrl: fileUrl },
    });
    await seedGoogleDriveConnector({
      orgId: fixture.orgId,
      userId: fixture.userId,
      accessToken: "drive-access-token",
    });
    seededDriveOrgs.push(fixture.orgId);

    let s3GetInput: S3GetCommandLike["input"] | null = null;
    stubS3Buffer(Buffer.from("name,value\nalpha,1\n"), (command) => {
      if (s3CommandName(command) === "GetObjectCommand") {
        s3GetInput = command.input;
      }
    });

    server.use(
      http.get("https://www.googleapis.com/drive/v3/files", () => {
        return HttpResponse.json({
          files: [{ id: "drive-folder-id", name: "folder" }],
        });
      }),
      http.post("https://www.googleapis.com/upload/drive/v3/files", () => {
        return HttpResponse.json({
          id: "drive-file-id",
          name: "data.csv",
          webViewLink: "https://drive.google.com/file/d/drive-file-id/view",
        });
      }),
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
    expect(s3GetInput).toMatchObject({
      Bucket: "test-user-artifacts",
      Key: s3Key,
    });
  });

  it("falls back to legacy storage-bucket files when migrated artifacts are absent", async () => {
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
      metadata: {},
    });
    await seedGoogleDriveConnector({
      orgId: fixture.orgId,
      userId: fixture.userId,
      accessToken: "drive-access-token",
    });
    seededDriveOrgs.push(fixture.orgId);

    let s3GetInput: S3GetCommandLike["input"] | null = null;
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (!isS3GetCommandLike(command)) {
        return Promise.resolve({});
      }
      if (s3CommandName(command) === "HeadObjectCommand") {
        return Promise.reject(
          Object.assign(new Error("NotFound"), {
            name: "NotFound",
            $metadata: { httpStatusCode: 404 },
          }),
        );
      }
      if (s3CommandName(command) === "GetObjectCommand") {
        s3GetInput = command.input;
        const stream = Readable.from([
          new Uint8Array(Buffer.from("name,value\nalpha,1\n")),
        ]);
        return Promise.resolve({ Body: stream });
      }
      return Promise.resolve({});
    });

    server.use(
      http.get("https://www.googleapis.com/drive/v3/files", () => {
        return HttpResponse.json({
          files: [{ id: "drive-folder-id", name: "folder" }],
        });
      }),
      http.post("https://www.googleapis.com/upload/drive/v3/files", () => {
        return HttpResponse.json({
          id: "drive-file-id",
          name: "data.csv",
          webViewLink: "https://drive.google.com/file/d/drive-file-id/view",
        });
      }),
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
    expect(s3GetInput).toMatchObject({
      Bucket: "test-user-storages",
      Key: `uploads/${fixture.userId}/file-1/data.csv`,
    });
  });
});
