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
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
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
import { uploadsPrepareRoutes } from "../uploads-prepare";

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

/** Preflight reads the PPTX header and central directory as byte ranges. */
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

function uploadClient() {
  return setupApp({ context, routes: uploadsPrepareRoutes })(uploadsContract);
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
  const source = await uploadPrivateFile(actor, fixture, {
    filename: "brand-system.pptx",
    contentType: PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE,
    body: pptxSource(pageCount),
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

describe("browser-rendered presentation template commit", () => {
  it("keeps commit feature-gated and rejects incomplete or invalid uploads", async () => {
    const actor = bdd.user();
    const fixture = installS3Fixture();
    const client = templateClient();
    mocks.clerk.session(actor.userId, actor.orgId);

    await accept(
      client.commit({
        headers: webHeaders(),
        body: {
          requestId: randomUUID(),
          sourceFileId: randomUUID(),
          pageFileIds: [randomUUID()],
        },
      }),
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

    const listed = await accept(client.list({ headers: webHeaders() }), [200]);
    expect(listed.body).toStrictEqual([]);
  });

  it("records one pending template per request id and rejects drifted uploads", async () => {
    const actor = bdd.user();
    await enablePresentationTemplates(actor);
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
    ).toStrictEqual(["pending", "pending"]);
    const templateId = responses[0]?.body.id;
    if (!templateId) {
      throw new Error("Expected a committed template id");
    }
    expect(responses[1]?.body.id).toBe(templateId);

    const retried = await accept(
      client.commit({ headers: webHeaders(), body }),
      [200],
    );
    expect(retried.body).toMatchObject({ id: templateId, status: "pending" });

    // A pending import is not a usable template, so the collection stays empty
    // until analysis moves it on.
    expect(
      (await accept(client.list({ headers: webHeaders() }), [200])).body,
    ).toStrictEqual([]);

    // Pages stay hidden until analysis has accepted the committed inputs.
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

    // The commit references the uploads in place instead of copying them.
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
  });
});
