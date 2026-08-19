import { randomUUID } from "node:crypto";

import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
  PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE,
  presentationTemplatesContract,
} from "@okouai/api-contracts/contracts/presentation-templates";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import AdmZip from "adm-zip";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { presentationTemplatesRoutes } from "../presentation-templates";

const context = testContext();
const bdd = createBddApi(context);
const mocks = createZeroRouteMocks(context);
const ARTIFACTS_BUCKET = "test-user-artifacts";

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

/** The slide count is read as a trailing byte range, not a full download. */
function rangeSlice(body: Buffer, range: unknown): Buffer {
  if (typeof range !== "string") {
    return body;
  }
  const match = /^bytes=(\d+)-(\d+)$/u.exec(range);
  if (!match) {
    throw new Error(`Unexpected byte range: ${range}`);
  }
  return body.subarray(Number(match[1]), Number(match[2]) + 1);
}

function byteStream(body: Buffer): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield body;
    },
  };
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

function templateClient() {
  return setupApp({ context, routes: presentationTemplatesRoutes })(
    presentationTemplatesContract,
  );
}

async function openImport(
  actor: ApiTestUser,
  sourceFilename = "brand-system.pptx",
): Promise<string> {
  mocks.clerk.session(actor.userId, actor.orgId);
  const opened = await accept(
    templateClient().createImport({
      headers: webHeaders(),
      body: { requestId: randomUUID(), sourceFilename },
    }),
    [200],
  );
  return opened.body.id;
}

/** Request a slot from the import, then PUT the bytes to the URL it returns. */
async function fillSlot(
  actor: ApiTestUser,
  fixture: ReturnType<typeof installS3Fixture>,
  templateId: string,
  slot:
    | { readonly role: "source"; readonly filename: string }
    | { readonly role: "page"; readonly pageIndex: number },
  body: Buffer,
): Promise<void> {
  mocks.clerk.session(actor.userId, actor.orgId);
  const requested = await accept(
    templateClient().requestUpload({
      headers: webHeaders(),
      params: { templateId },
      body:
        slot.role === "source"
          ? {
              role: "source",
              filename: slot.filename,
              contentType: PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE,
              size: body.length,
            }
          : {
              role: "page",
              pageIndex: slot.pageIndex,
              filename: `page-${(slot.pageIndex + 1).toString()}.png`,
              contentType: PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
              size: body.length,
            },
    }),
    [200],
  );
  fixture.upload(requested.body.uploadUrl, body);
}

async function fillImport(
  actor: ApiTestUser,
  fixture: ReturnType<typeof installS3Fixture>,
  templateId: string,
  pageCount: number,
  slideCount = pageCount,
): Promise<void> {
  await fillSlot(
    actor,
    fixture,
    templateId,
    { role: "source", filename: "brand-system.pptx" },
    pptxSource(slideCount),
  );
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    await fillSlot(
      actor,
      fixture,
      templateId,
      { role: "page", pageIndex },
      pngHeader(),
    );
  }
}

beforeEach(() => {
  mockEnv("R2_USER_ARTIFACTS_BUCKET_NAME", ARTIFACTS_BUCKET);
});

describe("presentation template owner routes", () => {
  it("keeps the owner collection behind the feature switch", async () => {
    const actor = bdd.user();
    mocks.clerk.session(actor.userId, actor.orgId);
    const client = templateClient();

    await accept(client.list({ headers: webHeaders() }), [403]);

    await enablePresentationTemplates(actor);
    const response = await accept(
      client.list({ headers: webHeaders() }),
      [200],
    );
    expect(response.body).toStrictEqual([]);
  });

  it("does not expose an unknown template through owner routes", async () => {
    const actor = bdd.user();
    await enablePresentationTemplates(actor);
    mocks.clerk.session(actor.userId, actor.orgId);
    const client = templateClient();
    const templateId = randomUUID();

    await accept(
      client.get({ headers: webHeaders(), params: { templateId } }),
      [404],
    );
    await accept(
      client.update({
        headers: webHeaders(),
        params: { templateId },
        body: { title: "Renamed" },
      }),
      [404],
    );
    await accept(
      client.delete({ headers: webHeaders(), params: { templateId } }),
      [404],
    );
  });
});

