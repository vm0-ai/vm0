import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type { TestContext } from "../../../../__tests__/test-context";

/**
 * Disk-backed fake R2 for chat-event snapshot objects. Objects are
 * content-addressed (the key embeds the body hash), so a shared directory
 * stays valid across vitest workers, test files, and repeated local runs —
 * a head row persisted by one process can always re-download its object from
 * another, mirroring the durability the archiver assumes of real R2.
 */
const OBJECT_DIR = join(tmpdir(), "vm0-test-chat-event-snapshots");

function objectPath(key: string): string {
  return join(OBJECT_DIR, Buffer.from(key).toString("base64url"));
}

function storedObjectKeys(): readonly string[] {
  if (!existsSync(OBJECT_DIR)) {
    return [];
  }
  return readdirSync(OBJECT_DIR).map((name) => {
    return Buffer.from(name, "base64url").toString("utf8");
  });
}

export function writeFakeChatEventObject(key: string, body: Buffer): void {
  mkdirSync(OBJECT_DIR, { recursive: true });
  writeFileSync(objectPath(key), body);
}

export function readFakeChatEventObject(key: string): Buffer | undefined {
  const path = objectPath(key);
  if (!existsSync(path)) {
    return undefined;
  }
  return readFileSync(path);
}

export function ageFakeChatEventObject(key: string, modifiedAt: Date): void {
  const path = objectPath(key);
  if (!existsSync(path)) {
    throw new Error(`missing fake R2 object: ${key}`);
  }
  utimesSync(path, modifiedAt, modifiedAt);
}

export interface RecordedChatEventPut {
  readonly bucket: string;
  readonly key: string;
  readonly contentType: string | undefined;
  readonly contentEncoding: string | undefined;
  readonly body: Buffer;
}

export const FAKE_CHAT_EVENT_SNAPSHOT_URL =
  "https://r2.example.com/chat-events?sig=test";

interface FakeS3CommandRecord {
  readonly constructor: { readonly name: string };
  readonly input?: {
    readonly Bucket?: string;
    readonly Key?: string;
    readonly Body?: unknown;
    readonly ContentType?: string;
    readonly ContentEncoding?: string;
    readonly Prefix?: string;
    readonly MaxKeys?: number;
    readonly Delete?: {
      readonly Objects?: readonly { readonly Key?: string }[];
    };
    readonly CORSConfiguration?: {
      readonly CORSRules?: readonly unknown[];
    };
  };
}

function fakePutObject(
  record: FakeS3CommandRecord,
  key: string,
  recordedPuts?: RecordedChatEventPut[],
) {
  const body = record.input?.Body;
  if (!Buffer.isBuffer(body)) {
    throw new Error("expected a Buffer body for chat-events puts");
  }
  writeFakeChatEventObject(key, body);
  recordedPuts?.push({
    bucket: record.input?.Bucket ?? "",
    key,
    contentType: record.input?.ContentType,
    contentEncoding: record.input?.ContentEncoding,
    body,
  });
  return Promise.resolve({});
}

function fakeGetObject(key: string) {
  const stored = readFakeChatEventObject(key);
  if (stored === undefined) {
    return Promise.reject(new Error(`missing fake R2 object: ${key}`));
  }
  return Promise.resolve({
    Body: Readable.from([stored]),
    ContentLength: stored.length,
  });
}

function fakeListObjects(record: FakeS3CommandRecord) {
  const prefix = record.input?.Prefix ?? "";
  const maxKeys = record.input?.MaxKeys ?? 1000;
  const matching = storedObjectKeys()
    .filter((objectKey) => {
      return objectKey.startsWith(prefix);
    })
    .sort();
  return Promise.resolve({
    Contents: matching.slice(0, maxKeys).map((objectKey) => {
      const path = objectPath(objectKey);
      const stat = statSync(path);
      return {
        Key: objectKey,
        Size: stat.size,
        LastModified: stat.mtime,
      };
    }),
    IsTruncated: matching.length > maxKeys,
  });
}

function fakeDeleteObjects(record: FakeS3CommandRecord) {
  for (const object of record.input?.Delete?.Objects ?? []) {
    if (!object.Key) {
      continue;
    }
    const path = objectPath(object.Key);
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
  return Promise.resolve({ Errors: [] });
}

interface FakeChatEventR2Options {
  /**
   * Answers the CORS control-plane commands with `AccessDenied`, the way an R2
   * credential that may only read and write objects does.
   */
  readonly denyBucketCors?: boolean;
}

function accessDeniedError(): Error {
  return Object.assign(new Error("Access Denied"), {
    name: "AccessDenied",
    Code: "AccessDenied",
  });
}

function handleFakeS3Command(
  command: unknown,
  corsRulesByBucket: Map<string, readonly unknown[]>,
  options: FakeChatEventR2Options,
  recordedPuts?: RecordedChatEventPut[],
) {
  const record = command as FakeS3CommandRecord;
  const commandName = record.constructor.name;
  const key = record.input?.Key;
  if (key?.startsWith("chat-events/") === true) {
    if (commandName === "PutObjectCommand") {
      return fakePutObject(record, key, recordedPuts);
    }
    if (commandName === "GetObjectCommand") {
      return fakeGetObject(key);
    }
  }
  if (commandName === "ListObjectsV2Command") {
    return fakeListObjects(record);
  }
  if (
    options.denyBucketCors === true &&
    (commandName === "GetBucketCorsCommand" ||
      commandName === "PutBucketCorsCommand")
  ) {
    return Promise.reject(accessDeniedError());
  }
  if (commandName === "GetBucketCorsCommand") {
    return Promise.resolve({
      CORSRules: corsRulesByBucket.get(record.input?.Bucket ?? "") ?? [],
    });
  }
  if (commandName === "PutBucketCorsCommand") {
    corsRulesByBucket.set(
      record.input?.Bucket ?? "",
      record.input?.CORSConfiguration?.CORSRules ?? [],
    );
    return Promise.resolve({});
  }
  if (commandName === "DeleteObjectsCommand") {
    return fakeDeleteObjects(record);
  }
  return Promise.resolve({ ContentLength: 1024 });
}

export function installFakeChatEventR2(
  context: TestContext,
  recordedPuts?: RecordedChatEventPut[],
  options: FakeChatEventR2Options = {},
): void {
  const corsRulesByBucket = new Map<string, readonly unknown[]>();
  // The suite-wide mock reset primes getSignedUrl in afterEach, so the first
  // test of a file starts unprimed; presigned downloads are part of this fake.
  context.mocks.s3.getSignedUrl.mockResolvedValue(FAKE_CHAT_EVENT_SNAPSHOT_URL);
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    return handleFakeS3Command(
      command,
      corsRulesByBucket,
      options,
      recordedPuts,
    );
  });
}
