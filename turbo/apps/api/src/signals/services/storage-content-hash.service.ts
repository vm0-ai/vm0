import { createHash } from "node:crypto";

const CONTENT_HASH_V2_DOMAIN = Buffer.concat([
  Buffer.from("vm0-storage-content-hash", "ascii"),
  Buffer.from([0, 2]),
]);

export interface FileEntryWithHash {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
}

export function hashFileContent(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function computeContentHashV1FromHashes(
  storageId: string,
  files: readonly FileEntryWithHash[],
): string {
  if (files.length === 0) {
    return createHash("sha256").update(`storage:${storageId}\n`).digest("hex");
  }

  const entries = files
    .map((file) => {
      return `${file.path}:${file.hash}`;
    })
    .sort();

  return createHash("sha256")
    .update(`storage:${storageId}\n${entries.join("\n")}`)
    .digest("hex");
}

function encodeUint32(value: number): Buffer {
  const encoded = Buffer.allocUnsafe(4);
  encoded.writeUInt32BE(value);
  return encoded;
}

function encodeCountedUtf16Be(value: string): Buffer {
  const encoded = Buffer.allocUnsafe(4 + value.length * 2);
  encoded.writeUInt32BE(value.length);
  for (let index = 0; index < value.length; index += 1) {
    encoded.writeUInt16BE(value.charCodeAt(index), 4 + index * 2);
  }
  return encoded;
}

function compareUtf16(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/**
 * Canonical v2 artifact content identity. The guest-agent peer lands in #24803.
 *
 * The frame contains the fixed domain and version, a counted storage ID, the
 * file count, then counted path/hash pairs sorted by those two fields.
 * Strings are counted and encoded as UTF-16BE code units so every JavaScript
 * string, including lone surrogates, has a distinct representation.
 */
export function computeContentHashV2FromHashes(
  storageId: string,
  files: readonly FileEntryWithHash[],
): string {
  const contentHash = createHash("sha256");
  contentHash.update(CONTENT_HASH_V2_DOMAIN);
  contentHash.update(encodeCountedUtf16Be(storageId));
  contentHash.update(encodeUint32(files.length));

  const sortedFiles = [...files].sort((left, right) => {
    return (
      compareUtf16(left.path, right.path) || compareUtf16(left.hash, right.hash)
    );
  });
  for (const file of sortedFiles) {
    contentHash.update(encodeCountedUtf16Be(file.path));
    contentHash.update(encodeCountedUtf16Be(file.hash));
  }

  return contentHash.digest("hex");
}
