import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";
import AdmZip from "adm-zip";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import type { HostedArtifactKind } from "@vm0/api-contracts/contracts/zero-host";
import { hostedDeployments, hostedSites } from "@vm0/db/schema/hosted-site";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import { eq } from "drizzle-orm";

import { createApp } from "../../../app-factory";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { testContext } from "../../../__tests__/test-helpers";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import { createFixtureTracker } from "./helpers/zero-route-test";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();
const trackOrgMembership = createFixtureTracker<OrgMembershipFixture>(
  (fixture) => {
    return store.set(deleteOrgMembership$, fixture, context.signal);
  },
);
const trackDataFixture = createFixtureTracker<UsageInsightFixture>(
  (fixture) => {
    return store.set(deleteUsageInsightFixture$, fixture, context.signal);
  },
);
const trackHostedSiteFixture = createFixtureTracker<{ readonly orgId: string }>(
  async (fixture) => {
    const writeDb = store.set(writeDb$);
    await writeDb
      .delete(hostedDeployments)
      .where(eq(hostedDeployments.orgId, fixture.orgId));
    await writeDb
      .delete(hostedSites)
      .where(eq(hostedSites.orgId, fixture.orgId));
  },
);
const BUCKET = "test-user-artifacts";
const HOSTED_BUCKET = "test-hosted-sites";
const ROUTE = "/api/zero/web/download-file";

interface S3FixtureObject {
  readonly bucket?: string;
  readonly key: string;
  readonly size: number;
  readonly body: Buffer;
}

interface HostedArtifactFixtureFile {
  readonly path: string;
  readonly body: Buffer;
  readonly contentType: string;
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function mintZeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly capabilities: readonly ZeroCapability[];
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: `run_${randomUUID()}`,
    capabilities: args.capabilities,
    iat: seconds,
    exp: seconds + 3600,
  });
}

async function mintFileReadToken(): Promise<{
  readonly orgId: string;
  readonly token: string;
  readonly userId: string;
}> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  await trackOrgMembership(
    store.set(
      seedOrgMembership$,
      { orgId, userId, seedOrgCache: false },
      context.signal,
    ),
  );
  return {
    orgId,
    userId,
    token: mintZeroToken({
      userId,
      orgId,
      capabilities: ["file:read"],
    }),
  };
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

function bodyStream(buffer: Buffer): AsyncIterable<Uint8Array> {
  return (async function* stream(): AsyncIterable<Uint8Array> {
    yield buffer;
  })();
}

function mockS3Objects(objects: readonly S3FixtureObject[]): void {
  mockEnv("R2_USER_ARTIFACTS_BUCKET_NAME", BUCKET);
  mockEnv("R2_HOSTED_SITES_BUCKET_NAME", HOSTED_BUCKET);
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const input = commandInput(command);
    const bucket = typeof input.Bucket === "string" ? input.Bucket : "";
    const prefix = typeof input.Prefix === "string" ? input.Prefix : undefined;
    const key = typeof input.Key === "string" ? input.Key : undefined;

    if (prefix !== undefined) {
      return Promise.resolve({
        Contents: objects
          .filter((object) => {
            return (
              object.key.startsWith(prefix) &&
              bucket === (object.bucket ?? BUCKET)
            );
          })
          .map((object) => {
            return {
              Key: object.key,
              Size: object.size,
              LastModified: new Date("2025-01-01T00:00:00.000Z"),
            };
          }),
      });
    }

    if (key !== undefined) {
      const object = objects.find((candidate) => {
        return candidate.key === key && bucket === (candidate.bucket ?? BUCKET);
      });
      return Promise.resolve({
        Body: object ? bodyStream(object.body) : bodyStream(Buffer.alloc(0)),
      });
    }

    return Promise.resolve({});
  });
}

function requestDownload(args: {
  readonly fileId?: string;
  readonly token?: string;
}): Promise<Response> {
  const search =
    args.fileId === undefined
      ? ""
      : `?file_id=${encodeURIComponent(args.fileId)}`;
  const headers: Record<string, string> = args.token
    ? { authorization: `Bearer ${args.token}` }
    : {};
  const app = createApp({ signal: context.signal });
  return Promise.resolve(
    app.request(`${ROUTE}${search}`, { method: "GET", headers }),
  );
}

function artifactKey(userId: string, fileId: string, filename: string): string {
  return `artifacts/${userId}/${fileId}/${filename}`;
}

