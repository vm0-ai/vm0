import { createHash, randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { zeroHostContract } from "@vm0/api-contracts/contracts/zero-host";
import { hostedDeployments, hostedSites } from "@vm0/db/schema/hosted-site";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
} from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

interface HostedSiteFixture {
  readonly orgId: string;
  readonly userId: string;
}

const track = createFixtureTracker<HostedSiteFixture>(async (fixture) => {
  const writeDb = store.set(writeDb$);
  await writeDb
    .delete(hostedDeployments)
    .where(eq(hostedDeployments.orgId, fixture.orgId));
  await writeDb.delete(hostedSites).where(eq(hostedSites.orgId, fixture.orgId));
  await store.set(deleteUsageInsightFixture$, fixture, context.signal);
});

async function setOrgTier(
  orgId: string,
  tier: "free" | "pro-suspend",
): Promise<void> {
  await store
    .set(writeDb$)
    .insert(orgMetadata)
    .values({ orgId, tier, credits: 10_000 })
    .onConflictDoUpdate({
      target: orgMetadata.orgId,
      set: { tier, credits: 10_000 },
    });
}

async function seedHostedSiteFixture(
  tier: "free" | "pro-suspend" = "free",
): Promise<HostedSiteFixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  await setOrgTier(orgId, tier);
  return track(Promise.resolve({ orgId, userId }));
}

function validFiles() {
  return [
    {
      path: "/index.html",
      size: 120,
      sha256: "a".repeat(64),
      contentType: "text/html; charset=utf-8",
    },
    {
      path: "/assets/index-a1b2c3d4.js",
      size: 420,
      sha256: "b".repeat(64),
      contentType: "application/javascript; charset=utf-8",
      immutable: true,
    },
  ];
}

function fileForContent(path: string, content: string) {
  const bytes = Buffer.from(content, "utf8");
  return {
    path,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentType: "text/html; charset=utf-8",
  };
}

function mockUploadedKeys(keys: readonly string[]) {
  const puts: string[] = [];
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const commandName =
      typeof command === "object" && command !== null
        ? command.constructor.name
        : "";
    const input =
      typeof command === "object" && command !== null && "input" in command
        ? (command.input as { Key?: string })
        : {};
    const key = input.Key ?? "";
    if (commandName === "HeadObjectCommand") {
      if (keys.includes(key)) {
        return Promise.resolve({});
      }
      const error = new Error("Not found") as Error & {
        $metadata: { httpStatusCode: number };
      };
      error.name = "NotFound";
      error.$metadata = { httpStatusCode: 404 };
      return Promise.reject(error);
    }
    if (commandName === "PutObjectCommand") {
      puts.push(key);
      return Promise.resolve({});
    }
    return Promise.resolve({});
  });
  return puts;
}

