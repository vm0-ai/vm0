import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import {
  MAX_IMAGE_REFERENCE_SOURCE_BYTES,
  imageReferencesContract,
} from "@okouai/api-contracts/contracts/image-references";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { featureSwitchesRoutes } from "../feature-switches";
import { imageReferencesRoutes } from "../image-references";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const privateBucket = "test-private-artifacts";
const routes = Object.freeze([
  ...featureSwitchesRoutes,
  ...uploadsPrepareRoutes,
  ...uploadsCompleteRoutes,
  ...imageReferencesRoutes,
]);
const validPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z0YQAAAAASUVORK5CYII=",
  "base64",
);

interface StoredObject {
  readonly id: string;
  readonly bucket: string;
  readonly key: string;
  readonly contentType: string;
  readonly size: number;
  body: Buffer;
}

const storedObjects = new Map<string, StoredObject>();
let signedUrlSequence = 0;

function objectIdentity(bucket: string, key: string): string {
  return `${bucket}\u0000${key}`;
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

function storageMock(command: unknown): Promise<unknown> {
  if (command instanceof ListObjectsV2Command) {
    return Promise.resolve({ Contents: [] });
  }
  const input = commandInput(command);
  const bucket = typeof input.Bucket === "string" ? input.Bucket : "";
  const key = typeof input.Key === "string" ? input.Key : "";
  const object = storedObjects.get(objectIdentity(bucket, key));
  if (command instanceof HeadObjectCommand) {
    if (!object) {
      return Promise.reject(
        Object.assign(new Error("Missing test object"), { name: "NotFound" }),
      );
    }
    return Promise.resolve({
      ContentLength: object.size,
      ContentType: object.contentType,
      Metadata: { "artifact-id": object.id },
    });
  }
  if (command instanceof GetObjectCommand) {
    if (!object) {
      return Promise.reject(
        Object.assign(new Error("Missing test object"), { name: "NoSuchKey" }),
      );
    }
    return Promise.resolve({
      ContentLength: object.size,
      ContentType: object.contentType,
      Body: Readable.from([object.body]),
    });
  }
  if (command instanceof DeleteObjectsCommand) {
    const deletion = input.Delete;
    if (typeof deletion === "object" && deletion !== null) {
      const objects = "Objects" in deletion ? deletion.Objects : undefined;
      if (Array.isArray(objects)) {
        for (const candidate of objects) {
          if (
            typeof candidate === "object" &&
            candidate !== null &&
            "Key" in candidate &&
            typeof candidate.Key === "string"
          ) {
            storedObjects.delete(objectIdentity(bucket, candidate.Key));
          }
        }
      }
    }
    return Promise.resolve({});
  }
  throw new Error(`Unexpected storage request: ${String(command)}`);
}

function imageClient() {
  return setupApp({ context, routes })(imageReferencesContract);
}

function uploadClient() {
  return setupApp({ context, routes })(uploadsContract);
}

function featureClient() {
  return setupApp({ context, routes })(featureSwitchesContract);
}

function session(
  userId: string,
  orgId: string,
  orgRole: "org:admin" | "org:member" = "org:admin",
): void {
  mocks.clerk.session(userId, orgId, orgRole);
}

async function setSwitches(switches: Readonly<Record<string, boolean>>) {
  return await accept(
    featureClient().update({ headers, body: { switches } }),
    [200],
  );
}

async function enableReferenceImages(): Promise<void> {
  await setSwitches({ [FeatureSwitchKey.ReferenceImages]: true });
}

async function prepareUpload(args: {
  readonly filename?: string;
  readonly contentType?: string;
  readonly size?: number;
  readonly purpose?: "artifact" | "image-reference";
}): Promise<{
  readonly id: string;
  readonly bucket: string;
  readonly key: string;
}> {
  const filename = args.filename ?? "reference.png";
  const contentType = args.contentType ?? "image/png";
  const size = args.size ?? validPng.length;
  const prepared = await accept(
    uploadClient().prepare({
      headers,
      body: { filename, contentType, size, purpose: args.purpose },
    }),
    [200],
  );
  const signedCommand = context.mocks.s3.getSignedUrl.mock.calls.at(-1)?.[1];
  const input = commandInput(signedCommand);
  const bucket = typeof input.Bucket === "string" ? input.Bucket : null;
  const key = typeof input.Key === "string" ? input.Key : null;
  if (!bucket || !key) {
    throw new Error("Prepared upload did not sign a bucket and key");
  }
  return { id: prepared.body.id, bucket, key };
}

async function completeUpload(args: {
  readonly filename?: string;
  readonly contentType?: string;
  readonly size?: number;
  readonly purpose?: "artifact" | "image-reference";
  readonly body?: Buffer;
}): Promise<StoredObject> {
  const contentType = args.contentType ?? "image/png";
  const body = args.body ?? validPng;
  const size = args.size ?? body.length;
  const prepared = await prepareUpload({ ...args, contentType, size });
  const object: StoredObject = {
    ...prepared,
    contentType,
    size,
    body,
  };
  storedObjects.set(objectIdentity(object.bucket, object.key), object);
  await accept(
    uploadClient().complete({ headers, body: { id: prepared.id } }),
    [200],
  );
  return object;
}

async function createReference(
  sourceFileId: string,
  visibility: "private" | "public" = "private",
  title = "Campaign hero",
) {
  return await accept(
    imageClient().create({
      headers,
      body: { sourceFileId, title, visibility },
    }),
    [201],
  );
}

beforeEach(() => {
  storedObjects.clear();
  signedUrlSequence = 0;
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  context.mocks.s3.send.mockImplementation(storageMock);
  context.mocks.s3.getSignedUrl.mockImplementation(
    (_client: unknown, command: unknown) => {
      signedUrlSequence += 1;
      const input = commandInput(command);
      const operation = "ContentType" in input ? "upload" : "preview";
      return Promise.resolve(
        `https://${operation}.example.test/access/${signedUrlSequence.toString()}?signature=test`,
      );
    },
  );
});

describe("image reference catalog routes", () => {
  it("keeps every catalog route and its private upload purpose disabled by default", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const referenceId = randomUUID();
    session(userId, orgId);

    const flags = await accept(featureClient().get({ headers }), [200]);
    expect(
      flags.body.effectiveSwitches[FeatureSwitchKey.ReferenceImages],
    ).toBeFalsy();

    const responses = await Promise.all([
      imageClient().list({ headers }),
      imageClient().create({
        headers,
        body: {
          sourceFileId: randomUUID(),
          title: "Disabled",
          visibility: "private",
        },
      }),
      imageClient().get({ headers, params: { referenceId } }),
      imageClient().update({
        headers,
        params: { referenceId },
        body: { title: "Disabled" },
      }),
      imageClient().delete({ headers, params: { referenceId } }),
      imageClient().resolvePreviewUrls({
        headers,
        body: { previewAssetIds: [`irp:${randomUUID()}:invalid`] },
      }),
      uploadClient().prepare({
        headers,
        body: {
          filename: "reference.png",
          contentType: "image/png",
          size: validPng.length,
          purpose: "image-reference",
        },
      }),
    ]);
    expect(responses.map(({ status }) => status)).toStrictEqual([
      403, 403, 403, 403, 403, 403, 403,
    ]);

    const ordinaryUpload = await accept(
      uploadClient().prepare({
        headers,
        body: {
          filename: "ordinary.png",
          contentType: "image/png",
          size: validPng.length,
        },
      }),
      [200],
    );
    expect(ordinaryUpload.body.id).toEqual(expect.any(String));
  });

  it("admits only ready same-owner private image bytes within the source limits", async () => {
    const userId = `user_${randomUUID()}`;
    const otherUserId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    session(userId, orgId);
    await enableReferenceImages();

    await accept(
      uploadClient().prepare({
        headers,
        body: {
          filename: "animation.gif",
          contentType: "image/gif",
          size: 10,
          purpose: "image-reference",
        },
      }),
      [400],
    );
    await accept(
      uploadClient().prepare({
        headers,
        body: {
          filename: "too-large.png",
          contentType: "image/png",
          size: MAX_IMAGE_REFERENCE_SOURCE_BYTES + 1,
          purpose: "image-reference",
        },
      }),
      [400],
    );

    const pending = await prepareUpload({ purpose: "image-reference" });
    await accept(
      imageClient().create({
        headers,
        body: {
          sourceFileId: pending.id,
          title: "Pending",
          visibility: "private",
        },
      }),
      [400],
    );

    const publicUpload = await completeUpload({});
    await accept(
      imageClient().create({
        headers,
        body: {
          sourceFileId: publicUpload.id,
          title: "Legacy public",
          visibility: "private",
        },
      }),
      [400],
    );

    const otherOwned = await completeUpload({ purpose: "image-reference" });
    session(otherUserId, orgId, "org:member");
    await accept(
      imageClient().create({
        headers,
        body: {
          sourceFileId: otherOwned.id,
          title: "Not mine",
          visibility: "private",
        },
      }),
      [400],
    );

    session(userId, orgId);
    const spoofed = await completeUpload({ purpose: "image-reference" });
    const jpegHeader = Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01,
      0x01, 0x11, 0x00, 0xff, 0xd9,
    ]);
    spoofed.body = Buffer.concat([
      jpegHeader,
      Buffer.alloc(spoofed.size - jpegHeader.length),
    ]);
    const mismatch = await accept(
      imageClient().create({
        headers,
        body: {
          sourceFileId: spoofed.id,
          title: "Spoofed",
          visibility: "private",
        },
      }),
      [400],
    );
    expect(mismatch.body.error.message).toContain("content type");

    const invalid = await completeUpload({ purpose: "image-reference" });
    invalid.body = Buffer.alloc(invalid.size);
    const invalidResponse = await accept(
      imageClient().create({
        headers,
        body: {
          sourceFileId: invalid.id,
          title: "Invalid",
          visibility: "private",
        },
      }),
      [400],
    );
    expect(invalidResponse.body.error.message).toContain("not a valid");

    await setSwitches({ [FeatureSwitchKey.PrivateArtifacts]: true });
    const oversized = await completeUpload({
      purpose: "artifact",
      size: MAX_IMAGE_REFERENCE_SOURCE_BYTES + 1,
    });
    const oversizedResponse = await accept(
      imageClient().create({
        headers,
        body: {
          sourceFileId: oversized.id,
          title: "Oversized",
          visibility: "private",
        },
      }),
      [400],
    );
    expect(oversizedResponse.body.error.message).toContain("bytes or smaller");

    const valid = await completeUpload({ purpose: "image-reference" });
    const created = await createReference(valid.id);
    expect(created.body).toMatchObject({
      title: "Campaign hero",
      contentType: "image/png",
      width: 1,
      height: 1,
      visibility: "private",
      canManage: true,
      canModerate: false,
    });
    expect(created.body.previewAsset.previewAssetId).toMatch(
      new RegExp(`^irp:${created.body.id}:[\\w-]{43}$`, "u"),
    );
    const serialized = JSON.stringify(created.body);
    expect(serialized).not.toContain("sourceStorageKey");
    expect(serialized).not.toContain("storageKey");
    expect(serialized).not.toContain(privateBucket);

    const duplicate = await accept(
      imageClient().create({
        headers,
        body: {
          sourceFileId: valid.id,
          title: "Duplicate",
          visibility: "private",
        },
      }),
      [409],
    );
    expect(duplicate.body.error.code).toBe("CONFLICT");
  });

  it("enforces organization visibility, owner management, admin unsharing, previews, invalidation, and deletion order", async () => {
    const ownerUserId = `user_${randomUUID()}`;
    const memberUserId = `user_${randomUUID()}`;
    const otherOrgUserId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const otherOrgId = `org_${randomUUID()}`;
    session(ownerUserId, orgId);
    await enableReferenceImages();
    const source = await completeUpload({ purpose: "image-reference" });

    context.mocks.ably.channelGet.mockClear();
    context.mocks.ably.publish.mockClear();
    const created = await createReference(source.id);
    const referenceId = created.body.id;
    const previewAssetId = created.body.previewAsset.previewAssetId;
    expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(
      `user:${ownerUserId}`,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "imageReferencesChanged",
      null,
    );

    session(memberUserId, orgId, "org:member");
    const privateList = await accept(imageClient().list({ headers }), [200]);
    expect(privateList.body).toStrictEqual([]);
    await accept(
      imageClient().get({ headers, params: { referenceId } }),
      [404],
    );
    const privatePreviews = await accept(
      imageClient().resolvePreviewUrls({
        headers,
        body: { previewAssetIds: [previewAssetId] },
      }),
      [200],
    );
    expect(privatePreviews.body.assets).toStrictEqual([]);

    session(ownerUserId, orgId);
    context.mocks.ably.channelGet.mockClear();
    const published = await accept(
      imageClient().update({
        headers,
        params: { referenceId },
        body: { title: "Shared hero", visibility: "public" },
      }),
      [200],
    );
    expect(published.body).toMatchObject({
      title: "Shared hero",
      visibility: "public",
      canManage: true,
    });
    expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(`org:${orgId}`);

    session(memberUserId, orgId, "org:member");
    const memberList = await accept(imageClient().list({ headers }), [200]);
    expect(memberList.body).toHaveLength(1);
    expect(memberList.body[0]).toMatchObject({
      id: referenceId,
      canManage: false,
      canModerate: false,
    });
    await accept(
      imageClient().update({
        headers,
        params: { referenceId },
        body: { title: "Member rename" },
      }),
      [404],
    );
    await accept(
      imageClient().delete({ headers, params: { referenceId } }),
      [404],
    );
    const memberPreviews = await accept(
      imageClient().resolvePreviewUrls({
        headers,
        body: {
          previewAssetIds: [previewAssetId, previewAssetId, "invalid"],
        },
      }),
      [200],
    );
    expect(memberPreviews.body.assets).toHaveLength(1);
    expect(memberPreviews.body.assets[0]?.previewAssetId).toBe(previewAssetId);

    session(otherOrgUserId, otherOrgId);
    await enableReferenceImages();
    await accept(
      imageClient().get({ headers, params: { referenceId } }),
      [404],
    );
    const crossOrgPreviews = await accept(
      imageClient().resolvePreviewUrls({
        headers,
        body: { previewAssetIds: [previewAssetId] },
      }),
      [200],
    );
    expect(crossOrgPreviews.body.assets).toStrictEqual([]);

    session(memberUserId, orgId, "org:admin");
    const adminRead = await accept(
      imageClient().get({ headers, params: { referenceId } }),
      [200],
    );
    expect(adminRead.body).toMatchObject({
      canManage: false,
      canModerate: true,
    });
    await accept(
      imageClient().update({
        headers,
        params: { referenceId },
        body: { title: "Admin rename" },
      }),
      [404],
    );
    const unshared = await accept(
      imageClient().update({
        headers,
        params: { referenceId },
        body: { visibility: "private" },
      }),
      [204],
    );
    expect(unshared.body).toBeUndefined();
    await accept(
      imageClient().get({ headers, params: { referenceId } }),
      [404],
    );

    session(ownerUserId, orgId);
    const ownerRead = await accept(
      imageClient().get({ headers, params: { referenceId } }),
      [200],
    );
    expect(ownerRead.body.visibility).toBe("private");
    const deleted = await accept(
      imageClient().delete({ headers, params: { referenceId } }),
      [204],
    );
    expect(deleted.body).toBeUndefined();
    expect(storedObjects.has(objectIdentity(source.bucket, source.key))).toBe(
      false,
    );
    await accept(
      imageClient().get({ headers, params: { referenceId } }),
      [404],
    );
    await accept(
      uploadClient().complete({ headers, body: { id: source.id } }),
      [404],
    );
  });

  it("rejects unknown mutation fields at the real route boundary", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const referenceId = randomUUID();
    session(userId, orgId);
    await enableReferenceImages();
    const rawRequest = setupRawAppRequest({ context, routes });
    const requestHeaders = {
      ...headers,
      "content-type": "application/json",
    };

    const responses = await Promise.all([
      rawRequest("/api/image-references", {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({
          title: "Strict create",
          sourceFileId: randomUUID(),
          visibility: "private",
          unknownField: "must fail closed",
        }),
      }),
      rawRequest(`/api/image-references/${referenceId}`, {
        method: "PATCH",
        headers: requestHeaders,
        body: JSON.stringify({
          title: "Strict update",
          unknownField: "must fail closed",
        }),
      }),
      rawRequest("/api/image-references/preview-urls", {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({
          previewAssetIds: [`irp:${randomUUID()}:invalid`],
          unknownField: "must fail closed",
        }),
      }),
    ]);
    expect(responses.map(({ status }) => status)).toStrictEqual([
      400, 400, 400,
    ]);
  });
});
