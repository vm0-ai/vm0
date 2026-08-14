import { createHash, randomUUID } from "node:crypto";

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
  PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE,
  zeroPresentationTemplatesContract,
} from "@okouai/api-contracts/contracts/zero-presentation-templates";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import AdmZip from "adm-zip";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { zeroPresentationTemplatesRoutes } from "../zero-presentation-templates";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const mocks = createZeroRouteMocks(context);
const STORAGE_BUCKET = "test-user-storages";

interface StoredObject {
  readonly body: Buffer;
  readonly contentType: string | undefined;
  readonly metadata: Readonly<Record<string, string>>;
  readonly lastModified: Date;
}

interface UploadTarget {
  readonly uploadUrl: string;
  readonly uploadHeaders: Readonly<Record<string, string>>;
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

function listStoredObjects(
  objects: ReadonlyMap<string, StoredObject>,
  bucket: string,
  prefix: string,
) {
  return [...objects.entries()].flatMap(([storedId, object]) => {
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
  });
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

function metadataFromHeaders(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) => {
      const match = /^x-amz-meta-(.+)$/u.exec(name);
      return match?.[1] ? [[match[1], value]] : [];
    }),
  );
}

function keyFromSignedUrl(url: string): string {
  return new URL(url).pathname.replace(/^\//u, "");
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

function installS3Fixture() {
  const objects = new Map<string, StoredObject>();

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
        Contents: listStoredObjects(objects, bucket, prefix),
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
      const key = typeof input.Key === "string" ? input.Key : "unknown";
      if (
        command instanceof PutObjectCommand &&
        key.startsWith("presentation-template-ingestions/") &&
        input.IfNoneMatch !== "*"
      ) {
        throw new Error("Presentation template PUTs must be immutable");
      }
      return Promise.resolve(`https://r2.example.test/${key}?signature=test`);
    },
  );

  return {
    upload(target: UploadTarget, body: Buffer): string {
      const key = keyFromSignedUrl(target.uploadUrl);
      const id = objectId(STORAGE_BUCKET, key);
      if (target.uploadHeaders["if-none-match"] === "*" && objects.has(id)) {
        throw new Error(`Immutable upload already exists: ${key}`);
      }
      objects.set(id, {
        body,
        contentType: target.uploadHeaders["content-type"],
        metadata: metadataFromHeaders(target.uploadHeaders),
        lastModified: nowDate(),
      });
      return key;
    },
    put(args: {
      readonly key: string;
      readonly body: Buffer;
      readonly contentType: string;
      readonly metadata: Readonly<Record<string, string>>;
    }): void {
      objects.set(objectId(STORAGE_BUCKET, args.key), {
        body: args.body,
        contentType: args.contentType,
        metadata: args.metadata,
        lastModified: nowDate(),
      });
    },
    has(key: string): boolean {
      return objects.has(objectId(STORAGE_BUCKET, key));
    },
    keys(): readonly string[] {
      return [...objects.keys()].flatMap((storedId) => {
        const separator = storedId.indexOf("\0");
        return storedId.slice(0, separator) === STORAGE_BUCKET
          ? [storedId.slice(separator + 1)]
          : [];
      });
    },
  };
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

async function prepareImportActor(actor: ApiTestUser): Promise<{
  readonly defaultAgentId: string;
  readonly runnerGroup: string;
}> {
  await enablePresentationTemplates(actor);
  bdd.acceptAgentStorageWrites();
  await runs.grantProEntitlement(actor);
  const defaultAgentId = await bdd.bootstrapLimitedFreeOnboarding(actor, {
    displayName: "Presentation import agent",
  });
  await runs.ensureOrgModelProvider(actor);
  const runnerGroup = runs.configureRunnerGroup();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  return { defaultAgentId, runnerGroup };
}

function templateClient() {
  return setupApp({ context, routes: zeroPresentationTemplatesRoutes })(
    zeroPresentationTemplatesContract,
  );
}

async function prepareTemplate(
  actor: ApiTestUser,
  args: {
    readonly requestId?: string;
    readonly filename?: string;
    readonly source: Buffer;
    readonly pages: readonly Buffer[];
  },
) {
  mocks.clerk.session(actor.userId, actor.orgId);
  return await accept(
    templateClient().prepare({
      headers: webHeaders(),
      body: {
        requestId: args.requestId ?? randomUUID(),
        filename: args.filename ?? "brand-system.pptx",
        sourceSize: args.source.length,
        pageSizes: args.pages.map((page) => {
          return page.length;
        }),
      },
    }),
    [200],
  );
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
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", STORAGE_BUCKET);
});

