import { Readable } from "node:stream";

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import {
  imageReferencesContract,
  type ImageReference,
  type UpdateImageReferenceBody,
} from "@okouai/api-contracts/contracts/image-references";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { imageReferencesRoutes } from "../../image-references";
import { uploadsCompleteRoutes } from "../../uploads-complete";
import { uploadsPrepareRoutes } from "../../uploads-prepare";
import type { ApiTestUser } from "./api-bdd";
import { createRouteMocks } from "./route-test";

const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const validPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z0YQAAAAASUVORK5CYII=",
  "base64",
);
const routes = Object.freeze([
  ...uploadsPrepareRoutes,
  ...uploadsCompleteRoutes,
  ...imageReferencesRoutes,
]);

interface StoredObject {
  readonly id: string;
  readonly bucket: string;
  readonly key: string;
  readonly contentType: string;
  readonly body: Buffer;
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

function objectIdentity(bucket: string, key: string): string {
  return `${bucket}\u0000${key}`;
}

export function createImageReferencesBddApi(context: TestContext) {
  const mocks = createRouteMocks(context);
  const storedObjects = new Map<string, StoredObject>();
  let signedUrlSequence = 0;

  function authenticate(actor: ApiTestUser): void {
    if (!actor.orgId) {
      throw new Error("Image reference tests require an organization");
    }
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  }

  function installStorage(): void {
    context.mocks.s3.send.mockImplementation((command: unknown) => {
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
            Object.assign(new Error("Missing test object"), {
              name: "NotFound",
            }),
          );
        }
        return Promise.resolve({
          ContentLength: object.body.length,
          ContentType: object.contentType,
          Metadata: { "artifact-id": object.id },
        });
      }
      if (command instanceof GetObjectCommand) {
        if (!object) {
          return Promise.reject(
            Object.assign(new Error("Missing test object"), {
              name: "NoSuchKey",
            }),
          );
        }
        return Promise.resolve({
          ContentLength: object.body.length,
          ContentType: object.contentType,
          Body: Readable.from([object.body]),
        });
      }
      if (command instanceof DeleteObjectsCommand) {
        const deletion = input.Delete;
        const objects =
          typeof deletion === "object" &&
          deletion !== null &&
          "Objects" in deletion &&
          Array.isArray(deletion.Objects)
            ? deletion.Objects
            : [];
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
        return Promise.resolve({});
      }
      throw new Error(`Unexpected storage request: ${String(command)}`);
    });
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
  }

  function imageClient() {
    return setupApp({ context, routes })(imageReferencesContract);
  }

  function uploadClient() {
    return setupApp({ context, routes })(uploadsContract);
  }

  return {
    async createReference(
      actor: ApiTestUser,
      options: {
        readonly title?: string;
        readonly visibility?: "private" | "public";
      } = {},
    ): Promise<ImageReference> {
      authenticate(actor);
      installStorage();
      const prepared = await accept(
        uploadClient().prepare({
          headers,
          body: {
            filename: "chat-reference.png",
            contentType: "image/png",
            size: validPng.length,
            purpose: "image-reference",
          },
        }),
        [200],
      );
      const signedCommand =
        context.mocks.s3.getSignedUrl.mock.calls.at(-1)?.[1];
      const input = commandInput(signedCommand);
      const bucket = typeof input.Bucket === "string" ? input.Bucket : null;
      const key = typeof input.Key === "string" ? input.Key : null;
      if (!bucket || !key) {
        throw new Error("Prepared image upload did not sign a bucket and key");
      }
      storedObjects.set(objectIdentity(bucket, key), {
        id: prepared.body.id,
        bucket,
        key,
        contentType: "image/png",
        body: validPng,
      });
      await accept(
        uploadClient().complete({
          headers,
          body: { id: prepared.body.id },
        }),
        [200],
      );
      const created = await accept(
        imageClient().create({
          headers,
          body: {
            sourceFileId: prepared.body.id,
            title: options.title ?? "Chat reference",
            visibility: options.visibility ?? "private",
          },
        }),
        [201],
      );
      return created.body;
    },

    async updateReference(
      actor: ApiTestUser,
      referenceId: string,
      body: UpdateImageReferenceBody,
    ): Promise<void> {
      authenticate(actor);
      installStorage();
      await accept(
        imageClient().update({
          headers,
          params: { referenceId },
          body,
        }),
        [200, 204],
      );
    },

    async deleteReference(
      actor: ApiTestUser,
      referenceId: string,
    ): Promise<void> {
      authenticate(actor);
      installStorage();
      await accept(
        imageClient().delete({
          headers,
          params: { referenceId },
        }),
        [204],
      );
    },
  };
}