describe("POST /api/zero/host/deployments/prepare", () => {
  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(zeroHostContract);
    const response = await accept(
      client.prepare({
        headers: {},
        body: { site: "demo-site", spaFallback: true, files: validFiles() },
      }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("creates a deployment and returns per-file upload URLs", async () => {
    const fixture = await seedHostedSiteFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroHostContract);
    const response = await accept(
      client.prepare({
        headers: { authorization: "Bearer clerk-session" },
        body: { site: "demo-site", spaFallback: true, files: validFiles() },
      }),
      [200],
    );

    expect(response.body.publicSlug).toMatch(
      /^demo-site-[a-f0-9]{8}-[a-f0-9]{8}$/,
    );
    expect(response.body.url).toMatch(
      /^https:\/\/demo-site-[a-f0-9]{8}-[a-f0-9]{8}\.sites\.example\.com$/,
    );
    expect(response.body.uploads).toHaveLength(2);
    expect(
      response.body.uploads.map((upload) => {
        return upload.path;
      }),
    ).toStrictEqual(["/index.html", "/assets/index-a1b2c3d4.js"]);
    expect(context.mocks.s3.clientConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: {
          accessKeyId: "test-hosted-sites-access-key",
          secretAccessKey: "test-hosted-sites-secret-key",
        },
      }),
    );

    const writeDb = store.set(writeDb$);
    const [deployment] = await writeDb
      .select()
      .from(hostedDeployments)
      .where(eq(hostedDeployments.id, response.body.deploymentId));
    expect(deployment).toMatchObject({
      orgId: fixture.orgId,
      status: "uploading",
      fileCount: 2,
      sizeBytes: 540,
      spaFallback: true,
    });
  });

  it("generates a unique public slug by default for the same site slug", async () => {
    const fixture = await seedHostedSiteFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroHostContract);
    const first = await accept(
      client.prepare({
        headers: { authorization: "Bearer clerk-session" },
        body: { site: "demo-site", spaFallback: true, files: validFiles() },
      }),
      [200],
    );
    const second = await accept(
      client.prepare({
        headers: { authorization: "Bearer clerk-session" },
        body: { site: "demo-site", spaFallback: true, files: validFiles() },
      }),
      [200],
    );

    expect(first.body.publicSlug).toMatch(
      /^demo-site-[a-f0-9]{8}-[a-f0-9]{8}$/,
    );
    expect(second.body.publicSlug).toMatch(
      /^demo-site-[a-f0-9]{8}-[a-f0-9]{8}$/,
    );
    expect(second.body.publicSlug).not.toBe(first.body.publicSlug);
    expect(second.body.url).not.toBe(first.body.url);
    expect(second.body.siteId).toBe(first.body.siteId);

    const [site] = await store
      .set(writeDb$)
      .select()
      .from(hostedSites)
      .where(eq(hostedSites.id, first.body.siteId));
    expect(site).toMatchObject({
      orgId: fixture.orgId,
      slug: "demo-site",
      publicSlug: second.body.publicSlug,
    });
  });

  it("reuses the public slug when a slug suffix is provided", async () => {
    const fixture = await seedHostedSiteFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroHostContract);
    const first = await accept(
      client.prepare({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          site: "demo-site",
          slugSuffix: "release-01",
          spaFallback: true,
          files: validFiles(),
        },
      }),
      [200],
    );
    const second = await accept(
      client.prepare({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          site: "demo-site",
          slugSuffix: "release-01",
          spaFallback: true,
          files: validFiles(),
        },
      }),
      [200],
    );

    expect(first.body.publicSlug).toMatch(/^demo-site-[a-f0-9]{8}-release-01$/);
    expect(second.body.publicSlug).toBe(first.body.publicSlug);
    expect(second.body.url).toBe(first.body.url);
    expect(second.body.siteId).toBe(first.body.siteId);
  });

  it("rejects slug suffixes that would exceed the stored public slug length", async () => {
    const fixture = await seedHostedSiteFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroHostContract);
    const response = await accept(
      client.prepare({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          site: "a".repeat(63),
          slugSuffix: "b".repeat(32),
          spaFallback: true,
          files: validFiles(),
        },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(response.body.error.message).toContain("96");
  });

  it("rejects suspended orgs with insufficient credits", async () => {
    const fixture = await seedHostedSiteFixture("pro-suspend");
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroHostContract);
    const response = await accept(
      client.prepare({
        headers: { authorization: "Bearer clerk-session" },
        body: { site: "demo-site", spaFallback: true, files: validFiles() },
      }),
      [402],
    );

    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("rejects deployments missing index.html", async () => {
    const fixture = await seedHostedSiteFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroHostContract);
    const response = await accept(
      client.prepare({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          site: "demo-site",
          spaFallback: true,
          files: [validFiles()[1]!],
        },
      }),
      [400],
    );
    expect(response.body.error.message).toContain("index.html");
  });
});

