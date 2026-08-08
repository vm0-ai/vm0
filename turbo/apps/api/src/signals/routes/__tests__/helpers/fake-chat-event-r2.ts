import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export function writeFakeChatEventObject(key: string, body: Buffer): void {
  mkdirSync(OBJECT_DIR, { recursive: true });
  writeFileSync(objectPath(key), body);
}

function readFakeChatEventObject(key: string): Buffer | undefined {
  const path = objectPath(key);
  if (!existsSync(path)) {
    return undefined;
  }
  return readFileSync(path);
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

export function installFakeChatEventR2(
  context: TestContext,
  recordedPuts?: RecordedChatEventPut[],
): void {
  // The suite-wide mock reset primes getSignedUrl in afterEach, so the first
  // test of a file starts unprimed; presigned downloads are part of this fake.
  context.mocks.s3.getSignedUrl.mockResolvedValue(FAKE_CHAT_EVENT_SNAPSHOT_URL);
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const record = command as {
      readonly constructor: { readonly name: string };
      readonly input?: {
        readonly Bucket?: string;
        readonly Key?: string;
        readonly Body?: unknown;
        readonly ContentType?: string;
        readonly ContentEncoding?: string;
      };
    };
    const key = record.input?.Key;
    if (key?.startsWith("chat-events/") === true) {
      if (record.constructor.name === "PutObjectCommand") {
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
      if (record.constructor.name === "GetObjectCommand") {
        const stored = readFakeChatEventObject(key);
        if (stored === undefined) {
          return Promise.reject(new Error(`missing fake R2 object: ${key}`));
        }
        return Promise.resolve({
          Body: Readable.from([stored]),
          ContentLength: stored.length,
        });
      }
    }
    return Promise.resolve({ ContentLength: 1024 });
  });
}
