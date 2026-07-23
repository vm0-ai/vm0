import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { MEMORY_ARTIFACT_NAME } from "@vm0/core/storage-names";

import type { TestContext } from "../../../../__tests__/test-context";
import { readStorageS3PrefixFixture } from "../../../../test-fixtures/storage";
import type { ApiTestUser } from "./api-bdd";
import { createStoragesBddApi } from "./api-bdd-storages";

interface MemoryFile {
  readonly path: string;
  readonly content: string;
}

interface CommittedMemoryVersion {
  readonly versionId: string;
  readonly s3Key: string;
}

/**
 * Create (or dedupe onto) a memory artifact version through the product
 * storage upload flow: `POST /api/storages/prepare` + `POST
 * /api/storages/commit` as the given actor. Returns the content-addressed
 * version id and the S3 key the product assigned to it.
 */
export async function commitMemoryVersion(
  context: TestContext,
  actor: ApiTestUser,
  files: readonly MemoryFile[],
): Promise<CommittedMemoryVersion> {
  if (!actor.orgId) {
    throw new Error("commitMemoryVersion requires an actor with an org");
  }
  const storagesApi = createStoragesBddApi(context);
  const entries = files.map((file) => {
    const content = Buffer.from(file.content, "utf8");
    return {
      path: file.path,
      hash: createHash("sha256").update(content).digest("hex"),
      size: content.length,
    };
  });

  const prepared = await storagesApi.prepareStorage(actor, {
    storageName: MEMORY_ARTIFACT_NAME,
    storageType: "artifact",
    files: entries,
  });
  storagesApi.mockStorageObjectExistsOnce();
  storagesApi.mockStorageObjectExistsOnce();
  await storagesApi.commitStorage(actor, {
    storageName: MEMORY_ARTIFACT_NAME,
    storageType: "artifact",
    versionId: prepared.versionId,
    files: entries,
  });

  const s3Prefix = await readStorageS3PrefixFixture({
    orgId: actor.orgId,
    userId: actor.userId,
    name: MEMORY_ARTIFACT_NAME,
  });
  return {
    versionId: prepared.versionId,
    s3Key: `${s3Prefix}/${prepared.versionId}`,
  };
}

interface MemoryContentMockArgs {
  readonly s3Key: string;
  readonly files: readonly MemoryFile[];
}

const TAR_BLOCK_SIZE = 512;

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

function createTarEntry(filename: string, content: Buffer): Buffer {
  // POSIX tar header (USTAR-compatible) is sufficient for extractFilesFromTarGz
  // to parse the filename, size, and payload.
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  header.write(filename, 0, 100, "utf8");
  header.write("0000644\0", 100); // mode
  header.write("0000000\0", 108); // uid
  header.write("0000000\0", 116); // gid
  header.write(octal(content.length, 12), 124); // size
  header.write(octal(0, 12), 136); // mtime
  // Checksum placeholder: 8 spaces required so the checksum sum is correct.
  header.write("        ", 148);
  header.write("0", 156); // type flag (regular file)

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  // Final checksum: 6 octal digits, NUL, space.
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);

  const padding = content.length % TAR_BLOCK_SIZE;
  const dataBlocks =
    padding === 0
      ? content
      : Buffer.concat([content, Buffer.alloc(TAR_BLOCK_SIZE - padding)]);

  return Buffer.concat([header, dataBlocks]);
}

function createTarGz(
  files: readonly { readonly filename: string; readonly content: Buffer }[],
): Buffer {
  const eofBlocks = Buffer.alloc(TAR_BLOCK_SIZE * 2);
  return gzipSync(
    Buffer.concat([
      ...files.map((file) => {
        return createTarEntry(file.filename, file.content);
      }),
      eofBlocks,
    ]),
  );
}

function asyncIterableOf(buffer: Buffer): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield buffer;
    },
  };
}

function commandKey(command: unknown): string {
  if (
    typeof command !== "object" ||
    command === null ||
    !("input" in command)
  ) {
    return "";
  }
  const input = (command as { input: unknown }).input;
  if (
    typeof input !== "object" ||
    input === null ||
    !("Key" in input) ||
    typeof (input as { Key: unknown }).Key !== "string"
  ) {
    return "";
  }
  return (input as { Key: string }).Key;
}

function commandName(command: unknown): string {
  return typeof command === "object" && command !== null
    ? command.constructor.name
    : "";
}

export function mockMemoryContent(
  context: TestContext,
  args: MemoryContentMockArgs,
): void {
  const files = args.files.map((file) => {
    return { path: file.path, content: Buffer.from(file.content, "utf8") };
  });
  const archive = createTarGz(
    files.map((file) => {
      return { filename: file.path, content: file.content };
    }),
  );

  const manifest = {
    version: "test-version",
    createdAt: new Date(0).toISOString(),
    files: files.map((file) => {
      return {
        path: file.path,
        hash: "test-hash-memory",
        size: file.content.length,
      };
    }),
    totalSize: files.reduce((sum, file) => {
      return sum + file.content.length;
    }, 0),
    fileCount: files.length,
  };
  const manifestBuffer = Buffer.from(JSON.stringify(manifest), "utf8");

  context.mocks.s3.send.mockImplementation((cmd: unknown): Promise<unknown> => {
    const key = commandKey(cmd);
    if (key === `${args.s3Key}/manifest.json`) {
      if (commandName(cmd) === "HeadObjectCommand") {
        return Promise.resolve({ ContentLength: manifestBuffer.length });
      }
      return Promise.resolve({ Body: asyncIterableOf(manifestBuffer) });
    }
    if (key === `${args.s3Key}/archive.tar.gz`) {
      if (commandName(cmd) === "HeadObjectCommand") {
        return Promise.resolve({ ContentLength: archive.length });
      }
      return Promise.resolve({ Body: asyncIterableOf(archive) });
    }
    return Promise.resolve({});
  });
}