describe("browser-rendered presentation template ingestion", () => {
  it("keeps prepare behind the feature switch and accepts only PPTX", async () => {
    const actor = bdd.user();
    installS3Fixture();
    const source = pptxSource(1);
    const page = pngHeader();
    const client = templateClient();
    mocks.clerk.session(actor.userId, actor.orgId);

    await accept(
      client.prepare({
        headers: webHeaders(),
        body: {
          requestId: randomUUID(),
          filename: "disabled.pptx",
          sourceSize: source.length,
          pageSizes: [page.length],
        },
      }),
      [403],
    );

    await enablePresentationTemplates(actor);
    const unsupported = await accept(
      client.prepare({
        headers: webHeaders(),
        body: {
          requestId: randomUUID(),
          filename: "deck.pdf",
          sourceSize: source.length,
          pageSizes: [page.length],
        },
      }),
      [400],
    );
    expect(unsupported.body.error.message).toContain(".pptx");
    expect((await runs.listAgentRuns(actor, { limit: 20 })).runs).toStrictEqual(
      [],
    );
  });

  it("verifies the complete source and page set before one idempotent analysis launch", async () => {
    const actor = bdd.user();
    await prepareImportActor(actor);
    const fixture = installS3Fixture();
    const source = pptxSource(2);
    const pages = [pngHeader(), pngHeader()];
    const requestId = randomUUID();
    const first = await prepareTemplate(actor, { requestId, source, pages });
    const repeated = await prepareTemplate(actor, {
      requestId,
      source,
      pages,
    });
    expect(repeated.body.templateId).toBe(first.body.templateId);
    expect(
      repeated.body.pages.map((page) => {
        return page.index;
      }),
    ).toStrictEqual([0, 1]);
    expect(first.body.source.uploadHeaders["if-none-match"]).toBe("*");
    expect(
      first.body.pages.every((page) => {
        return page.uploadHeaders["if-none-match"] === "*";
      }),
    ).toBeTruthy();

    const client = templateClient();
    const pendingList = await accept(
      client.list({ headers: webHeaders() }),
      [200],
    );
    expect(pendingList.body).toStrictEqual([]);
    expect((await runs.listAgentRuns(actor, { limit: 20 })).runs).toStrictEqual(
      [],
    );

    const sourceKey = fixture.upload(first.body.source, source);
    const firstPageKey = fixture.upload(
      required(first.body.pages[0], "Expected a first page upload"),
      required(pages[0], "Expected a first page body"),
    );
    await accept(
      client.commit({
        headers: webHeaders(),
        params: { templateId: first.body.templateId },
      }),
      [400],
    );
    expect((await runs.listAgentRuns(actor, { limit: 20 })).runs).toStrictEqual(
      [],
    );

    const secondPage = required(
      first.body.pages[1],
      "Expected a second page upload",
    );
    const secondPageBody = required(pages[1], "Expected a second page body");
    const secondPageKey = fixture.upload(secondPage, secondPageBody);
    fixture.put({
      key: sourceKey,
      body: Buffer.concat([source, Buffer.from("unexpected-extra-byte")]),
      contentType: PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE,
      metadata: metadataFromHeaders(first.body.source.uploadHeaders),
    });
    const wrongSize = await accept(
      client.commit({
        headers: webHeaders(),
        params: { templateId: first.body.templateId },
      }),
      [400],
    );
    expect(wrongSize.body.error.code).toBe("invalid_upload");
    fixture.put({
      key: sourceKey,
      body: source,
      contentType: PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE,
      metadata: metadataFromHeaders(first.body.source.uploadHeaders),
    });
    fixture.put({
      key: secondPageKey,
      body: secondPageBody,
      contentType: "image/jpeg",
      metadata: metadataFromHeaders(secondPage.uploadHeaders),
    });
    const wrongType = await accept(
      client.commit({
        headers: webHeaders(),
        params: { templateId: first.body.templateId },
      }),
      [400],
    );
    expect(wrongType.body.error.code).toBe("invalid_upload");
    expect((await runs.listAgentRuns(actor, { limit: 20 })).runs).toStrictEqual(
      [],
    );

    fixture.put({
      key: secondPageKey,
      body: secondPageBody,
      contentType: PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
      metadata: {},
    });
    const wrongMetadata = await accept(
      client.commit({
        headers: webHeaders(),
        params: { templateId: first.body.templateId },
      }),
      [400],
    );
    expect(wrongMetadata.body.error.code).toBe("invalid_upload");

    fixture.put({
      key: secondPageKey,
      body: Buffer.alloc(secondPageBody.length),
      contentType: PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
      metadata: metadataFromHeaders(secondPage.uploadHeaders),
    });
    await accept(
      client.commit({
        headers: webHeaders(),
        params: { templateId: first.body.templateId },
      }),
      [400],
    );
    expect((await runs.listAgentRuns(actor, { limit: 20 })).runs).toStrictEqual(
      [],
    );

    fixture.put({
      key: secondPageKey,
      body: secondPageBody,
      contentType: PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
      metadata: metadataFromHeaders(secondPage.uploadHeaders),
    });
    const concurrentCommits = await Promise.all([
      accept(
        client.commit({
          headers: webHeaders(),
          params: { templateId: first.body.templateId },
        }),
        [200],
      ),
      accept(
        client.commit({
          headers: webHeaders(),
          params: { templateId: first.body.templateId },
        }),
        [200],
      ),
    ]);
    expect(
      concurrentCommits.map((response) => {
        return response.body.status;
      }),
    ).toStrictEqual(["processing", "processing"]);
    const createdRuns = (await runs.listAgentRuns(actor, { limit: 20 })).runs;
    expect(createdRuns).toHaveLength(1);
    const importRun = required(createdRuns[0], "Expected one analysis run");
    expect(importRun.prompt).toContain("pages pull");
    expect(importRun.prompt).not.toContain("LibreOffice");
    expect(importRun.prompt).not.toContain("PDF");
    expect(importRun.prompt).not.toContain("Poppler");
    expect(importRun.prompt).not.toContain("screenshot");
    expect(importRun.prompt).not.toContain("pdftoppm");
    expect(importRun.prompt).not.toContain("pages upload");

    const retriedCommit = await accept(
      client.commit({
        headers: webHeaders(),
        params: { templateId: first.body.templateId },
      }),
      [200],
    );
    expect(retriedCommit.body.status).toBe("processing");
    expect((await runs.listAgentRuns(actor, { limit: 20 })).runs).toHaveLength(
      1,
    );

    mocks.clerk.session(actor.userId, actor.orgId);
    const detail = await accept(
      client.get({
        headers: webHeaders(),
        params: { templateId: first.body.templateId },
      }),
      [200],
    );
    expect(detail.body).toMatchObject({
      status: "processing",
      pageCount: 2,
      sourceFilename: "brand-system.pptx",
    });
    expect(detail.body.pageUrls).toHaveLength(2);
    expect(detail.body.coverUrl).toBe(detail.body.pageUrls[0]);
    expect(JSON.stringify(detail.body)).not.toContain("StorageKey");
    expect(JSON.stringify(detail.body)).not.toContain("aspectRatio");
    expect(fixture.has(sourceKey)).toBeTruthy();
    expect(fixture.has(firstPageKey)).toBeTruthy();
    expect(fixture.has(secondPageKey)).toBeTruthy();
    expect(() => {
      fixture.upload(first.body.source, source);
    }).toThrow("Immutable upload already exists");
  });

  it("rejects manifest drift, slide-count mismatch, and non-16:9 pages, then cleans abandonment", async () => {
    const actor = bdd.user();
    await enablePresentationTemplates(actor);
    const fixture = installS3Fixture();
    const source = pptxSource(2);
    const page = pngHeader();
    const requestId = randomUUID();
    const prepared = await prepareTemplate(actor, {
      requestId,
      source,
      pages: [page],
    });
    const drift = await accept(
      templateClient().prepare({
        headers: webHeaders(),
        body: {
          requestId,
          filename: "brand-system.pptx",
          sourceSize: source.length,
          pageSizes: [page.length + 1],
        },
      }),
      [409],
    );
    expect(drift.body.error.code).toBe("CONFLICT");

    const uploadedKeys = [
      fixture.upload(prepared.body.source, source),
      ...prepared.body.pages.map((target, index) => {
        const body = index === 0 ? page : pngHeader();
        return fixture.upload(target, body);
      }),
    ];
    const countMismatch = await accept(
      templateClient().commit({
        headers: webHeaders(),
        params: { templateId: prepared.body.templateId },
      }),
      [400],
    );
    expect(countMismatch.body.error.code).toBe("page_count_mismatch");
    expect((await runs.listAgentRuns(actor, { limit: 20 })).runs).toStrictEqual(
      [],
    );

    await accept(
      templateClient().delete({
        headers: webHeaders(),
        params: { templateId: prepared.body.templateId },
      }),
      [204],
    );
    for (const key of uploadedKeys) {
      expect(fixture.has(key)).toBeFalsy();
    }

    const singleSlide = pptxSource(1);
    const fourThreePage = pngHeader(1200, 900);
    const wrongRatio = await prepareTemplate(actor, {
      source: singleSlide,
      pages: [fourThreePage],
    });
    fixture.upload(wrongRatio.body.source, singleSlide);
    fixture.upload(
      required(wrongRatio.body.pages[0], "Expected a page upload"),
      fourThreePage,
    );
    const invalidPage = await accept(
      templateClient().commit({
        headers: webHeaders(),
        params: { templateId: wrongRatio.body.templateId },
      }),
      [400],
    );
    expect(invalidPage.body.error.message).toContain("16:9 PNG");
    expect((await runs.listAgentRuns(actor, { limit: 20 })).runs).toStrictEqual(
      [],
    );

    await accept(
      templateClient().delete({
        headers: webHeaders(),
        params: { templateId: wrongRatio.body.templateId },
      }),
      [204],
    );
    const malformedSource = Buffer.from("not a zip archive", "utf8");
    const malformed = await prepareTemplate(actor, {
      source: malformedSource,
      pages: [page],
    });
    fixture.upload(malformed.body.source, malformedSource);
    fixture.upload(
      required(malformed.body.pages[0], "Expected a page upload"),
      page,
    );
    const invalidPptx = await accept(
      templateClient().commit({
        headers: webHeaders(),
        params: { templateId: malformed.body.templateId },
      }),
      [400],
    );
    expect(invalidPptx.body.error.code).toBe("invalid_file");
    expect((await runs.listAgentRuns(actor, { limit: 20 })).runs).toStrictEqual(
      [],
    );
  });

  it("binds private source and ordered pages to the owner analysis run", async () => {
    const owner = bdd.user();
    const { defaultAgentId: ownerAgentId } = await prepareImportActor(owner);
    const fixture = installS3Fixture();
    const source = pptxSource(2);
    const pages = [pngHeader(), pngHeader()];
    const prepared = await prepareTemplate(owner, { source, pages });
    fixture.upload(prepared.body.source, source);
    for (const [index, target] of prepared.body.pages.entries()) {
      const page = pages[index];
      if (!page) {
        throw new Error("Expected an ordered page body");
      }
      fixture.upload(target, page);
    }
    await accept(
      templateClient().commit({
        headers: webHeaders(),
        params: { templateId: prepared.body.templateId },
      }),
      [200],
    );
    const runId = await importRunId(owner, prepared.body.templateId);

    const peer = bdd.user({ orgId: owner.orgId });
    await enablePresentationTemplates(peer);
    mocks.clerk.session(peer.userId, peer.orgId);
    await accept(
      templateClient().get({
        headers: webHeaders(),
        params: { templateId: prepared.body.templateId },
      }),
      [404],
    );
    await accept(
      templateClient().commit({
        headers: webHeaders(),
        params: { templateId: prepared.body.templateId },
      }),
      [404],
    );

    const unrelatedRun = await runs.createDirectRun(owner, {
      agentComposeId: ownerAgentId,
      prompt: "Unrelated owner run",
      triggerSource: "test",
      vars: { OKOU_AGENT_ID: ownerAgentId },
      secrets: { OKOU_TOKEN: "unrelated-presentation-template-token" },
    });
    for (const headers of [
      sandboxHeaders(peer, runId),
      sandboxHeaders(owner, unrelatedRun.runId),
    ]) {
      await accept(
        templateClient().source({
          headers,
          params: { templateId: prepared.body.templateId },
        }),
        [404],
      );
      await accept(
        templateClient().pages({
          headers,
          params: { templateId: prepared.body.templateId },
        }),
        [404],
      );
      await accept(
        templateClient().publishPackage({
          headers,
          params: { templateId: prepared.body.templateId },
          body: {
            files: [
              { path: "DESIGN_SYSTEM.md", content: "# Design" },
              { path: "LAYOUTS.md", content: "# Layouts" },
              { path: "tokens.json", content: "{}" },
            ],
          },
        }),
        [404],
      );
    }

    const runHeaders = sandboxHeaders(owner, runId);
    const sourceDownload = await accept(
      templateClient().source({
        headers: runHeaders,
        params: { templateId: prepared.body.templateId },
      }),
      [200],
    );
    expect(sourceDownload.body).toMatchObject({
      filename: "brand-system.pptx",
      contentType: PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE,
      size: source.length,
    });
    const pageDownloads = await accept(
      templateClient().pages({
        headers: runHeaders,
        params: { templateId: prepared.body.templateId },
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
  });

  it("terminal callbacks clean failed and concurrently deleted ingestions", async () => {
    const actor = bdd.user();
    const { runnerGroup } = await prepareImportActor(actor);
    const fixture = installS3Fixture();
    const source = pptxSource(1);
    const page = pngHeader();

    const failedPreparation = await prepareTemplate(actor, {
      source,
      pages: [page],
    });
    const failedKeys = [
      fixture.upload(failedPreparation.body.source, source),
      fixture.upload(
        required(failedPreparation.body.pages[0], "Expected a page upload"),
        page,
      ),
    ];
    await accept(
      templateClient().commit({
        headers: webHeaders(),
        params: { templateId: failedPreparation.body.templateId },
      }),
      [200],
    );
    const failedRunId = await importRunId(
      actor,
      failedPreparation.body.templateId,
    );
    await webhooks.requestAgentComplete(
      { runId: failedRunId, exitCode: 1, error: "analysis crashed" },
      sandboxHeaders(actor, failedRunId),
      [200],
    );
    await flushWaitUntilForTest();
    for (const key of failedKeys) {
      expect(fixture.has(key)).toBeFalsy();
    }
    mocks.clerk.session(actor.userId, actor.orgId);
    const failedDetail = await accept(
      templateClient().get({
        headers: webHeaders(),
        params: { templateId: failedPreparation.body.templateId },
      }),
      [200],
    );
    expect(failedDetail.body).toMatchObject({
      status: "failed",
      error: { code: "analysis_failed", message: "analysis crashed" },
      pageCount: 0,
    });

    const unpublishedPreparation = await prepareTemplate(actor, {
      source,
      pages: [page],
    });
    const unpublishedKeys = [
      fixture.upload(unpublishedPreparation.body.source, source),
      fixture.upload(
        required(
          unpublishedPreparation.body.pages[0],
          "Expected a page upload",
        ),
        page,
      ),
    ];
    await runs.heartbeatRunner(runnerGroup);
    await accept(
      templateClient().commit({
        headers: webHeaders(),
        params: { templateId: unpublishedPreparation.body.templateId },
      }),
      [200],
    );
    const unpublishedRunId = await importRunId(
      actor,
      unpublishedPreparation.body.templateId,
    );
    await runs.claimRunnerJob(unpublishedRunId);
    await webhooks.requestAgentCheckpoint(
      {
        runId: unpublishedRunId,
        cliAgentType: "claude-code",
        cliAgentSessionId: `bdd-template-import-${unpublishedRunId}`,
        cliAgentSessionHistoryHash: createHash("sha256")
          .update(`bdd template import history ${unpublishedRunId}`)
          .digest("hex"),
      },
      sandboxHeaders(actor, unpublishedRunId),
      [200],
    );
    await webhooks.requestAgentComplete(
      { runId: unpublishedRunId, exitCode: 0 },
      sandboxHeaders(actor, unpublishedRunId),
      [200],
    );
    await flushWaitUntilForTest();
    for (const key of unpublishedKeys) {
      expect(fixture.has(key)).toBeFalsy();
    }
    mocks.clerk.session(actor.userId, actor.orgId);
    const unpublishedDetail = await accept(
      templateClient().get({
        headers: webHeaders(),
        params: { templateId: unpublishedPreparation.body.templateId },
      }),
      [200],
    );
    expect(unpublishedDetail.body).toMatchObject({
      status: "failed",
      error: { code: "publish_failed" },
    });

    const deletedPreparation = await prepareTemplate(actor, {
      source,
      pages: [page],
    });
    const deletedSourceKey = fixture.upload(
      deletedPreparation.body.source,
      source,
    );
    const deletedPageTarget = required(
      deletedPreparation.body.pages[0],
      "Expected a page upload",
    );
    const deletedPageKey = fixture.upload(deletedPageTarget, page);
    await accept(
      templateClient().commit({
        headers: webHeaders(),
        params: { templateId: deletedPreparation.body.templateId },
      }),
      [200],
    );
    const deletedRunId = await importRunId(
      actor,
      deletedPreparation.body.templateId,
    );
    await accept(
      templateClient().delete({
        headers: webHeaders(),
        params: { templateId: deletedPreparation.body.templateId },
      }),
      [204],
    );

    fixture.upload(deletedPreparation.body.source, source);
    fixture.upload(deletedPageTarget, page);
    expect(fixture.has(deletedSourceKey)).toBeTruthy();
    expect(fixture.has(deletedPageKey)).toBeTruthy();
    await webhooks.requestAgentComplete(
      { runId: deletedRunId, exitCode: 1, error: "deleted during analysis" },
      sandboxHeaders(actor, deletedRunId),
      [200],
    );
    await flushWaitUntilForTest();
    expect(fixture.has(deletedSourceKey)).toBeFalsy();
    expect(fixture.has(deletedPageKey)).toBeFalsy();
  });

  it("publishes the three-file package atomically and deletes all private state", async () => {
    const actor = bdd.user();
    await prepareImportActor(actor);
    const fixture = installS3Fixture();
    const source = pptxSource(1);
    const page = pngHeader();
    const prepared = await prepareTemplate(actor, {
      source,
      pages: [page],
    });
    const inputKeys = [
      fixture.upload(prepared.body.source, source),
      fixture.upload(
        required(prepared.body.pages[0], "Expected a page upload"),
        page,
      ),
    ];
    await accept(
      templateClient().commit({
        headers: webHeaders(),
        params: { templateId: prepared.body.templateId },
      }),
      [200],
    );
    const runId = await importRunId(actor, prepared.body.templateId);
    const packageKeysBefore = new Set(fixture.keys());
    const published = await accept(
      templateClient().publishPackage({
        headers: sandboxHeaders(actor, runId),
        params: { templateId: prepared.body.templateId },
        body: {
          files: [
            { path: "DESIGN_SYSTEM.md", content: "# Design system" },
            { path: "LAYOUTS.md", content: "# Layouts" },
            { path: "tokens.json", content: '{"colors":{}}' },
          ],
        },
      }),
      [200],
    );
    expect(published.body.status).toBe("ready");
    const packageKeys = fixture.keys().filter((key) => {
      return !packageKeysBefore.has(key);
    });
    expect(packageKeys.length).toBeGreaterThan(0);

    await webhooks.requestAgentComplete(
      { runId, exitCode: 0 },
      sandboxHeaders(actor, runId),
      [200],
    );
    await flushWaitUntilForTest();
    for (const key of inputKeys) {
      expect(fixture.has(key)).toBeTruthy();
    }

    mocks.clerk.session(actor.userId, actor.orgId);
    await accept(
      templateClient().delete({
        headers: webHeaders(),
        params: { templateId: prepared.body.templateId },
      }),
      [204],
    );
    for (const key of [...inputKeys, ...packageKeys]) {
      expect(fixture.has(key)).toBeFalsy();
    }
  });
});
