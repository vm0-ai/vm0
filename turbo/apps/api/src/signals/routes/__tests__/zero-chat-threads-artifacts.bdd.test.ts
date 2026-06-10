import { randomUUID } from "node:crypto";

import { chatThreadArtifactsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { connectors } from "@vm0/db/schema/connector";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import { secrets } from "@vm0/db/schema/secret";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";

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

// BDD migration of the legacy `zero-chat-threads-artifacts.test.ts`.
// The legacy direct DB SELECTs that verified the per-run file
// arrays are replaced by assertions on the public list contract's
// `runs` array. The "dedup by URL", "hosted-site filter",
// "presentation-html filter", and "fallback to chat message
// run ownership" cases are all variations of "owner sees correct
// run with correct files" and chain naturally in GWT-WT-WT walks.
// The 9 legacy `it()`s collapse into 4 BDD `it()`s (auth boundary
// + 3 read chains covering the main happy paths + 1 Drive chain
// covering Drive sync states).

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
    ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
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

const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
  return store.set(deleteUsageInsightFixture$, fixture, context.signal);
});

// Connectors + secrets are NOT cascaded by deleteUsageInsightFixture$;
// tests that seed Drive credentials track their orgId here for explicit
// cleanup so subsequent runs start clean.
const trackDriveOrg = createFixtureTracker<string>(async (orgId) => {
  const writeDb = store.set(writeDb$);
  await writeDb.delete(connectors).where(eq(connectors.orgId, orgId));
  await writeDb.delete(secrets).where(eq(secrets.orgId, orgId));
});

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function listClient() {
  return setupApp({ context })(chatThreadArtifactsContract);
}

