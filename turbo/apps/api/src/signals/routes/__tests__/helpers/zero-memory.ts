import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

import { MEMORY_ARTIFACT_NAME } from "@vm0/core/storage-names";
import { command } from "ccstate";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { eq } from "drizzle-orm";

import type { TestContext } from "../../../../__tests__/test-helpers";
import { writeDb$ } from "../../../external/db";

export interface MemoryFixture {
  readonly orgId: string;
  readonly userId: string;
}

export const seedMemoryFixture$ = command(
  async (
    { set },
    _input: void,
    signal: AbortSignal,
  ): Promise<MemoryFixture> => {
    const db = set(writeDb$);
    const fixture = {
      orgId: `org_${randomUUID()}`,
      userId: `user_${randomUUID()}`,
    };
    await db.insert(orgMetadata).values({
      orgId: fixture.orgId,
      tier: "free",
      credits: 10_000,
    });
    signal.throwIfAborted();
    return fixture;
  },
);

export const deleteMemoryForFixture$ = command(
  async (
    { set },
    fixture: MemoryFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    // Storage cascade deletes storage_versions via FK.
    await db.delete(storages).where(eq(storages.orgId, fixture.orgId));
    signal.throwIfAborted();
    await db.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
    signal.throwIfAborted();
  },
);

interface MemoryStorageSeed {
  readonly orgId: string;
  readonly userId: string;
  readonly s3Key: string;
  readonly headVersionId?: string | null;
  readonly size?: number;
  readonly fileCount?: number;
  readonly updatedAt?: Date;
  readonly type?: string;
  readonly name?: string;
}

export const seedMemoryStorage$ = command(
  async (
    { set },
    args: MemoryStorageSeed,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const storageId = randomUUID();
    const name = args.name ?? MEMORY_ARTIFACT_NAME;

    await db.insert(storages).values({
      id: storageId,
      userId: args.userId,
      name,
      type: args.type ?? "artifact",
      orgId: args.orgId,
      s3Prefix: `orgs/${args.orgId}/users/${args.userId}/${name}`,
      size: args.size ?? 0,
      fileCount: args.fileCount ?? 0,
      updatedAt: args.updatedAt ?? new Date("2025-01-01T00:00:00.000Z"),
    });
    signal.throwIfAborted();

    if (args.headVersionId === null) {
      return;
    }

    const headVersionId = args.headVersionId ?? `head-${randomUUID()}`;
    await db.insert(storageVersions).values({
      id: headVersionId,
      storageId,
      s3Key: args.s3Key,
      createdBy: args.userId,
    });
    signal.throwIfAborted();

    await db
      .update(storages)
      .set({ headVersionId })
      .where(eq(storages.id, storageId));
    signal.throwIfAborted();
  },
);

interface MemoryFile {
  readonly path: string;
  readonly content: string;
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
      return Promise.resolve({ Body: asyncIterableOf(manifestBuffer) });
    }
    if (key === `${args.s3Key}/archive.tar.gz`) {
      return Promise.resolve({ Body: asyncIterableOf(archive) });
    }
    return Promise.resolve({});
  });
}
