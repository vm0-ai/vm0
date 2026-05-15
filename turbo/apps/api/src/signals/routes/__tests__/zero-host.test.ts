import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { zeroHostContract } from "@vm0/api-contracts/contracts/zero-host";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { hostedDeployments, hostedSites } from "@vm0/db/schema/hosted-site";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

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
  await writeDb
    .delete(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, fixture.orgId),
        eq(userFeatureSwitches.userId, fixture.userId),
      ),
    );
});

async function seedHostedSitesEnabled(): Promise<HostedSiteFixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  const writeDb = store.set(writeDb$);
  await writeDb.insert(userFeatureSwitches).values({
    orgId,
    userId,
    switches: { [FeatureSwitchKey.HostedSites]: true },
  });
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

  it("returns 403 when hosted sites are disabled", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroHostContract);
    const response = await accept(
      client.prepare({
        headers: { authorization: "Bearer clerk-session" },
        body: { site: "demo-site", spaFallback: true, files: validFiles() },
      }),
      [403],
    );
    expect(response.body.error.message).toBe("Hosted sites are not enabled");
  });

  it("creates a deployment and returns per-file upload URLs", async () => {
    const fixture = await seedHostedSitesEnabled();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroHostContract);
    const response = await accept(
      client.prepare({
        headers: { authorization: "Bearer clerk-session" },
        body: { site: "demo-site", spaFallback: true, files: validFiles() },
      }),
      [200],
    );

    expect(response.body.publicSlug).toBe("demo-site");
    expect(response.body.url).toBe("https://demo-site.sites.example.com");
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

  it("rejects deployments missing index.html", async () => {
    const fixture = await seedHostedSitesEnabled();
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
    const fixture = await seedHostedSitesEnabled();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroHostContract);
    const prepared = await accept(
      client.prepare({
        headers: { authorization: "Bearer clerk-session" },
        body: { site: "demo-site", spaFallback: true, files: validFiles() },
      }),
      [200],
    );

    const prefix = `sites/demo-site/deployments/${prepared.body.deploymentId}`;
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
      url: "https://demo-site.sites.example.com",
    });
    expect(puts).toStrictEqual([
      `${prefix}/manifest.json`,
      "sites/demo-site/active.json",
    ]);

    const writeDb = store.set(writeDb$);
    const [site] = await writeDb
      .select()
      .from(hostedSites)
      .where(eq(hostedSites.id, prepared.body.siteId));
    expect(site?.activeDeploymentId).toBe(prepared.body.deploymentId);
  });
});
