import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
  PRESENTATION_TEMPLATE_PACKAGE_CONTENT_TYPE,
  PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE,
  zeroPresentationTemplatesContract,
} from "@okouai/api-contracts/contracts/zero-presentation-templates";
import { zeroUploadsContract } from "@okouai/api-contracts/contracts/zero-uploads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import AdmZip from "adm-zip";
import { create as createTar } from "tar";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { onRejection } from "../../utils";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { zeroPresentationTemplatesRoutes } from "../zero-presentation-templates";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const mocks = createZeroRouteMocks(context);
const ARTIFACTS_BUCKET = "test-user-artifacts";
const STORAGES_BUCKET = "test-user-storages";

interface StoredObject {
  readonly body: Buffer;
  readonly contentType: string | undefined;
  readonly metadata: Readonly<Record<string, string>>;
  readonly lastModified: Date;
}

interface SignedPut {
  readonly bucket: string;
  readonly key: string;
  readonly contentType: string | undefined;
  readonly metadata: Readonly<Record<string, string>>;
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

function objectId(bucket: string, key: string): string {
  return `${bucket}\0${key}`;
}

function notFoundError(key: string): Error {
  return Object.assign(new Error(`Missing S3 object: ${key}`), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 },
  });
}

function bodyBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) {
    return Buffer.from(body);
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }
  throw new Error("Expected an S3 object body");
}

function rangeSlice(body: Buffer, range: unknown): Buffer {
  if (typeof range !== "string") {
    return body;
  }
  const match = /^bytes=(\d+)-(\d+)$/u.exec(range);
  if (!match) {
    throw new Error(`Unexpected byte range: ${range}`);
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  return body.subarray(start, end + 1);
}

function byteStream(body: Buffer): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield body;
    },
  };
}

function deleteStoredObjects(
  objects: Map<string, StoredObject>,
  bucket: string,
  deletion: unknown,
): void {
  if (typeof deletion !== "object" || deletion === null) {
    return;
  }
  const candidates = (deletion as { readonly Objects?: readonly unknown[] })
    .Objects;
  for (const candidate of candidates ?? []) {
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      "Key" in candidate &&
      typeof candidate.Key === "string"
    ) {
      objects.delete(objectId(bucket, candidate.Key));
    }
  }
}

