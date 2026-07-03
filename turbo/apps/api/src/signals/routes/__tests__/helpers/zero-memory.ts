import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { command } from "ccstate";
import type {
  TestMemoryStateActionBody,
  TestMemoryStateActionResponse,
  TestMemoryStateFixture,
  TestMemoryStateSummaryRow,
} from "@vm0/api-contracts/contracts/test-memory-state";
import type { MemoryActivityResponse } from "@vm0/api-contracts/contracts/zero-memory-activity";

import type { TestContext } from "../../../../__tests__/test-context";
import { createAppWithRoutes } from "../../../../app-factory-core";
import { testMemoryStateRoutes } from "../../test-memory-state";

const MEMORY_STATE_ROUTE = "/api/test/memory-state";

type MemoryChangeDiff =
  MemoryActivityResponse["entries"][number]["items"][number]["diff"];

export interface MemoryFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface MemorySummary {
  readonly id: string;
  readonly date: string;
  readonly fromVersionId: string | null;
  readonly toVersionId: string;
  readonly summary: string | null;
}

function requestMemoryState(
  signal: AbortSignal,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal,
    routes: testMemoryStateRoutes,
  });
  return Promise.resolve(app.request(path, init));
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function expectOk(response: Response, operation: string): void {
  if (response.ok) {
    return;
  }
  throw new Error(`${operation} failed with ${response.status}`);
}