async function seedHostedArtifact(args: {
  readonly artifactKind: HostedArtifactKind;
  readonly files: readonly HostedArtifactFixtureFile[];
  readonly orgId: string;
  readonly publicSlug: string;
  readonly runId: string;
  readonly userId: string;
}): Promise<{
  readonly filename: string;
  readonly objects: readonly S3FixtureObject[];
  readonly url: string;
}> {
  await trackHostedSiteFixture(Promise.resolve({ orgId: args.orgId }));
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
      artifactKind: args.artifactKind,
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

  const filename = `${args.publicSlug}.html`;
  await writeDb.insert(runUploadedFiles).values({
    runId: args.runId,
    source: "web",
    externalId: url,
    userId: args.userId,
    orgId: args.orgId,
    filename,
    contentType: "text/html",
    sizeBytes,
    url,
    metadata: {
      generatedBy: "zero-official-website",
      artifactKind: args.artifactKind,
      siteId: site.id,
      deploymentId,
      publicSlug: args.publicSlug,
      fileCount: args.files.length,
      entrypoint: "/index.html",
      spaFallback: false,
    },
  });

  return {
    filename,
    objects: args.files.map((file) => {
      return {
        bucket: HOSTED_BUCKET,
        key: `${prefix}${file.path}`,
        size: file.body.length,
        body: file.body,
      };
    }),
    url,
  };
}

async function seedRunForUser(args: {
  readonly orgId: string;
  readonly userId: string;
}): Promise<string> {
  await trackDataFixture(
    Promise.resolve({ orgId: args.orgId, userId: args.userId }),
  );
  const { composeId } = await store.set(
    seedCompose$,
    { orgId: args.orgId, userId: args.userId },
    context.signal,
  );
  const { runId } = await store.set(
    seedRun$,
    {
      orgId: args.orgId,
      userId: args.userId,
      composeId,
      status: "completed",
      triggerSource: "web",
    },
    context.signal,
  );
  return runId;
}

async function expectErrorResponse(
  response: Response,
  status: number,
  code: string,
): Promise<void> {
  expect(response.status).toBe(status);
  const body = (await response.json()) as {
    readonly error?: { readonly code?: string };
  };
  expect(body.error?.code).toBe(code);
}

