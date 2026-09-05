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
const OBJECT_DIR = join(tmpdir(), "okou-test-chat-event-snapshots");

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

export function deleteFakeChatEventObject(key: string): Promise<void> {
  const path = objectPath(key);
  if (existsSync(path)) {
    unlinkSync(path);
  }
  return Promise.resolve();
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
  };
}

function fakePutObject(
  record: FakeS3CommandRecord,
  key: string,
  recordedPuts?: RecordedChatEventPut[],
  beforePut?: (put: RecordedChatEventPut) => Promise<void>,
) {
  const body = record.input?.Body;
  if (!Buffer.isBuffer(body)) {
    throw new Error("expected a Buffer body for chat-events puts");
  }
  const put = {
    bucket: record.input?.Bucket ?? "",
    key,
    contentType: record.input?.ContentType,
    contentEncoding: record.input?.ContentEncoding,
    body,
  };
  return (async () => {
    await beforePut?.(put);
    writeFakeChatEventObject(key, body);
    recordedPuts?.push(put);
    return {};
  })();
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

async function fakeDeleteObjects(
  record: FakeS3CommandRecord,
  beforeDelete?: () => Promise<void>,
) {
  await beforeDelete?.();
  for (const object of record.input?.Delete?.Objects ?? []) {
    if (!object.Key) {
      continue;
    }
    const path = objectPath(object.Key);
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
  return { Errors: [] };
}

function handleFakeS3Command(
  command: unknown,
  recordedPuts?: RecordedChatEventPut[],
  beforePut?: (put: RecordedChatEventPut) => Promise<void>,
  beforeDelete?: () => Promise<void>,
) {
  const record = command as FakeS3CommandRecord;
  const commandName = record.constructor.name;
  const key = record.input?.Key;
  if (key?.startsWith("chat-events/") === true) {
    if (commandName === "PutObjectCommand") {
      return fakePutObject(record, key, recordedPuts, beforePut);
    }
    if (commandName === "GetObjectCommand") {
      return fakeGetObject(key);
    }
  }
  if (commandName === "ListObjectsV2Command") {
    return fakeListObjects(record);
  }
  if (commandName === "DeleteObjectsCommand") {
    return fakeDeleteObjects(record, beforeDelete);
  }
  return Promise.resolve({ ContentLength: 1024 });
}

export function installFakeChatEventR2(
  context: TestContext,
  recordedPuts?: RecordedChatEventPut[],
  beforePut?: (put: RecordedChatEventPut) => Promise<void>,
  beforeDelete?: () => Promise<void>,
): void {
  // The suite-wide mock reset primes getSignedUrl in afterEach, so the first
  // test of a file starts unprimed; presigned downloads are part of this fake.
  context.mocks.s3.getSignedUrl.mockResolvedValue(FAKE_CHAT_EVENT_SNAPSHOT_URL);
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    return handleFakeS3Command(command, recordedPuts, beforePut, beforeDelete);
  });
}
