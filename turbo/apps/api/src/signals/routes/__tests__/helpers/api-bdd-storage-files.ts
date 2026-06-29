import { createHash } from "node:crypto";

export interface BddStorageFileEntry {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
}

export function storageTextFile(
  path: string,
  content: string,
): BddStorageFileEntry {
  const bytes = Buffer.from(content, "utf8");
  return {
    path,
    hash: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  };
}