function installS3Fixture() {
  const objects = new Map<string, StoredObject>();
  const signedPuts = new Map<string, SignedPut>();
  let signature = 0;

  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const input = commandInput(command);
    const bucket = typeof input.Bucket === "string" ? input.Bucket : "";
    const key = typeof input.Key === "string" ? input.Key : "";
    const id = objectId(bucket, key);

    if (command instanceof PutObjectCommand) {
      objects.set(id, {
        body: bodyBuffer(input.Body),
        contentType:
          typeof input.ContentType === "string" ? input.ContentType : undefined,
        metadata:
          typeof input.Metadata === "object" && input.Metadata !== null
            ? (input.Metadata as Readonly<Record<string, string>>)
            : {},
        lastModified: nowDate(),
      });
      return Promise.resolve({});
    }
    if (command instanceof ListObjectsV2Command) {
      const prefix = typeof input.Prefix === "string" ? input.Prefix : "";
      return Promise.resolve({
        Contents: [...objects.entries()].flatMap(([storedId, object]) => {
          const separator = storedId.indexOf("\0");
          const storedBucket = storedId.slice(0, separator);
          const storedKey = storedId.slice(separator + 1);
          return storedBucket === bucket && storedKey.startsWith(prefix)
            ? [
                {
                  Key: storedKey,
                  Size: object.body.length,
                  LastModified: object.lastModified,
                },
              ]
            : [];
        }),
      });
    }
    if (command instanceof HeadObjectCommand) {
      const object = objects.get(id);
      if (!object) {
        throw notFoundError(key);
      }
      return Promise.resolve({
        ContentLength: object.body.length,
        ContentType: object.contentType,
        Metadata: object.metadata,
        LastModified: object.lastModified,
      });
    }
    if (command instanceof GetObjectCommand) {
      const object = objects.get(id);
      if (!object) {
        throw notFoundError(key);
      }
      const body = rangeSlice(object.body, input.Range);
      return Promise.resolve({
        Body: byteStream(body),
        ContentLength: body.length,
        ContentType: object.contentType,
      });
    }
    if (command instanceof DeleteObjectsCommand) {
      deleteStoredObjects(objects, bucket, input.Delete);
      return Promise.resolve({});
    }
    return Promise.resolve({});
  });

  context.mocks.s3.getSignedUrl.mockImplementation(
    (_client: unknown, command: unknown) => {
      const input = commandInput(command);
      signature += 1;
      const url = `https://r2.example.test/signed/${signature.toString()}`;
      if (command instanceof PutObjectCommand) {
        signedPuts.set(url, {
          bucket: typeof input.Bucket === "string" ? input.Bucket : "",
          key: typeof input.Key === "string" ? input.Key : "",
          contentType:
            typeof input.ContentType === "string"
              ? input.ContentType
              : undefined,
          metadata:
            typeof input.Metadata === "object" && input.Metadata !== null
              ? (input.Metadata as Readonly<Record<string, string>>)
              : {},
        });
      }
      return Promise.resolve(url);
    },
  );

  return {
    upload(uploadUrl: string, body: Buffer): string {
      const target = signedPuts.get(uploadUrl);
      if (!target) {
        throw new Error(`Unknown presigned PUT: ${uploadUrl}`);
      }
      objects.set(objectId(target.bucket, target.key), {
        body,
        contentType: target.contentType,
        metadata: target.metadata,
        lastModified: nowDate(),
      });
      return target.key;
    },
    has(bucket: string, key: string): boolean {
      return objects.has(objectId(bucket, key));
    },
    body(bucket: string, key: string): Buffer | undefined {
      const body = objects.get(objectId(bucket, key))?.body;
      return body ? Buffer.from(body) : undefined;
    },
    keys(bucket: string): readonly string[] {
      return [...objects.keys()].flatMap((storedId) => {
        const separator = storedId.indexOf("\0");
        return storedId.slice(0, separator) === bucket
          ? [storedId.slice(separator + 1)]
          : [];
      });
    },
  };
}

function headObjectRequestCount(): number {
  return context.mocks.s3.send.mock.calls.filter((call) => {
    return call[0] instanceof HeadObjectCommand;
  }).length;
}

function pptxSource(slideCount: number): Buffer {
  const archive = new AdmZip();
  archive.addFile(
    "ppt/presentation.xml",
    Buffer.from('<p:presentation xmlns:p="p"/>', "utf8"),
  );
  for (let index = 0; index < slideCount; index += 1) {
    archive.addFile(
      `ppt/slides/slide${(index + 1).toString()}.xml`,
      Buffer.from('<p:sld xmlns:p="p"/>', "utf8"),
    );
  }
  return archive.toBuffer();
}

function pngHeader(width = 1600, height = 900): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

async function packageArchive(
  files: readonly {
    readonly path: string;
    readonly content: string | Buffer;
  }[],
): Promise<Buffer> {
  const directory = mkdtempSync(join(tmpdir(), "presentation-package-test-"));
  const archivePath = join(directory, "package.tar.gz");
  const build = async (): Promise<Buffer> => {
    for (const file of files) {
      const path = join(directory, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content);
    }
    await createTar(
      {
        cwd: directory,
        file: archivePath,
        gzip: true,
        mtime: nowDate(),
        portable: true,
      },
      files.map((file) => {
        return file.path;
      }),
    );
    return readFileSync(archivePath);
  };
  const archive = await onRejection(build(), () => {
    rmSync(directory, { recursive: true, force: true });
  });
  rmSync(directory, { recursive: true, force: true });
  return archive;
}