describe("POST /api/zero/host/deployments/:deploymentId/complete", () => {
  it("marks a deployment ready and writes manifest plus active pointer", async () => {
    const fixture = await seedHostedSiteFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroHostContract);
    const prepared = await accept(
      client.prepare({
        headers: { authorization: "Bearer clerk-session" },
        body: { site: "demo-site", spaFallback: true, files: validFiles() },
      }),
      [200],
    );

    const prefix = `sites/${prepared.body.publicSlug}/deployments/${prepared.body.deploymentId}`;
    const puts = mockUploadedKeys([
      `${prefix}/index.html`,
      `${prefix}/assets/index-a1b2c3d4.js`,
    ]);

    const completed = await accept(
      client.complete({
        params: { deploymentId: prepared.body.deploymentId },
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [200],
    );

    expect(completed.body).toMatchObject({
      deploymentId: prepared.body.deploymentId,
      status: "ready",
    });
    expect(completed.body.url).toMatch(
      /^https:\/\/demo-site-[a-f0-9]{8}-[a-f0-9]{8}\.sites\.example\.com$/,
    );
    expect(puts).toStrictEqual([
      `${prefix}/manifest.json`,
      `sites/${prepared.body.publicSlug}/active.json`,
    ]);

    const writeDb = store.set(writeDb$);
    const [site] = await writeDb
      .select()
      .from(hostedSites)
      .where(eq(hostedSites.id, prepared.body.siteId));
    expect(site?.activeDeploymentId).toBe(prepared.body.deploymentId);
  });

  it("rejects suspended orgs before completing a deployment", async () => {
    const fixture = await seedHostedSiteFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroHostContract);
    const prepared = await accept(
      client.prepare({
        headers: { authorization: "Bearer clerk-session" },
        body: { site: "demo-site", spaFallback: true, files: validFiles() },
      }),
      [200],
    );

    await setOrgTier(fixture.orgId, "pro-suspend");
    const completed = await accept(
      client.complete({
        params: { deploymentId: prepared.body.deploymentId },
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [402],
    );

    expect(completed.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("records a run artifact that points at the hosted site URL", async () => {
    const fixture = await seedHostedSiteFixture();
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        triggerSource: "cli",
        status: "completed",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroHostContract);
    const prepared = await accept(
      client.prepare({
        headers: { authorization: "Bearer clerk-session" },
        body: { site: "demo-site", spaFallback: true, files: validFiles() },
      }),
      [200],
    );

    await store
      .set(writeDb$)
      .update(hostedDeployments)
      .set({
        runId,
        manifest: sql`${hostedDeployments.manifest} - 'artifactKind'`,
      })
      .where(eq(hostedDeployments.id, prepared.body.deploymentId));

    const prefix = `sites/${prepared.body.publicSlug}/deployments/${prepared.body.deploymentId}`;
    mockUploadedKeys([
      `${prefix}/index.html`,
      `${prefix}/assets/index-a1b2c3d4.js`,
    ]);

    const completed = await accept(
      client.complete({
        params: { deploymentId: prepared.body.deploymentId },
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [200],
    );

    await accept(
      client.complete({
        params: { deploymentId: prepared.body.deploymentId },
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [200],
    );

    const artifactRows = await store
      .set(writeDb$)
      .select()
      .from(runUploadedFiles)
      .where(eq(runUploadedFiles.runId, runId));
    expect(artifactRows).toHaveLength(1);
    expect(artifactRows[0]).toMatchObject({
      runId,
      source: "cli",
      externalId: completed.body.url,
      userId: fixture.userId,
      orgId: fixture.orgId,
      filename: `${prepared.body.publicSlug}.html`,
      contentType: "text/html",
      sizeBytes: 540,
      url: completed.body.url,
      metadata: {
        generatedBy: "zero-official-website",
        artifactKind: "hosted-site",
        siteId: prepared.body.siteId,
        deploymentId: prepared.body.deploymentId,
        publicSlug: prepared.body.publicSlug,
        fileCount: 2,
        entrypoint: "/index.html",
        spaFallback: true,
      },
    });
  });

  it("records presentation html artifact metadata when requested", async () => {
    const fixture = await seedHostedSiteFixture();
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        triggerSource: "cli",
        status: "completed",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroHostContract);
    const prepared = await accept(
      client.prepare({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          site: "deck-site",
          slugSuffix: "release-01",
          artifactKind: "presentation-html",
          spaFallback: false,
          files: validFiles(),
        },
      }),
      [200],
    );

    await store
      .set(writeDb$)
      .update(hostedDeployments)
      .set({ runId })
      .where(eq(hostedDeployments.id, prepared.body.deploymentId));

    const prefix = `sites/${prepared.body.publicSlug}/deployments/${prepared.body.deploymentId}`;
    mockUploadedKeys([
      `${prefix}/index.html`,
      `${prefix}/assets/index-a1b2c3d4.js`,
    ]);

    const completed = await accept(
      client.complete({
        params: { deploymentId: prepared.body.deploymentId },
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [200],
    );

    const [deployment] = await store
      .set(writeDb$)
      .select()
      .from(hostedDeployments)
      .where(eq(hostedDeployments.id, prepared.body.deploymentId));
    expect(deployment?.manifest).toMatchObject({
      artifactKind: "presentation-html",
    });

    const artifactRows = await store
      .set(writeDb$)
      .select()
      .from(runUploadedFiles)
      .where(eq(runUploadedFiles.runId, runId));
    expect(artifactRows).toHaveLength(1);
    expect(artifactRows[0]?.metadata).toMatchObject({
      generatedBy: "zero-official-website",
      artifactKind: "presentation-html",
      publicSlug: prepared.body.publicSlug,
      deploymentId: prepared.body.deploymentId,
      entrypoint: "/index.html",
      spaFallback: false,
    });
    expect(artifactRows[0]).toMatchObject({
      externalId: completed.body.url,
      filename: `${prepared.body.publicSlug}.html`,
      contentType: "text/html",
      url: completed.body.url,
    });
  });
});

describe("POST /api/zero/host/presentation-html/redeploy", () => {
  it("redeploys presentation HTML to the same hosted site URL", async () => {
    const fixture = await seedHostedSiteFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroHostContract);
    const prepared = await accept(
      client.prepare({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          site: "deck-site",
          slugSuffix: "release-01",
          artifactKind: "presentation-html",
          spaFallback: true,
          files: [
            fileForContent("/index.html", "original"),
            fileForContent("/assets/cat style.css", "body { color: black; }"),
          ],
        },
      }),
      [200],
    );

    mockUploadedKeys([
      `sites/${prepared.body.publicSlug}/deployments/${prepared.body.deploymentId}/index.html`,
      `sites/${prepared.body.publicSlug}/deployments/${prepared.body.deploymentId}/assets/cat style.css`,
    ]);
    await accept(
      client.complete({
        headers: { authorization: "Bearer clerk-session" },
        params: { deploymentId: prepared.body.deploymentId },
        body: {},
      }),
      [200],
    );

    const copied: string[] = [];
    const copiedSources: string[] = [];
    const puts: string[] = [];
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const commandName =
        typeof command === "object" && command !== null
          ? command.constructor.name
          : "";
      const input =
        typeof command === "object" && command !== null && "input" in command
          ? (command.input as { CopySource?: string; Key?: string })
          : {};
      if (commandName === "HeadObjectCommand") {
        return Promise.resolve({});
      }
      if (commandName === "CopyObjectCommand" && input.Key) {
        copied.push(input.Key);
      }
      if (commandName === "CopyObjectCommand" && input.CopySource) {
        copiedSources.push(input.CopySource);
      }
      if (commandName === "PutObjectCommand" && input.Key) {
        puts.push(input.Key);
      }
      return Promise.resolve({});
    });

    const redeployed = await accept(
      client.redeployPresentationHtml({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          url: prepared.body.url,
          html: "<!doctype html><html><body>edited</body></html>",
        },
      }),
      [200],
    );

    expect(redeployed.body.url).toBe(prepared.body.url);
    expect(redeployed.body.deploymentId).not.toBe(prepared.body.deploymentId);

    const prefix = `sites/${prepared.body.publicSlug}/deployments/${redeployed.body.deploymentId}`;
    expect(copied).toStrictEqual([`${prefix}/assets/cat style.css`]);
    expect(copiedSources).toStrictEqual([
      `test-hosted-sites/sites/${prepared.body.publicSlug}/deployments/${prepared.body.deploymentId}/assets/cat%20style.css`,
    ]);
    expect(puts).toStrictEqual([
      `${prefix}/index.html`,
      `${prefix}/manifest.json`,
      `sites/${prepared.body.publicSlug}/active.json`,
    ]);

    const [site] = await store
      .set(writeDb$)
      .select()
      .from(hostedSites)
      .where(eq(hostedSites.id, prepared.body.siteId));
    expect(site?.activeDeploymentId).toBe(redeployed.body.deploymentId);

    const [deployment] = await store
      .set(writeDb$)
      .select()
      .from(hostedDeployments)
      .where(eq(hostedDeployments.id, redeployed.body.deploymentId));
    expect(deployment?.spaFallback).toBeTruthy();
    expect(deployment?.manifest.spaFallback).toBeTruthy();
  });

  it("rejects redeploying a non-presentation hosted site", async () => {
    const fixture = await seedHostedSiteFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroHostContract);
    const prepared = await accept(
      client.prepare({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          site: "plain-site",
          slugSuffix: "release-01",
          artifactKind: "hosted-site",
          spaFallback: false,
          files: [fileForContent("/index.html", "original")],
        },
      }),
      [200],
    );

    mockUploadedKeys([
      `sites/${prepared.body.publicSlug}/deployments/${prepared.body.deploymentId}/index.html`,
    ]);
    await accept(
      client.complete({
        headers: { authorization: "Bearer clerk-session" },
        params: { deploymentId: prepared.body.deploymentId },
        body: {},
      }),
      [200],
    );

    const redeployed = await accept(
      client.redeployPresentationHtml({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          url: prepared.body.url,
          html: "<!doctype html><html><body>edited</body></html>",
        },
      }),
      [400],
    );

    expect(redeployed.body.error.message).toBe(
      "Hosted site is not a presentation HTML artifact",
    );
  });
});
