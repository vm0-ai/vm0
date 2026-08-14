import { randomUUID } from "node:crypto";

import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  MAX_PRESENTATION_TEMPLATE_PAGE_BYTES,
  MAX_PRESENTATION_TEMPLATE_PAGES,
  MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES,
  PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
  PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE,
  zeroPresentationTemplatesContract,
} from "@okouai/api-contracts/contracts/zero-presentation-templates";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { zeroPresentationTemplatesRoutes } from "../zero-presentation-templates";

const context = testContext();
const bdd = createBddApi(context);
const mocks = createZeroRouteMocks(context);
const STORAGE_BUCKET = "test-user-storages";

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

function keyFromSignedUrl(url: string): string {
  return new URL(url).pathname.replace(/^\//u, "");
}

function deleteStoredObjects(
  objects: Set<string>,
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
  const objects = new Set<string>();

  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const input = commandInput(command);
    const bucket = typeof input.Bucket === "string" ? input.Bucket : "";
    if (command instanceof ListObjectsV2Command) {
      const prefix = typeof input.Prefix === "string" ? input.Prefix : "";
      return Promise.resolve({
        Contents: [...objects].flatMap((storedId) => {
          const separator = storedId.indexOf("\0");
          const storedBucket = storedId.slice(0, separator);
          const key = storedId.slice(separator + 1);
          return storedBucket === bucket && key.startsWith(prefix)
            ? [{ Key: key, Size: 1, LastModified: new Date(0) }]
            : [];
        }),
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
    upload(target: UploadTarget): string {
      const key = keyFromSignedUrl(target.uploadUrl);
      const id = objectId(STORAGE_BUCKET, key);
      if (target.uploadHeaders["if-none-match"] === "*" && objects.has(id)) {
        throw new Error(`Immutable upload already exists: ${key}`);
      }
      objects.add(id);
      return key;
    },
    keys(): readonly string[] {
      return [...objects].flatMap((storedId) => {
        const separator = storedId.indexOf("\0");
        return storedId.slice(0, separator) === STORAGE_BUCKET
          ? [storedId.slice(separator + 1)]
          : [];
      });
    },
  };
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
  return setupApp({ context, routes: zeroPresentationTemplatesRoutes })(
    zeroPresentationTemplatesContract,
  );
}

beforeEach(() => {
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", STORAGE_BUCKET);
});

describe("presentation template private upload preparation", () => {
  it("keeps preparation behind the feature switch and accepts only PPTX", async () => {
    const actor = bdd.user();
    installS3Fixture();
    const client = templateClient();
    mocks.clerk.session(actor.userId, actor.orgId);

    await accept(
      client.prepare({
        headers: webHeaders(),
        body: {
          requestId: randomUUID(),
          filename: "disabled.pptx",
          sourceSize: 128,
          pageSizes: [64],
        },
      }),
      [403],
    );

    await enablePresentationTemplates(actor);
    for (const filename of ["deck.pdf", "deck.html"]) {
      const unsupported = await accept(
        client.prepare({
          headers: webHeaders(),
          body: {
            requestId: randomUUID(),
            filename,
            sourceSize: 128,
            pageSizes: [64],
          },
        }),
        [400],
      );
      expect(unsupported.body.error.message).toContain(".pptx");
    }
  });

  it("validates manifest limits before allocating private uploads", async () => {
    const actor = bdd.user();
    installS3Fixture();
    await enablePresentationTemplates(actor);
    mocks.clerk.session(actor.userId, actor.orgId);
    const client = templateClient();

    const invalidBodies = [
      {
        requestId: randomUUID(),
        filename: "empty.pptx",
        sourceSize: 1,
        pageSizes: [],
      },
      {
        requestId: randomUUID(),
        filename: "too-many-pages.pptx",
        sourceSize: 1,
        pageSizes: Array.from(
          { length: MAX_PRESENTATION_TEMPLATE_PAGES + 1 },
          () => {
            return 1;
          },
        ),
      },
      {
        requestId: randomUUID(),
        filename: "large-source.pptx",
        sourceSize: MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES + 1,
        pageSizes: [1],
      },
      {
        requestId: randomUUID(),
        filename: "large-page.pptx",
        sourceSize: 1,
        pageSizes: [MAX_PRESENTATION_TEMPLATE_PAGE_BYTES + 1],
      },
    ];

    for (const body of invalidBodies) {
      await accept(client.prepare({ headers: webHeaders(), body }), [400]);
    }
    expect(context.mocks.s3.getSignedUrl).not.toHaveBeenCalled();
  });

  it("prepares one deterministic immutable manifest and supports owner cleanup", async () => {
    const actor = bdd.user();
    const otherActor = bdd.user();
    const fixture = installS3Fixture();
    await enablePresentationTemplates(actor);
    await enablePresentationTemplates(otherActor);
    mocks.clerk.session(actor.userId, actor.orgId);
    const client = templateClient();
    const requestId = randomUUID();
    const body = {
      requestId,
      filename: "brand-system.pptx",
      sourceSize: 128,
      pageSizes: [64, 65],
    };

    const first = await accept(
      client.prepare({ headers: webHeaders(), body }),
      [200],
    );
    const repeated = await accept(
      client.prepare({ headers: webHeaders(), body }),
      [200],
    );
    expect(repeated.body.templateId).toBe(first.body.templateId);
    expect(repeated.body.source.uploadUrl).toBe(first.body.source.uploadUrl);
    expect(
      repeated.body.pages.map(({ index, filename }) => {
        return { index, filename };
      }),
    ).toStrictEqual([
      { index: 0, filename: "page-001.png" },
      { index: 1, filename: "page-002.png" },
    ]);
    expect(first.body.source.uploadHeaders).toMatchObject({
      "content-type": PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE,
      "if-none-match": "*",
    });
    expect(
      first.body.pages.map((page) => {
        return page.uploadHeaders["content-type"];
      }),
    ).toStrictEqual([
      PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
      PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
    ]);
    expect(
      first.body.pages.every((page) => {
        return page.uploadHeaders["if-none-match"] === "*";
      }),
    ).toBeTruthy();

    const pendingList = await accept(
      client.list({ headers: webHeaders() }),
      [200],
    );
    expect(pendingList.body).toStrictEqual([]);
    const detail = await accept(
      client.get({
        headers: webHeaders(),
        params: { templateId: first.body.templateId },
      }),
      [200],
    );
    expect(detail.body).toMatchObject({
      id: first.body.templateId,
      title: "brand-system",
      status: "pending",
      sourceFilename: body.filename,
      coverUrl: null,
      pageCount: 0,
      pageUrls: [],
    });

    const renamed = await accept(
      client.update({
        headers: webHeaders(),
        params: { templateId: first.body.templateId },
        body: { title: "Brand system 2026" },
      }),
      [200],
    );
    expect(renamed.body.title).toBe("Brand system 2026");

    fixture.upload(first.body.source);
    for (const page of first.body.pages) {
      fixture.upload(page);
    }
    expect(fixture.keys()).toHaveLength(3);

    mocks.clerk.session(otherActor.userId, otherActor.orgId);
    await accept(
      client.delete({
        headers: webHeaders(),
        params: { templateId: first.body.templateId },
      }),
      [404],
    );
    expect(fixture.keys()).toHaveLength(3);

    mocks.clerk.session(actor.userId, actor.orgId);
    await accept(
      client.delete({
        headers: webHeaders(),
        params: { templateId: first.body.templateId },
      }),
      [204],
    );
    expect(fixture.keys()).toStrictEqual([]);
    await accept(
      client.get({
        headers: webHeaders(),
        params: { templateId: first.body.templateId },
      }),
      [404],
    );
  });
});