describe("BDD GET /api/zero/chat-threads/:threadId/artifacts — auth boundary", () => {
  it("returns 401 when not authenticated", async () => {
    // When + Then: no auth header → 401.
    const response = await accept(
      listClient().list({ params: { threadId: randomUUID() }, headers: {} }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("BDD GET /api/zero/chat-threads/:threadId/artifacts — artifacts read chain", () => {
  it("gwt-wt-wt: 404 cross-user (no leak) → 200 single file with disconnected Drive sync → 200 dedup by URL keeps newer file → 200 website run only returns hosted-site → 200 presentation run only returns presentation-html → 200 chat-message run ownership fallback", async () => {
    const c = listClient();

    // Given: another user's thread, with the caller on a different org.
    const otherUserId = `user_${randomUUID()}`;
    const otherFixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const callerFixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId: otherComposeId } = await store.set(
      seedCompose$,
      { orgId: otherFixture.orgId, userId: otherUserId },
      context.signal,
    );
    const otherThreadId = await store.set(
      seedChatThread$,
      { userId: otherUserId, composeId: otherComposeId },
      context.signal,
    );
    mocks.clerk.session(callerFixture.userId, callerFixture.orgId);

    // When + Then: 404 for a cross-user thread (no existence leak).
    const crossUser = await accept(
      c.list({
        params: { threadId: otherThreadId },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(crossUser.body.error).toStrictEqual({
      message: "Chat thread not found",
      code: "NOT_FOUND",
    });

    // Given: a fresh user/org with one thread + one completed run
    // and a single uploaded file.
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

    // When + Then: the list reports the run with the file and
    // `googleDriveSync: { status: "disconnected" }`.
    const single = await accept(
      c.list({ params: { threadId }, headers: authHeaders() }),
      [200],
    );
    expect(single.body.runs).toHaveLength(1);
    expect(single.body.runs[0]?.runId).toBe(runId);
    expect(single.body.runs[0]?.files).toHaveLength(1);
    expect(single.body.runs[0]?.files[0]).toMatchObject({
      id: "file-1",
      filename: "data.csv",
      contentType: "text/csv",
      size: 2048,
    });
    expect(single.body.runs[0]?.files[0]?.url).toContain("/f/");
    expect(single.body.runs[0]?.files[0]?.googleDriveSync).toStrictEqual({
      status: "disconnected",
    });

    // Given: two files sharing the same URL (the older one should
    // be deduped away).
    const dedupFixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId: dedupCompose } = await store.set(
      seedCompose$,
      { orgId: dedupFixture.orgId, userId: dedupFixture.userId },
      context.signal,
    );
    const dedupThread = await store.set(
      seedChatThread$,
      { userId: dedupFixture.userId, composeId: dedupCompose },
      context.signal,
    );
    const { runId: dedupRun } = await store.set(
      seedRun$,
      {
        orgId: dedupFixture.orgId,
        userId: dedupFixture.userId,
        composeId: dedupCompose,
        status: "completed",
        chatThreadId: dedupThread,
      },
      context.signal,
    );
    const url = "https://demo-site.sites.example.com";
    await seedRunUploadedFile({
      runId: dedupRun,
      userId: dedupFixture.userId,
      orgId: dedupFixture.orgId,
      externalId: "old-artifact",
      filename: "old-site.html",
      contentType: "text/html",
      sizeBytes: 512,
      url,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await seedRunUploadedFile({
      runId: dedupRun,
      userId: dedupFixture.userId,
      orgId: dedupFixture.orgId,
      externalId: "new-artifact",
      filename: "new-site.html",
      contentType: "text/html",
      sizeBytes: 640,
      url,
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });
    mocks.clerk.session(dedupFixture.userId, dedupFixture.orgId);

    // When + Then: dedup keeps the newer file.
    const deduped = await accept(
      c.list({ params: { threadId: dedupThread }, headers: authHeaders() }),
      [200],
    );
    expect(deduped.body.runs).toHaveLength(1);
    expect(deduped.body.runs[0]?.files).toHaveLength(1);
    expect(deduped.body.runs[0]?.files[0]).toMatchObject({
      id: "new-artifact",
      filename: "new-site.html",
      size: 640,
      url,
    });

    // Given: a run with both a website zip and a hosted-site file.
    const websiteFixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId: websiteCompose } = await store.set(
      seedCompose$,
      { orgId: websiteFixture.orgId, userId: websiteFixture.userId },
      context.signal,
    );
    const websiteThread = await store.set(
      seedChatThread$,
      { userId: websiteFixture.userId, composeId: websiteCompose },
      context.signal,
    );
    const { runId: websiteRun } = await store.set(
      seedRun$,
      {
        orgId: websiteFixture.orgId,
        userId: websiteFixture.userId,
        composeId: websiteCompose,
        status: "completed",
        chatThreadId: websiteThread,
      },
      context.signal,
    );
    await seedRunUploadedFile({
      runId: websiteRun,
      userId: websiteFixture.userId,
      orgId: websiteFixture.orgId,
      externalId: "website-zip",
      filename: "website.zip",
      contentType: "application/zip",
      sizeBytes: 2048,
      url: `http://localhost:3000/f/${websiteFixture.userId}/website-zip/website.zip`,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const siteUrl = "https://demo-site.sites.example.com";
    await seedRunUploadedFile({
      runId: websiteRun,
      userId: websiteFixture.userId,
      orgId: websiteFixture.orgId,
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
    mocks.clerk.session(websiteFixture.userId, websiteFixture.orgId);

    // When + Then: only the hosted-site file is returned.
    const website = await accept(
      c.list({
        params: { threadId: websiteThread },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(website.body.runs).toHaveLength(1);
    expect(website.body.runs[0]?.files).toStrictEqual([
      expect.objectContaining({
        id: siteUrl,
        filename: "demo-site.html",
        contentType: "text/html",
        size: 640,
        url: siteUrl,
        artifactKind: "hosted-site",
      }),
    ]);

    // Given: a run with both a presentation zip and a
    // presentation-html file.
    const presentationFixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId: presentationCompose } = await store.set(
      seedCompose$,
      { orgId: presentationFixture.orgId, userId: presentationFixture.userId },
      context.signal,
    );
    const presentationThread = await store.set(
      seedChatThread$,
      { userId: presentationFixture.userId, composeId: presentationCompose },
      context.signal,
    );
    const { runId: presentationRun } = await store.set(
      seedRun$,
      {
        orgId: presentationFixture.orgId,
        userId: presentationFixture.userId,
        composeId: presentationCompose,
        status: "completed",
        chatThreadId: presentationThread,
      },
      context.signal,
    );
    await seedRunUploadedFile({
      runId: presentationRun,
      userId: presentationFixture.userId,
      orgId: presentationFixture.orgId,
      externalId: "presentation-bundle",
      filename: "presentation.zip",
      contentType: "application/zip",
      sizeBytes: 4096,
      url: `http://localhost:3000/f/${presentationFixture.userId}/presentation-bundle/presentation.zip`,
      metadata: { artifactKind: ["presentation-html"] },
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const presentationUrl = "https://demo-deck.sites.example.com";
    await seedRunUploadedFile({
      runId: presentationRun,
      userId: presentationFixture.userId,
      orgId: presentationFixture.orgId,
      externalId: presentationUrl,
      filename: "demo-deck.html",
      contentType: "text/html",
      sizeBytes: 768,
      url: presentationUrl,
      metadata: {
        generatedBy: "zero-official-presentation",
        artifactKind: "presentation-html",
      },
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });
    mocks.clerk.session(presentationFixture.userId, presentationFixture.orgId);

    // When + Then: only the presentation-html file is returned.
    const presentation = await accept(
      c.list({
        params: { threadId: presentationThread },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(presentation.body.runs).toHaveLength(1);
    expect(presentation.body.runs[0]?.files).toStrictEqual([
      expect.objectContaining({
        id: presentationUrl,
        filename: "demo-deck.html",
        contentType: "text/html",
        size: 768,
        url: presentationUrl,
        artifactKind: "presentation-html",
      }),
    ]);

    // Given: a thread with a run NOT linked on zeroRuns.chatThreadId
    // (only linked via a chat message runId).
    const fallbackFixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId: fallbackCompose } = await store.set(
      seedCompose$,
      { orgId: fallbackFixture.orgId, userId: fallbackFixture.userId },
      context.signal,
    );
    const fallbackThread = await store.set(
      seedChatThread$,
      { userId: fallbackFixture.userId, composeId: fallbackCompose },
      context.signal,
    );
    const { runId: fallbackRun } = await store.set(
      seedRun$,
      {
        orgId: fallbackFixture.orgId,
        userId: fallbackFixture.userId,
        composeId: fallbackCompose,
        status: "completed",
      },
      context.signal,
    );
    await seedChatMessage({
      threadId: fallbackThread,
      role: "user",
      content: "Uploaded during the run",
      runId: fallbackRun,
    });
    await seedRunUploadedFile({
      runId: fallbackRun,
      userId: fallbackFixture.userId,
      orgId: fallbackFixture.orgId,
      externalId: "file-fallback",
      filename: "preview.html",
      contentType: "text/html",
      sizeBytes: 512,
      url: `http://localhost:3000/f/${fallbackFixture.userId}/file-fallback/preview.html`,
    });
    mocks.clerk.session(fallbackFixture.userId, fallbackFixture.orgId);

    // When + Then: the run is still surfaced (via chat message
    // ownership).
    const fallback = await accept(
      c.list({
        params: { threadId: fallbackThread },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(fallback.body.runs).toHaveLength(1);
    expect(fallback.body.runs[0]?.runId).toBe(fallbackRun);
    expect(fallback.body.runs[0]?.files[0]).toMatchObject({
      id: "file-fallback",
      filename: "preview.html",
      contentType: "text/html",
      size: 512,
    });
    expect(fallback.body.runs[0]?.files[0]?.googleDriveSync).toStrictEqual({
      status: "disconnected",
    });
  });
});

describe("BDD GET /api/zero/chat-threads/:threadId/artifacts — Drive sync chain", () => {
  it("gwt-wt-wt: 200 Drive synced (auth header + vm0Artifact query) → 200 Drive unknown (401 on files + 401 on refresh)", async () => {
    const c = listClient();

    // Given: a thread with a single uploaded file and a Google
    // Drive connector seeded; the Drive API mock returns the file
    // with vm0 appProperties.
    const driveFixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId: driveCompose } = await store.set(
      seedCompose$,
      { orgId: driveFixture.orgId, userId: driveFixture.userId },
      context.signal,
    );
    const driveThread = await store.set(
      seedChatThread$,
      { userId: driveFixture.userId, composeId: driveCompose },
      context.signal,
    );
    const { runId: driveRun } = await store.set(
      seedRun$,
      {
        orgId: driveFixture.orgId,
        userId: driveFixture.userId,
        composeId: driveCompose,
        status: "completed",
        chatThreadId: driveThread,
      },
      context.signal,
    );
    await seedRunUploadedFile({
      runId: driveRun,
      userId: driveFixture.userId,
      orgId: driveFixture.orgId,
      externalId: "file-1",
      filename: "data.csv",
      contentType: "text/csv",
      sizeBytes: 2048,
      url: `http://localhost:3000/f/${driveFixture.userId}/file-1/data.csv`,
    });
    await seedGoogleDriveConnector({
      orgId: driveFixture.orgId,
      userId: driveFixture.userId,
      accessToken: "drive-access-token",
    });
    trackDriveOrg(Promise.resolve(driveFixture.orgId));

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
                vm0ThreadId: driveThread,
                vm0RunId: driveRun,
                vm0FileId: "file-1",
              },
            },
          ],
        });
      }),
    );
    mocks.clerk.session(driveFixture.userId, driveFixture.orgId);

    // When + Then: the list reports `googleDriveSync: { status:
    // "synced", ... }` and the upstream call used the right
    // bearer token and query.
    const synced = await accept(
      c.list({ params: { threadId: driveThread }, headers: authHeaders() }),
      [200],
    );
    expect(observedAuth).toBe("Bearer drive-access-token");
    expect(observedQuery).toContain("vm0Artifact");
    expect(observedQuery).toContain(`value='${driveThread}'`);
    expect(synced.body.runs[0]?.files[0]?.googleDriveSync).toStrictEqual({
      status: "synced",
      id: "drive-file-id",
      name: "data.csv",
      webViewLink: "https://drive.google.com/file/d/drive-file-id/view",
    });

    // Given: a different thread where Drive returns 401 (stale
    // token) and the refresh-token POST also returns 401.
    const unknownFixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId: unknownCompose } = await store.set(
      seedCompose$,
      { orgId: unknownFixture.orgId, userId: unknownFixture.userId },
      context.signal,
    );
    const unknownThread = await store.set(
      seedChatThread$,
      { userId: unknownFixture.userId, composeId: unknownCompose },
      context.signal,
    );
    const { runId: unknownRun } = await store.set(
      seedRun$,
      {
        orgId: unknownFixture.orgId,
        userId: unknownFixture.userId,
        composeId: unknownCompose,
        status: "completed",
        chatThreadId: unknownThread,
      },
      context.signal,
    );
    await seedRunUploadedFile({
      runId: unknownRun,
      userId: unknownFixture.userId,
      orgId: unknownFixture.orgId,
      externalId: "file-1",
      filename: "data.csv",
      contentType: "text/csv",
      sizeBytes: 2048,
      url: `http://localhost:3000/f/${unknownFixture.userId}/file-1/data.csv`,
    });
    await seedGoogleDriveConnector({
      orgId: unknownFixture.orgId,
      userId: unknownFixture.userId,
      accessToken: "stale-token",
      refreshToken: "refresh-token",
    });
    trackDriveOrg(Promise.resolve(unknownFixture.orgId));
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
    mocks.clerk.session(unknownFixture.userId, unknownFixture.orgId);

    // When + Then: the list reports `googleDriveSync: { status:
    // "unknown" }` — the route swallowed both 401s.
    const unknown = await accept(
      c.list({ params: { threadId: unknownThread }, headers: authHeaders() }),
      [200],
    );
    expect(unknown.body.runs[0]?.files[0]?.googleDriveSync).toStrictEqual({
      status: "unknown",
    });
  });
});