describe("presentation template import", () => {
  it("keeps the import behind the feature switch and scopes slots to an open import", async () => {
    const actor = bdd.user();
    const client = templateClient();
    mocks.clerk.session(actor.userId, actor.orgId);

    await accept(
      client.createImport({
        headers: webHeaders(),
        body: { requestId: randomUUID(), sourceFilename: "deck.pptx" },
      }),
      [403],
    );

    await enablePresentationTemplates(actor);
    await accept(
      client.createImport({
        headers: webHeaders(),
        body: { requestId: randomUUID(), sourceFilename: "deck.pdf" },
      }),
      [400],
    );

    // A slot can only be taken from an import the caller owns.
    await accept(
      client.requestUpload({
        headers: webHeaders(),
        params: { templateId: randomUUID() },
        body: {
          role: "page",
          pageIndex: 0,
          filename: "page-1.png",
          contentType: PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
          size: 1024,
        },
      }),
      [404],
    );
    await accept(
      client.commit({
        headers: webHeaders(),
        params: { templateId: randomUUID() },
        body: {},
      }),
      [404],
    );
  });

  it("commits the ordered set the API allocated without being told object ids", async () => {
    const actor = bdd.user();
    await enablePresentationTemplates(actor);
    const fixture = installS3Fixture();
    const client = templateClient();

    const requestId = randomUUID();
    mocks.clerk.session(actor.userId, actor.orgId);
    const opened = await accept(
      client.createImport({
        headers: webHeaders(),
        body: { requestId, sourceFilename: "brand-system.pptx" },
      }),
      [200],
    );
    const templateId = opened.body.id;
    expect(opened.body.status).toBe("pending");

    // The same request id resolves to the same import instead of a second one.
    const reopened = await accept(
      client.createImport({
        headers: webHeaders(),
        body: { requestId, sourceFilename: "brand-system.pptx" },
      }),
      [200],
    );
    expect(reopened.body.id).toBe(templateId);

    await fillImport(actor, fixture, templateId, 2);

    mocks.clerk.session(actor.userId, actor.orgId);
    const committed = await accept(
      client.commit({
        headers: webHeaders(),
        params: { templateId },
        body: {},
      }),
      [200],
    );
    expect(committed.body).toMatchObject({ id: templateId, status: "pending" });

    // Committing again returns the same template rather than redoing the work.
    const recommitted = await accept(
      client.commit({
        headers: webHeaders(),
        params: { templateId },
        body: {},
      }),
      [200],
    );
    expect(recommitted.body).toMatchObject({ id: templateId });

    // A pending import is not a usable template yet.
    const listed = await accept(client.list({ headers: webHeaders() }), [200]);
    expect(listed.body).toStrictEqual([]);
    const detail = await accept(
      client.get({ headers: webHeaders(), params: { templateId } }),
      [200],
    );
    expect(detail.body).toMatchObject({
      status: "pending",
      sourceFilename: "brand-system.pptx",
      pageCount: 0,
      coverUrl: null,
    });
    expect(detail.body.pageUrls).toStrictEqual([]);
  });

  it("refuses to commit a gapped or mismatched page set", async () => {
    const actor = bdd.user();
    await enablePresentationTemplates(actor);
    const fixture = installS3Fixture();
    const client = templateClient();

    const gapped = await openImport(actor);
    await fillSlot(
      actor,
      fixture,
      gapped,
      { role: "source", filename: "brand-system.pptx" },
      pptxSource(2),
    );
    await fillSlot(
      actor,
      fixture,
      gapped,
      { role: "page", pageIndex: 1 },
      pngHeader(),
    );
    mocks.clerk.session(actor.userId, actor.orgId);
    const missingPage = await accept(
      client.commit({
        headers: webHeaders(),
        params: { templateId: gapped },
        body: {},
      }),
      [400],
    );
    expect(missingPage.body.error.message).toContain("Page 1 is missing");

    const mismatched = await openImport(actor);
    await fillImport(actor, fixture, mismatched, 2, 5);
    mocks.clerk.session(actor.userId, actor.orgId);
    const countMismatch = await accept(
      client.commit({
        headers: webHeaders(),
        params: { templateId: mismatched },
        body: {},
      }),
      [400],
    );
    expect(countMismatch.body.error.message).toContain("5 slides");

    const unreadable = await openImport(actor);
    await fillSlot(
      actor,
      fixture,
      unreadable,
      { role: "source", filename: "corrupt.pptx" },
      Buffer.alloc(2048, 7),
    );
    await fillSlot(
      actor,
      fixture,
      unreadable,
      { role: "page", pageIndex: 0 },
      pngHeader(),
    );
    mocks.clerk.session(actor.userId, actor.orgId);
    const invalid = await accept(
      client.commit({
        headers: webHeaders(),
        params: { templateId: unreadable },
        body: {},
      }),
      [400],
    );
    expect(invalid.body.error.message).toContain("could not be read");
  });

  it("stops handing out slots once the import is committed", async () => {
    const actor = bdd.user();
    await enablePresentationTemplates(actor);
    const fixture = installS3Fixture();
    const client = templateClient();

    const templateId = await openImport(actor);
    await fillImport(actor, fixture, templateId, 1);
    mocks.clerk.session(actor.userId, actor.orgId);
    await accept(
      client.commit({
        headers: webHeaders(),
        params: { templateId },
        body: {},
      }),
      [200],
    );

    await accept(
      client.requestUpload({
        headers: webHeaders(),
        params: { templateId },
        body: {
          role: "page",
          pageIndex: 1,
          filename: "page-2.png",
          contentType: PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
          size: 1024,
        },
      }),
      [409],
    );
  });
});