async function unsafePackageArchive(): Promise<Buffer> {
  const directory = mkdtempSync(join(tmpdir(), "presentation-package-unsafe-"));
  const packageDirectory = join(directory, "package");
  const archivePath = join(directory, "unsafe.tar.gz");
  const build = async (): Promise<Buffer> => {
    mkdirSync(packageDirectory);
    writeFileSync(join(packageDirectory, "SKILL.md"), "# Skill");
    writeFileSync(
      join(packageDirectory, "design-system.md"),
      "# Design system",
    );
    writeFileSync(join(directory, "outside.txt"), "unsafe");
    await createTar(
      {
        cwd: packageDirectory,
        file: archivePath,
        gzip: true,
        preservePaths: true,
      },
      ["SKILL.md", "design-system.md", "../outside.txt"],
    );
    return readFileSync(archivePath);
  };
  const archive = await onRejection(build(), () => {
    rmSync(directory, { recursive: true, force: true });
  });
  rmSync(directory, { recursive: true, force: true });
  return archive;
}

function webHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function sandboxHeaders(actor: ApiTestUser, runId: string) {
  return {
    authorization: `Bearer ${runs.sandboxTokenForRun(actor, runId)}`,
  };
}

async function enablePresentationTemplates(actor: ApiTestUser): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Presentation template tests require an organization");
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId: actor.orgId },
    { [FeatureSwitchKey.PresentationTemplates]: true },
  );
}

async function prepareImportActor(actor: ApiTestUser): Promise<void> {
  await enablePresentationTemplates(actor);
  bdd.acceptAgentStorageWrites();
  await runs.grantProEntitlement(actor);
  await bdd.bootstrapLimitedFreeOnboarding(actor, {
    displayName: "Presentation import agent",
  });
  await runs.ensureOrgModelProvider(actor);
  runs.configureRunnerGroup();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
}

function templateClient() {
  return setupApp({ context, routes: zeroPresentationTemplatesRoutes })(
    zeroPresentationTemplatesContract,
  );
}

function uploadClient() {
  return setupApp({ context, routes: uploadsPrepareRoutes })(
    zeroUploadsContract,
  );
}

async function preparePrivateFile(
  actor: ApiTestUser,
  args: {
    readonly filename: string;
    readonly contentType: string;
    readonly body: Buffer;
  },
) {
  mocks.clerk.session(actor.userId, actor.orgId);
  const prepared = await accept(
    uploadClient().prepare({
      headers: webHeaders(),
      body: {
        filename: args.filename,
        contentType: args.contentType,
        size: args.body.length,
      },
    }),
    [200],
  );
  if (!("uploadUrl" in prepared.body)) {
    throw new Error("Expected a single-part private upload");
  }
  return prepared.body;
}

async function uploadPrivateFile(
  actor: ApiTestUser,
  fixture: ReturnType<typeof installS3Fixture>,
  args: {
    readonly filename: string;
    readonly contentType: string;
    readonly body: Buffer;
  },
) {
  const prepared = await preparePrivateFile(actor, args);
  return {
    id: prepared.id,
    key: fixture.upload(prepared.uploadUrl, args.body),
  };
}

async function uploadValidManifest(
  actor: ApiTestUser,
  fixture: ReturnType<typeof installS3Fixture>,
  pageCount: number,
) {
  const sourceBody = pptxSource(pageCount);
  const source = await uploadPrivateFile(actor, fixture, {
    filename: "brand-system.pptx",
    contentType: PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE,
    body: sourceBody,
  });
  const pages = [];
  for (let index = 0; index < pageCount; index += 1) {
    pages.push(
      await uploadPrivateFile(actor, fixture, {
        filename: `browser-page-${(index + 1).toString()}.png`,
        contentType: PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
        body: pngHeader(),
      }),
    );
  }
  return { source, pages };
}

