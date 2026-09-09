import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { featureSwitchesRoutes } from "../feature-switches";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsMultipartRoutes } from "../uploads-multipart";
import { webDownloadRoutes } from "../web-download";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const routes = Object.freeze([
  ...featureSwitchesRoutes,
  ...uploadsPrepareRoutes,
  ...uploadsCompleteRoutes,
  ...uploadsMultipartRoutes,
  ...webDownloadRoutes,
]);
const encodings = Object.freeze([
  {
    requested: "Text/Plain; Charset=UTF-8",
    expected: "text/plain;charset=UTF-8",
    bytes: Buffer.from("中文 😀"),
  },
  {
    requested: 'text/plain; charset="gbk"',
    expected: "text/plain;charset=gbk",
    bytes: Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
  },
  {
    requested: "text/plain; charset=utf-16le",
    expected: "text/plain;charset=utf-16le",
    bytes: Buffer.from("中文 😀", "utf16le"),
  },
  {
    requested: "application/x-unknown; charset=utf-8",
    expected: "application/octet-stream",
    bytes: Buffer.from([0, 255, 1, 2]),
  },
  {
    requested: "text/plain",
    expected: "text/plain",
    bytes: Buffer.from([0xd6, 0xd0]),
  },
]);

describe.each([
  { privateFile: false, multipart: false },
  { privateFile: false, multipart: true },
  { privateFile: true, multipart: false },
  { privateFile: true, multipart: true },
])(
  "upload metadata (private=$privateFile, multipart=$multipart)",
  ({ privateFile, multipart }) => {
    it.each(encodings)(
      "retains $expected through prepare, complete and download",
      async ({ requested, expected, bytes: sample }) => {
        const bytes = multipart
          ? Buffer.concat([
              sample,
              Buffer.alloc(5 * 1024 * 1024 - sample.length, 32),
            ])
          : sample;
        mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
        const api = setupApp({ context, routes });
        if (privateFile) {
          await accept(
            api(featureSwitchesContract).update({
              headers,
              body: { switches: { [FeatureSwitchKey.PrivateArtifacts]: true } },
            }),
            [200],
          );
        }
        let stored: PutObjectCommandInput | undefined;
        const deliveries: string[] = [];
        const size = bytes.length;
        context.mocks.s3.getSignedUrl.mockImplementation((_client, command) => {
          if (command instanceof PutObjectCommand) {
            stored = command.input;
          }
          return Promise.resolve("https://r2.example/upload");
        });
        context.mocks.s3.send.mockImplementation((command) => {
          if (command instanceof ListObjectsV2Command) {
            return Promise.resolve({
              Contents: stored
                ? [
                    {
                      Key: stored.Key,
                      Size: size,
                      LastModified: new Date("2026-09-09T00:00:00Z"),
                    },
                  ]
                : [],
            });
          }
          if (command instanceof CreateMultipartUploadCommand) {
            stored = command.input;
            return Promise.resolve({ UploadId: "encoding-upload" });
          }
          if (command instanceof ListPartsCommand) {
            return Promise.resolve({
              Parts: [{ PartNumber: 1, ETag: '"part-1"', Size: size }],
            });
          }
          if (command instanceof CompleteMultipartUploadCommand) {
            return Promise.resolve({});
          }
          if (
            command instanceof HeadObjectCommand ||
            command instanceof GetObjectCommand
          ) {
            return Promise.resolve({
              ContentType: stored?.ContentType,
              ContentLength: bytes.length,
              LastModified: new Date("2026-09-09T00:00:00Z"),
              Metadata: stored?.Metadata,
              Body: Readable.from([bytes]),
            });
          }
          if (
            command instanceof PutObjectCommand &&
            typeof command.input.Body === "string"
          ) {
            deliveries.push(command.input.Body);
            return Promise.resolve({});
          }
          throw new Error("Unexpected storage request");
        });
        const prepared = await accept(
          api(uploadsContract).prepare({
            headers,
            body: {
              filename: "encoded.txt",
              size,
              contentType: requested,
              ...(multipart ? { multipart: true as const } : {}),
              ...(privateFile ? { purpose: "artifact" as const } : {}),
            },
          }),
          [200],
        );
        expect(prepared.body.contentType).toBe(expected);
        expect(stored?.ContentType).toBe(expected);
        if (multipart) {
          if (!("multipart" in prepared.body)) {
            throw new Error("Expected multipart upload");
          }
          await accept(
            api(uploadsContract).completeMultipart({
              headers,
              body: {
                id: prepared.body.id,
                filename: "encoded.txt",
                uploadId: prepared.body.multipart.uploadId,
                partCount: 1,
              },
            }),
            [200],
          );
        } else {
          if (!("uploadHeaders" in prepared.body)) {
            throw new Error("Expected single upload");
          }
          expect(
            new Headers({
              "content-type": prepared.body.contentType,
              ...prepared.body.uploadHeaders,
            }).get("content-type"),
          ).toBe(expected);
        }
        const completed = await accept(
          api(uploadsContract).complete({
            headers,
            body: { id: prepared.body.id, contentType: requested },
          }),
          [200],
        );
        expect(completed.body.contentType).toBe(expected);
        const downloaded = await accept(
          api(webFilesContract).download({
            headers,
            query: { file_id: prepared.body.id },
          }),
          [200],
        );
        expect(downloaded.headers.get("content-type")).toBe(expected);
        expect(downloaded.headers.get("content-length")).toBe(
          String(bytes.length),
        );
        if (expected.startsWith("text/")) {
          expect(downloaded.body).toBe(bytes.toString("utf8"));
        } else {
          expect(
            Buffer.compare(
              Buffer.from(await downloaded.body.arrayBuffer()),
              bytes,
            ),
          ).toBe(0);
        }
        if (privateFile) {
          expect(downloaded.headers.get("content-disposition")).toBe(
            "attachment; filename*=UTF-8''encoded.txt",
          );
          expect(downloaded.headers.get("x-content-type-options")).toBe(
            "nosniff",
          );
        } else {
          expect(deliveries.length).toBeGreaterThan(0);
          for (const delivery of deliveries) {
            expect(JSON.parse(delivery)).toMatchObject({
              contentType: expected,
            });
          }
        }
      },
    );
  },
);