async function postAction(
  signal: AbortSignal,
  body: TestMemoryStateActionBody,
): Promise<TestMemoryStateActionResponse> {
  const response = await requestMemoryState(
    signal,
    `${MEMORY_STATE_ROUTE}/action`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  signal.throwIfAborted();
  expectOk(response, `memory state action ${body.action}`);
  signal.throwIfAborted();
  const result = await readJson<TestMemoryStateActionResponse>(response);
  signal.throwIfAborted();
  return result;
}

function fixtureFromWire(fixture: TestMemoryStateFixture): MemoryFixture {
  return { orgId: fixture.org_id, userId: fixture.user_id };
}

function fixtureToWire(fixture: MemoryFixture): TestMemoryStateFixture {
  return { org_id: fixture.orgId, user_id: fixture.userId };
}

function summaryFromWire(row: TestMemoryStateSummaryRow): MemorySummary {
  return {
    id: row.id,
    date: row.date,
    fromVersionId: row.from_version_id,
    toVersionId: row.to_version_id,
    summary: row.summary,
  };
}

export const seedMemoryFixture$ = command(
  async (_, _input: void, signal: AbortSignal): Promise<MemoryFixture> => {
    const response = await postAction(signal, {
      action: "seed-fixture",
    });
    if (!response.fixture) {
      throw new Error("seedMemoryFixture$: response missing fixture");
    }
    return fixtureFromWire(response.fixture);
  },
);

export const deleteMemoryForFixture$ = command(
  async (_, fixture: MemoryFixture, signal: AbortSignal): Promise<void> => {
    await postAction(signal, {
      action: "delete-fixture",
      fixture: fixtureToWire(fixture),
    });
  },
);

interface MemoryActivityItemSeed {
  readonly filePath: string;
  readonly diff?: MemoryChangeDiff;
}

interface MemoryActivitySummarySeed {
  readonly orgId: string;
  readonly userId: string;
  readonly date: string;
  readonly fromVersionId?: string | null;
  readonly toVersionId: string;
  readonly summary?: string | null;
  readonly items?: readonly MemoryActivityItemSeed[];
}

function emptyMemoryChangeDiff(): MemoryChangeDiff {
  return {
    format: "line",
    beforeExists: true,
    afterExists: true,
    truncated: false,
    stats: { added: 0, removed: 0 },
    hunks: [],
  };
}

export const seedMemoryActivitySummary$ = command(
  async (
    _,
    seed: MemoryActivitySummarySeed,
    signal: AbortSignal,
  ): Promise<string> => {
    const response = await postAction(signal, {
      action: "seed-activity-summary",
      org_id: seed.orgId,
      user_id: seed.userId,
      date: seed.date,
      from_version_id: seed.fromVersionId ?? null,
      to_version_id: seed.toVersionId,
      summary: seed.summary ?? null,
      items: (seed.items ?? []).map((item) => {
        return {
          file_path: item.filePath,
          diff: item.diff ?? emptyMemoryChangeDiff(),
        };
      }),
    });
    if (!response.summary_id) {
      throw new Error("seedMemoryActivitySummary$: response missing summary");
    }
    return response.summary_id;
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
  async (_, args: MemoryStorageSeed, signal: AbortSignal): Promise<void> => {
    await postAction(signal, {
      action: "seed-storage",
      org_id: args.orgId,
      user_id: args.userId,
      s3_key: args.s3Key,
      head_version_id: args.headVersionId,
      size: args.size,
      file_count: args.fileCount,
      updated_at: args.updatedAt?.toISOString(),
      type: args.type,
      name: args.name,
    });
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

interface MemoryVersionSeed {
  readonly storageId: string;
  readonly versionId: string;
  readonly s3Key: string;
  readonly userId: string;
  readonly createdAt: Date;
}

export const seedMemoryVersion$ = command(
  async (_, args: MemoryVersionSeed, signal: AbortSignal): Promise<void> => {
    await postAction(signal, {
      action: "seed-version",
      storage_id: args.storageId,
      version_id: args.versionId,
      s3_key: args.s3Key,
      user_id: args.userId,
      created_at: args.createdAt.toISOString(),
    });
  },
);

export const findMemoryStorageId$ = command(
  async (_, orgId: string, signal: AbortSignal): Promise<string> => {
    const response = await postAction(signal, {
      action: "read-storage-id",
      org_id: orgId,
    });
    if (!response.storage_id) {
      throw new Error("Memory storage not found for org");
    }
    return response.storage_id;
  },
);

export async function updateMemoryVersionCreatedAt(
  signal: AbortSignal,
  versionId: string,
  createdAt: Date,
): Promise<void> {
  await postAction(signal, {
    action: "update-version-created-at",
    version_id: versionId,
    created_at: createdAt.toISOString(),
  });
}

export async function readMemorySummary(
  signal: AbortSignal,
  fixture: MemoryFixture,
  date: string,
): Promise<MemorySummary | null> {
  const response = await postAction(signal, {
    action: "read-summary",
    org_id: fixture.orgId,
    user_id: fixture.userId,
    date,
  });
  return response.summary ? summaryFromWire(response.summary) : null;
}

export async function readMemorySummaries(
  signal: AbortSignal,
  fixture: MemoryFixture,
): Promise<readonly MemorySummary[]> {
  const response = await postAction(signal, {
    action: "read-summaries",
    org_id: fixture.orgId,
    user_id: fixture.userId,
  });
  return (response.summaries ?? []).map(summaryFromWire);
}

export async function readMemoryItems(
  signal: AbortSignal,
  summaryId: string,
): Promise<readonly string[]> {
  const response = await postAction(signal, {
    action: "read-items",
    summary_id: summaryId,
  });
  return response.file_paths ?? [];
}

interface MemoryVersionContent {
  readonly s3Key: string;
  readonly files: readonly MemoryFile[];
}

/**
 * Mock S3 for several memory versions at once, each keyed by its own s3Key.
 * Per-file manifest hashes are content-derived so the diff service classifies
 * `updated` only when a file's content actually changes between versions.
 */
export function mockMemoryVersions(
  context: TestContext,
  versions: readonly MemoryVersionContent[],
): void {
  const byKey = new Map<string, Buffer>();
  for (const version of versions) {
    const files = version.files.map((file) => {
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
          hash: createHash("sha256").update(file.content).digest("hex"),
          size: file.content.length,
        };
      }),
      totalSize: files.reduce((sum, file) => {
        return sum + file.content.length;
      }, 0),
      fileCount: files.length,
    };
    byKey.set(
      `${version.s3Key}/manifest.json`,
      Buffer.from(JSON.stringify(manifest), "utf8"),
    );
    byKey.set(`${version.s3Key}/archive.tar.gz`, archive);
  }

  context.mocks.s3.send.mockImplementation((cmd: unknown): Promise<unknown> => {
    const body = byKey.get(commandKey(cmd));
    if (body) {
      return Promise.resolve({ Body: asyncIterableOf(body) });
    }
    return Promise.resolve({});
  });
}