describe("GET /api/zero/web/download-file", () => {
  it("returns 401 when no auth token is provided", async () => {
    const response = await requestDownload({ fileId: "abc" });

    await expectErrorResponse(response, 401, "UNAUTHORIZED");
  });

  it("returns 403 for a zero token without file:read capability", async () => {
    const token = mintZeroToken({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      capabilities: ["agent:read"],
    });

    const response = await requestDownload({ fileId: "abc", token });

    await expectErrorResponse(response, 403, "FORBIDDEN");
  });

  it("returns 400 when file_id query param is missing", async () => {
    const { token } = await mintFileReadToken();

    const response = await requestDownload({ token });

    await expectErrorResponse(response, 400, "BAD_REQUEST");
  });

  it("returns 400 when file_id query param is empty", async () => {
    const { token } = await mintFileReadToken();

    const response = await requestDownload({ fileId: "", token });

    await expectErrorResponse(response, 400, "BAD_REQUEST");
  });

  it("returns 404 when the file is not found in S3", async () => {
    const { token } = await mintFileReadToken();
    mockS3Objects([]);

    const response = await requestDownload({ fileId: "missing", token });

    await expectErrorResponse(response, 404, "NOT_FOUND");
  });

  it("downloads a text file and returns matching headers", async () => {
    const fileId = "test-file-uuid";
    const fileContent = Buffer.from("hello world");
    const { token, userId } = await mintFileReadToken();
    mockS3Objects([
      {
        key: artifactKey(userId, fileId, "test_file.txt"),
        size: fileContent.length,
        body: fileContent,
      },
    ]);

    const response = await requestDownload({ fileId, token });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("x-file-name")).toBe("test_file.txt");
    expect(response.headers.get("x-file-mimetype")).toBe("text/plain");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="test_file.txt"; filename*=UTF-8''test_file.txt`,
    );
    expect(response.headers.get("content-length")).toBe(
      String(fileContent.length),
    );
    const receivedBytes = Buffer.from(await response.arrayBuffer());
    expect(receivedBytes.equals(fileContent)).toBeTruthy();
  });

  it("encodes the file name header while preserving the binary body", async () => {
    const fileId = "encoded-name-uuid";
    const fileContent = Buffer.from([0, 1, 2, 3, 255]);
    const { token, userId } = await mintFileReadToken();
    const filename = "report 2026 #final.bin";
    mockS3Objects([
      {
        key: artifactKey(userId, fileId, filename),
        size: fileContent.length,
        body: fileContent,
      },
    ]);

    const response = await requestDownload({ fileId, token });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-file-name")).toBe(
      encodeURIComponent(filename),
    );
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    expect(response.headers.get("content-length")).toBe(
      String(fileContent.length),
    );
    const receivedBytes = Buffer.from(await response.arrayBuffer());
    expect(receivedBytes.equals(fileContent)).toBeTruthy();
  });

  it("downloads an image file with the image MIME type", async () => {
    const fileId = "img-uuid";
    const fileContent = Buffer.from("fake-png-data");
    const { token, userId } = await mintFileReadToken();
    mockS3Objects([
      {
        key: artifactKey(userId, fileId, "photo.png"),
        size: fileContent.length,
        body: fileContent,
      },
    ]);

    const response = await requestDownload({ fileId, token });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-file-mimetype")).toBe("image/png");
  });

  it("downloads an office file with the office MIME type", async () => {
    const fileId = "sheet-uuid";
    const fileContent = Buffer.from("fake-xlsx-data");
    const { token, userId } = await mintFileReadToken();
    mockS3Objects([
      {
        key: artifactKey(userId, fileId, "budget.xlsx"),
        size: fileContent.length,
        body: fileContent,
      },
    ]);

    const response = await requestDownload({ fileId, token });

    const expected =
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(expected);
    expect(response.headers.get("x-file-mimetype")).toBe(expected);
  });

  it("downloads a hosted-site artifact as a zip by URL file id", async () => {
    const publicSlug = `demo-site-${randomUUID().slice(0, 8)}`;
    const indexHtml = "<!doctype html><h1>Site</h1>";
    const styleCss = "body { color: red; }";
    const appJs = "console.log('ready');";
    const { orgId, token, userId } = await mintFileReadToken();
    const runId = await seedRunForUser({ orgId, userId });
    const hosted = await seedHostedArtifact({
      artifactKind: "hosted-site",
      files: [
        {
          path: "/index.html",
          body: Buffer.from(indexHtml),
          contentType: "text/html; charset=utf-8",
        },
        {
          path: "/styles/main.css",
          body: Buffer.from(styleCss),
          contentType: "text/css",
        },
        {
          path: "/assets/app.js",
          body: Buffer.from(appJs),
          contentType: "text/javascript",
        },
      ],
      orgId,
      publicSlug,
      runId,
      userId,
    });
    mockS3Objects(hosted.objects);

    const response = await requestDownload({ fileId: hosted.url, token });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("x-file-name")).toBe(
      encodeURIComponent(`${publicSlug}.zip`),
    );
    expect(response.headers.get("x-file-mimetype")).toBe("application/zip");
    const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
    const entryNames = zip.getEntries().map((entry) => {
      return entry.entryName;
    });
    expect(entryNames).toStrictEqual([
      "assets/app.js",
      "index.html",
      "styles/main.css",
    ]);
    expect(zip.readAsText("index.html")).toBe(indexHtml);
    expect(zip.readAsText("styles/main.css")).toBe(styleCss);
    expect(zip.readAsText("assets/app.js")).toBe(appJs);
  });

  it("downloads a presentation html artifact by URL file id", async () => {
    const fileContent = Buffer.from("<!doctype html><h1>Deck</h1>");
    const { orgId, token, userId } = await mintFileReadToken();
    const runId = await seedRunForUser({ orgId, userId });
    const hosted = await seedHostedArtifact({
      artifactKind: "presentation-html",
      files: [
        {
          path: "/index.html",
          body: fileContent,
          contentType: "text/html; charset=utf-8",
        },
      ],
      orgId,
      publicSlug: `deck-site-${randomUUID().slice(0, 8)}`,
      runId,
      userId,
    });
    mockS3Objects(hosted.objects);

    const response = await requestDownload({ fileId: hosted.url, token });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html");
    expect(response.headers.get("x-file-name")).toBe(
      encodeURIComponent(hosted.filename),
    );
    const receivedBytes = Buffer.from(await response.arrayBuffer());
    expect(receivedBytes.equals(fileContent)).toBeTruthy();
  });

  it("returns application/octet-stream for unknown extensions", async () => {
    const fileId = "bin-uuid";
    const fileContent = Buffer.from("binary-data");
    const { token, userId } = await mintFileReadToken();
    mockS3Objects([
      {
        key: artifactKey(userId, fileId, "data.xyz"),
        size: fileContent.length,
        body: fileContent,
      },
    ]);

    const response = await requestDownload({ fileId, token });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
  });

  it("scopes file lookup to the authenticated user", async () => {
    const fileId = "scoped-uuid";
    const { token, userId } = await mintFileReadToken();
    mockS3Objects([]);

    await requestDownload({ fileId, token });

    const prefixes = context.mocks.s3.send.mock.calls
      .map(([command]) => {
        return commandInput(command).Prefix;
      })
      .filter((prefix): prefix is string => {
        return typeof prefix === "string";
      });
    expect(prefixes).toContain(`artifacts/${userId}/${fileId}/`);
  });
});