async function importRunId(
  actor: ApiTestUser,
  templateId: string,
): Promise<string> {
  const listed = await runs.listAgentRuns(actor, { limit: 20 });
  const run = listed.runs.find((candidate) => {
    return candidate.prompt.startsWith(
      `Import presentation template ${templateId}.`,
    );
  });
  if (!run) {
    throw new Error(`Expected import run for template ${templateId}`);
  }
  return run.id;
}

beforeEach(() => {
  mockEnv("R2_USER_ARTIFACTS_BUCKET_NAME", ARTIFACTS_BUCKET);
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", STORAGES_BUCKET);
});

describe("browser-rendered presentation template ingestion", () => {
  it("keeps commit feature-gated and rejects incomplete or invalid uploads before analysis", async () => {
    const actor = bdd.user();
    const fixture = installS3Fixture();
    const client = templateClient();
    mocks.clerk.session(actor.userId, actor.orgId);
    const disabledBody = {
      requestId: randomUUID(),
      sourceFileId: randomUUID(),
      pageFileIds: [randomUUID()],
    };

    await accept(
      client.commit({ headers: webHeaders(), body: disabledBody }),
      [403],
    );

    await enablePresentationTemplates(actor);
    const source = await uploadPrivateFile(actor, fixture, {
      filename: "two-slides.pptx",
      contentType: PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE,
      body: pptxSource(2),
    });
    const missingPage = await preparePrivateFile(actor, {
      filename: "missing.png",
      contentType: PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
      body: pngHeader(),
    });
    const missing = await accept(
      client.commit({
        headers: webHeaders(),
        body: {
          requestId: randomUUID(),
          sourceFileId: source.id,
          pageFileIds: [missingPage.id],
        },
      }),
      [400],
    );
    expect(missing.body.error.code).toBe("invalid_upload");

    fixture.upload(missingPage.uploadUrl, pngHeader());
    const countMismatch = await accept(
      client.commit({
        headers: webHeaders(),
        body: {
          requestId: randomUUID(),
          sourceFileId: source.id,
          pageFileIds: [missingPage.id],
        },
      }),
      [400],
    );
    expect(countMismatch.body.error.code).toBe("page_count_mismatch");

    const pdf = await uploadPrivateFile(actor, fixture, {
      filename: "deck.pdf",
      contentType: "application/pdf",
      body: Buffer.from("pdf", "utf8"),
    });
    const unsupported = await accept(
      client.commit({
        headers: webHeaders(),
        body: {
          requestId: randomUUID(),
          sourceFileId: pdf.id,
          pageFileIds: [missingPage.id],
        },
      }),
      [400],
    );
    expect(unsupported.body.error.code).toBe("unsupported_format");
    expect((await runs.listAgentRuns(actor, { limit: 20 })).runs).toStrictEqual(
      [],
    );
  });

  it("starts exactly one analysis after an ordered manifest commits and remains idempotent", async () => {
    const actor = bdd.user();
    await prepareImportActor(actor);
    const fixture = installS3Fixture();
    const uploaded = await uploadValidManifest(actor, fixture, 2);
    const body = {
      requestId: randomUUID(),
      sourceFileId: uploaded.source.id,
      pageFileIds: uploaded.pages.map((page) => {
        return page.id;
      }),
    };
    mocks.clerk.session(actor.userId, actor.orgId);
    const client = templateClient();

    const responses = await Promise.all([
      accept(client.commit({ headers: webHeaders(), body }), [200]),
      accept(client.commit({ headers: webHeaders(), body }), [200]),
    ]);
    expect(
      responses.map((response) => {
        return response.body.status;
      }),
    ).toStrictEqual(["processing", "processing"]);
    const templateId = responses[0]?.body.id;
    if (!templateId) {
      throw new Error("Expected a committed template id");
    }

    const createdRuns = (await runs.listAgentRuns(actor, { limit: 20 })).runs;
    expect(createdRuns).toHaveLength(1);
    const importRun = createdRuns[0];
    expect(importRun?.prompt).toContain("pages pull");
    expect(importRun?.prompt).toContain("SKILL.md");
    expect(importRun?.prompt).toContain("design-system.md");
    expect(importRun?.prompt).toContain("semantic HTML, CSS, and SVG");
    expect(importRun?.prompt).toContain("CSS Grid or Flexbox");
    expect(importRun?.prompt).toContain("Do not include JSON, LAYOUTS.md");
    expect(importRun?.prompt).not.toContain("LibreOffice");
    expect(importRun?.prompt).not.toContain("PDF");
    expect(importRun?.prompt).not.toContain("screenshot");

    const retried = await accept(
      client.commit({ headers: webHeaders(), body }),
      [200],
    );
    expect(retried.body).toMatchObject({
      id: templateId,
      status: "processing",
    });
    expect((await runs.listAgentRuns(actor, { limit: 20 })).runs).toHaveLength(
      1,
    );

    const detail = await accept(
      client.get({ headers: webHeaders(), params: { templateId } }),
      [200],
    );
    expect(detail.body).toMatchObject({
      status: "processing",
      sourceFilename: "brand-system.pptx",
      pageCount: 2,
    });
    expect(detail.body.pageUrls).toHaveLength(2);
    expect(detail.body.coverUrl).toBe(detail.body.pageUrls[0]);
    expect(JSON.stringify(detail.body)).not.toContain("aspectRatio");
    expect(
      fixture.keys(ARTIFACTS_BUCKET).some((key) => {
        return key.startsWith("presentation-template-ingestions/");
      }),
    ).toBeFalsy();

    const replacementPage = await uploadPrivateFile(actor, fixture, {
      filename: "replacement.png",
      contentType: PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
      body: pngHeader(),
    });
    const drift = await accept(
      client.commit({
        headers: webHeaders(),
        body: {
          ...body,
          pageFileIds: [
            body.pageFileIds[0] ?? randomUUID(),
            replacementPage.id,
          ],
        },
      }),
      [409],
    );
    expect(drift.body.error.code).toBe("CONFLICT");
    expect((await runs.listAgentRuns(actor, { limit: 20 })).runs).toHaveLength(
      1,
    );
  });

  it("rejects unsafe or schema-driven package archives before ready", async () => {
    const actor = bdd.user();
    await prepareImportActor(actor);
    const fixture = installS3Fixture();
    const uploaded = await uploadValidManifest(actor, fixture, 1);
    const committed = await accept(
      templateClient().commit({
        headers: webHeaders(),
        body: {
          requestId: randomUUID(),
          sourceFileId: uploaded.source.id,
          pageFileIds: [uploaded.pages[0]?.id ?? randomUUID()],
        },
      }),
      [200],
    );
    const templateId = committed.body.id;
    const runId = await importRunId(actor, templateId);
    const invalidArchives = [
      {
        body: await packageArchive([
          { path: "SKILL.md", content: "# Skill" },
          { path: "design-system.md", content: "# Design system" },
          { path: "tokens.json", content: "{}" },
        ]),
        message: "must not contain JSON",
      },
      {
        body: await unsafePackageArchive(),
        message: "unsafe path",
      },
      {
        body: await packageArchive([{ path: "SKILL.md", content: "# Skill" }]),
        message: "missing required file: design-system.md",
      },
    ];

    for (const invalidArchive of invalidArchives) {
      const packageUpload = await uploadPrivateFile(actor, fixture, {
        filename: "presentation-template-package.tar.gz",
        contentType: PRESENTATION_TEMPLATE_PACKAGE_CONTENT_TYPE,
        body: invalidArchive.body,
      });
      const response = await accept(
        templateClient().publishPackage({
          headers: sandboxHeaders(actor, runId),
          params: { templateId },
          body: { archiveFileId: packageUpload.id },
        }),
        [400],
      );
      expect(response.body.error.message).toContain(invalidArchive.message);
      expect(fixture.has(ARTIFACTS_BUCKET, packageUpload.key)).toBeFalsy();
    }

    mocks.clerk.session(actor.userId, actor.orgId);
    const detail = await accept(
      templateClient().get({
        headers: webHeaders(),
        params: { templateId },
      }),
      [200],
    );
    expect(detail.body.status).toBe("processing");
  });

  it("binds private inputs to the analysis run and deletes only the generated package", async () => {
    const owner = bdd.user();
    await prepareImportActor(owner);
    const fixture = installS3Fixture();
    const uploaded = await uploadValidManifest(owner, fixture, 2);
    const commit = await accept(
      templateClient().commit({
        headers: webHeaders(),
        body: {
          requestId: randomUUID(),
          sourceFileId: uploaded.source.id,
          pageFileIds: uploaded.pages.map((page) => {
            return page.id;
          }),
        },
      }),
      [200],
    );
    const templateId = commit.body.id;
    const runId = await importRunId(owner, templateId);

    const peer = bdd.user({ orgId: owner.orgId });
    await enablePresentationTemplates(peer);
    mocks.clerk.session(peer.userId, peer.orgId);
    await accept(
      templateClient().get({ headers: webHeaders(), params: { templateId } }),
      [404],
    );
    await accept(
      templateClient().source({
        headers: sandboxHeaders(peer, runId),
        params: { templateId },
      }),
      [404],
    );

    const runHeaders = sandboxHeaders(owner, runId);
    const headRequestsBeforeDownloads = headObjectRequestCount();
    const sourceDownload = await accept(
      templateClient().source({
        headers: runHeaders,
        params: { templateId },
      }),
      [200],
    );
    expect(sourceDownload.body).toMatchObject({
      url: expect.any(String),
      filename: "brand-system.pptx",
      contentType: PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE,
    });
    expect(sourceDownload.body).not.toHaveProperty("size");
    const pageDownloads = await accept(
      templateClient().pages({
        headers: runHeaders,
        params: { templateId },
      }),
      [200],
    );
    expect(
      pageDownloads.body.pages.map((page) => {
        return { index: page.index, filename: page.filename };
      }),
    ).toStrictEqual([
      { index: 0, filename: "page-001.png" },
      { index: 1, filename: "page-002.png" },
    ]);
    expect(
      pageDownloads.body.pages.every((page) => {
        return !("size" in page);
      }),
    ).toBeTruthy();
    expect(headObjectRequestCount()).toBe(headRequestsBeforeDownloads);

    const storageKeysBefore = new Set(fixture.keys(STORAGES_BUCKET));
    const logo = pngHeader();
    const font = Buffer.from([0x77, 0x4f, 0x46, 0x32]);
    const archiveBody = await packageArchive([
      {
        path: "SKILL.md",
        content:
          "# Author presentation HTML directly\n\nRead design-system.md and write semantic HTML/CSS/SVG.",
      },
      { path: "design-system.md", content: "# Reusable visual language" },
      {
        path: "color-systems/brand.css",
        content: ":root { --brand-accent: #7357ff; }",
      },
      { path: "assets/identity/logo.png", content: logo },
      { path: "assets/fonts/brand-font.woff2", content: font },
    ]);
    const packageUpload = await uploadPrivateFile(owner, fixture, {
      filename: "presentation-template-package.tar.gz",
      contentType: PRESENTATION_TEMPLATE_PACKAGE_CONTENT_TYPE,
      body: archiveBody,
    });
    const published = await accept(
      templateClient().publishPackage({
        headers: runHeaders,
        params: { templateId },
        body: { archiveFileId: packageUpload.id },
      }),
      [200],
    );
    expect(published.body.status).toBe("ready");
    expect(fixture.has(ARTIFACTS_BUCKET, packageUpload.key)).toBeFalsy();
    const packageKeys = fixture.keys(STORAGES_BUCKET).filter((key) => {
      return !storageKeysBefore.has(key);
    });
    expect(packageKeys.length).toBeGreaterThan(0);
    const manifestKey = packageKeys.find((key) => {
      return key.endsWith("/manifest.json");
    });
    const manifestBody = manifestKey
      ? fixture.body(STORAGES_BUCKET, manifestKey)
      : undefined;
    expect(manifestBody).toBeDefined();
    const manifest = JSON.parse(manifestBody?.toString("utf8") ?? "{}") as {
      readonly files?: readonly {
        readonly path: string;
        readonly hash: string;
        readonly size: number;
      }[];
    };
    expect(
      manifest.files?.map((file) => {
        return file.path;
      }),
    ).toStrictEqual([
      "SKILL.md",
      "design-system.md",
      "color-systems/brand.css",
      "assets/identity/logo.png",
      "assets/fonts/brand-font.woff2",
    ]);
    expect(
      manifest.files?.some((file) => {
        return file.path.endsWith(".json");
      }),
    ).toBeFalsy();
    expect(manifest.files).toContainEqual({
      path: "assets/identity/logo.png",
      hash: createHash("sha256").update(logo).digest("hex"),
      size: logo.length,
    });
    expect(manifest.files).toContainEqual({
      path: "assets/fonts/brand-font.woff2",
      hash: createHash("sha256").update(font).digest("hex"),
      size: font.length,
    });

    await webhooks.requestAgentComplete(
      { runId, exitCode: 0 },
      sandboxHeaders(owner, runId),
      [200],
    );
    await flushWaitUntilForTest();
    const inputKeys = [
      uploaded.source.key,
      ...uploaded.pages.map((page) => {
        return page.key;
      }),
    ];
    for (const key of inputKeys) {
      expect(fixture.has(ARTIFACTS_BUCKET, key)).toBeTruthy();
    }

    mocks.clerk.session(owner.userId, owner.orgId);
    await accept(
      templateClient().delete({
        headers: webHeaders(),
        params: { templateId },
      }),
      [204],
    );
    for (const key of inputKeys) {
      expect(fixture.has(ARTIFACTS_BUCKET, key)).toBeTruthy();
    }
    for (const key of packageKeys) {
      expect(fixture.has(STORAGES_BUCKET, key)).toBeFalsy();
    }
  });

  it("records terminal analysis failure without deleting the uploaded inputs", async () => {
    const actor = bdd.user();
    await prepareImportActor(actor);
    const fixture = installS3Fixture();
    const uploaded = await uploadValidManifest(actor, fixture, 1);
    const committed = await accept(
      templateClient().commit({
        headers: webHeaders(),
        body: {
          requestId: randomUUID(),
          sourceFileId: uploaded.source.id,
          pageFileIds: [uploaded.pages[0]?.id ?? randomUUID()],
        },
      }),
      [200],
    );
    const runId = await importRunId(actor, committed.body.id);

    await webhooks.requestAgentComplete(
      { runId, exitCode: 1, error: "analysis crashed" },
      sandboxHeaders(actor, runId),
      [200],
    );
    await flushWaitUntilForTest();

    mocks.clerk.session(actor.userId, actor.orgId);
    const detail = await accept(
      templateClient().get({
        headers: webHeaders(),
        params: { templateId: committed.body.id },
      }),
      [200],
    );
    expect(detail.body).toMatchObject({
      status: "failed",
      error: { code: "analysis_failed", message: "analysis crashed" },
      pageCount: 0,
      pageUrls: [],
    });
    expect(fixture.has(ARTIFACTS_BUCKET, uploaded.source.key)).toBeTruthy();
    expect(
      fixture.has(
        ARTIFACTS_BUCKET,
        uploaded.pages[0]?.key ?? "missing-page-key",
      ),
    ).toBeTruthy();
  });
});
