import { createHash, type Hash } from "node:crypto";

const STORAGE_CONTENT_HASH_PREFIX = "vm0-storage-content-hash-v2\0";
const SYSTEM_SKILL_CONTENT_HASH_PREFIX = "vm0-system-skill-content-hash-v2\0";
const SHA256_HEX_PATTERN = /^[a-fA-F0-9]{64}$/;

export interface FileEntryWithHash {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
}

export function hashFileContent(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function u32be(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0 || value > 4_294_967_295) {
    throw new Error(`Value ${value} cannot be encoded as u32`);
  }
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function sha256DigestFromHex(hash: string): Buffer {
  if (!SHA256_HEX_PATTERN.test(hash)) {
    throw new Error("File hash must be SHA-256 hex");
  }
  return Buffer.from(hash, "hex");
}

function updateLengthPrefixedBytes(hasher: Hash, bytes: Buffer): void {
  hasher.update(u32be(bytes.length));
  hasher.update(bytes);
}

function compareCanonicalEntries(
  a: CanonicalFileEntry,
  b: CanonicalFileEntry,
): number {
  const pathOrder = Buffer.compare(a.pathBytes, b.pathBytes);
  if (pathOrder !== 0) {
    return pathOrder;
  }
  return Buffer.compare(a.hashBytes, b.hashBytes);
}

interface CanonicalFileEntry {
  readonly pathBytes: Buffer;
  readonly hashBytes: Buffer;
}

function computeCanonicalFileListHash(
  domainPrefix: string,
  subjectId: string,
  files: readonly FileEntryWithHash[],
): string {
  const entries = files
    .map((file) => {
      return {
        pathBytes: Buffer.from(file.path, "utf8"),
        hashBytes: sha256DigestFromHex(file.hash),
      };
    })
    .sort(compareCanonicalEntries);

  const hasher = createHash("sha256");
  hasher.update(domainPrefix, "utf8");
  updateLengthPrefixedBytes(hasher, Buffer.from(subjectId, "utf8"));
  hasher.update(u32be(entries.length));
  for (const entry of entries) {
    updateLengthPrefixedBytes(hasher, entry.pathBytes);
    hasher.update(entry.hashBytes);
  }
  return hasher.digest("hex");
}

export function computeContentHashFromHashes(
  storageId: string,
  files: readonly FileEntryWithHash[],
): string {
  return computeCanonicalFileListHash(
    STORAGE_CONTENT_HASH_PREFIX,
    storageId,
    files,
  );
}

export function computeSystemSkillContentHash(
  skillUrl: string,
  files: readonly FileEntryWithHash[],
): string {
  return computeCanonicalFileListHash(
    SYSTEM_SKILL_CONTENT_HASH_PREFIX,
    skillUrl,
    files,
  );
}
