import { createHash } from "node:crypto";
import { posix } from "node:path";
import { gunzipSync, gzipSync, inflateRawSync } from "node:zlib";

import {
  MAX_FILE_SIZE_BYTES,
  STORAGE_MANIFEST_MAX_FILES,
  STORAGE_MANIFEST_MAX_PATH_BYTES,
} from "@okouai/api-contracts/contracts/storages";
import {
  PI_MEMORY_PHASE2_PREPARED_MAX_BYTES,
  type PiMemoryPhase2BaseFile,
  type PiMemoryPhase2ConsolidationResult,
  type PiMemoryPhase2PreparedFile,
} from "@okouai/pi-agent-runtime/api";

import { safeJsonParse, safeSync } from "../utils";
import { computeContentHashFromHashes } from "./storage-content-hash.service";

export const PI_MEMORY_PHASE2_MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
const TAR_BLOCK_BYTES = 512;
const TAR_MAX_ENTRY_OVERHEAD_BYTES = TAR_BLOCK_BYTES * 4 + 64;
const PI_MEMORY_PHASE2_TAR_MAX_BYTES =
  PI_MEMORY_PHASE2_PREPARED_MAX_BYTES +
  STORAGE_MANIFEST_MAX_PATH_BYTES +
  STORAGE_MANIFEST_MAX_FILES * TAR_MAX_ENTRY_OVERHEAD_BYTES +
  1024;
export const PI_MEMORY_PHASE2_ARCHIVE_MAX_BYTES =
  PI_MEMORY_PHASE2_TAR_MAX_BYTES + 1024 * 1024;

const SAFE_SHA256 = /^[a-f0-9]{64}$/u;
const WINDOWS_DRIVE = /^[A-Za-z]:/u;
const MANIFEST_DIGEST_ENCODING = "vm0.pi-memory.phase2.manifest.v1";

interface ArchiveFile {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
  readonly bytes: Buffer;
}

interface CanonicalManifest {
  readonly version: 1;
  readonly files: readonly Readonly<{
    readonly path: string;
    readonly hash: string;
    readonly size: number;
  }>[];
  readonly createdAt: string;
}

export interface PiMemoryPhase2ArchiveIdentity {
  readonly files: readonly PiMemoryPhase2BaseFile[];
  readonly versionId: string;
  readonly size: number;
  readonly archiveSize: number;
  readonly fileCount: number;
}

export interface PreparedPiMemoryPhase2Archive extends PiMemoryPhase2ArchiveIdentity {
  readonly manifestBytes: Buffer;
  readonly archiveBytes: Buffer;
}

export class PiMemoryPhase2ArchiveError extends Error {
  constructor(readonly errorClass: string) {
    super("Pi memory Phase 2 archive validation failed");
    this.name = "PiMemoryPhase2ArchiveError";
  }
}

function fail(errorClass: string): never {
  throw new PiMemoryPhase2ArchiveError(errorClass);
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function safePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    WINDOWS_DRIVE.test(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.includes("//") ||
    posix.normalize(path) !== path ||
    Buffer.from(path, "utf8").toString("utf8") !== path
  ) {
    return false;
  }
  return path.split("/").every((part) => {
    return part.length > 0 && part !== "." && part !== "..";
  });
}

function foldedPath(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en");
}

function validatePathKeys(paths: readonly string[]): void {
  const inventory = new Set(paths);
  if (inventory.size !== paths.length) {
    fail("path_invalid");
  }
  for (const path of paths) {
    for (
      let separator = path.indexOf("/");
      separator !== -1;
      separator = path.indexOf("/", separator + 1)
    ) {
      if (inventory.has(path.slice(0, separator))) {
        fail("path_invalid");
      }
    }
  }
}

function validatePaths(paths: readonly string[]): void {
  const folded = paths.map(foldedPath);
  for (const collection of [paths, folded]) {
    for (const path of collection) {
      if (!safePath(path)) {
        fail("path_invalid");
      }
    }
    validatePathKeys(collection);
  }
}

function validateFiles(files: readonly ArchiveFile[]): readonly ArchiveFile[] {
  if (files.length > STORAGE_MANIFEST_MAX_FILES) {
    fail("file_count_exceeded");
  }
  validatePaths(
    files.map((file) => {
      return file.path;
    }),
  );
  let pathBytes = 0;
  let totalBytes = 0;
  for (const file of files) {
    pathBytes += Buffer.byteLength(file.path, "utf8");
    totalBytes += file.size;
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > MAX_FILE_SIZE_BYTES ||
      file.bytes.length !== file.size ||
      !SAFE_SHA256.test(file.hash) ||
      hashBytes(file.bytes) !== file.hash ||
      pathBytes > STORAGE_MANIFEST_MAX_PATH_BYTES ||
      totalBytes > PI_MEMORY_PHASE2_PREPARED_MAX_BYTES ||
      !Number.isSafeInteger(totalBytes)
    ) {
      fail("file_identity_mismatch");
    }
  }
  return [...files].sort((left, right) => {
    return (
      compareText(left.path, right.path) || compareText(left.hash, right.hash)
    );
  });
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("manifest_invalid");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort(compareText);
  return (
    actual.length === expected.length &&
    actual.every((key, index) => {
      return key === [...expected].sort(compareText)[index];
    })
  );
}

function parseManifest(bytes: Buffer): CanonicalManifest {
  if (
    bytes.length === 0 ||
    bytes.length > PI_MEMORY_PHASE2_MANIFEST_MAX_BYTES
  ) {
    fail("manifest_size_invalid");
  }
  const decoded = safeSync(() => {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  });
  if (!("ok" in decoded)) {
    fail("manifest_invalid");
  }
  const parsed = safeJsonParse(decoded.ok);
  const manifest = objectRecord(parsed);
  if (
    !exactKeys(manifest, ["version", "files", "createdAt"]) ||
    manifest.version !== 1 ||
    typeof manifest.createdAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(
      manifest.createdAt,
    ) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > STORAGE_MANIFEST_MAX_FILES
  ) {
    fail("manifest_invalid");
  }
  const createdAt = manifest.createdAt as string;
  const canonicalCreatedAt = safeSync(() => {
    return new Date(createdAt).toISOString();
  });
  if (!("ok" in canonicalCreatedAt) || canonicalCreatedAt.ok !== createdAt) {
    fail("manifest_invalid");
  }
  const files = manifest.files.map((candidate) => {
    const file = objectRecord(candidate);
    if (
      !exactKeys(file, ["path", "hash", "size"]) ||
      typeof file.path !== "string" ||
      typeof file.hash !== "string" ||
      typeof file.size !== "number"
    ) {
      fail("manifest_invalid");
    }
    return { path: file.path, hash: file.hash, size: file.size };
  });
  return { version: 1, files, createdAt };
}

function zeroBlock(block: Buffer): boolean {
  return block.every((byte) => {
    return byte === 0;
  });
}

function rawField(block: Buffer, offset: number, length: number): Buffer {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  if (end === -1) {
    return field;
  }
  if (!zeroBlock(field.subarray(end))) {
    fail("tar_header_invalid");
  }
  return field.subarray(0, end);
}

function utf8Field(block: Buffer, offset: number, length: number): string {
  const decoded = safeSync(() => {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      rawField(block, offset, length),
    );
  });
  if (!("ok" in decoded)) {
    fail("path_utf8_invalid");
  }
  return decoded.ok;
}

function octalField(block: Buffer, offset: number, length: number): number {
  const field = block.subarray(offset, offset + length).toString("ascii");
  let start = 0;
  while (field.charCodeAt(start) === 32) {
    start += 1;
  }
  let end = field.length;
  while (
    end > start &&
    (field.charCodeAt(end - 1) === 0 || field.charCodeAt(end - 1) === 32)
  ) {
    end -= 1;
  }
  const raw = field.slice(start, end);
  if (!/^[0-7]+$/u.test(raw)) {
    fail("tar_header_invalid");
  }
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("tar_header_invalid");
  }
  return value;
}

function verifyHeader(block: Buffer): void {
  const expected = octalField(block, 148, 8);
  let actual = 0;
  for (let index = 0; index < TAR_BLOCK_BYTES; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : block.readUInt8(index);
  }
  if (expected !== actual) {
    fail("tar_checksum_mismatch");
  }
}

function parsePax(payload: Buffer): Readonly<{ path?: string; size?: number }> {
  let offset = 0;
  const fields = new Map<string, string>();
  while (offset < payload.length) {
    const space = payload.indexOf(32, offset);
    if (space === -1) {
      fail("tar_pax_invalid");
    }
    const lengthText = payload.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/u.test(lengthText)) {
      fail("tar_pax_invalid");
    }
    const length = Number(lengthText);
    const end = offset + length;
    if (
      !Number.isSafeInteger(length) ||
      end > payload.length ||
      payload[end - 1] !== 10
    ) {
      fail("tar_pax_invalid");
    }
    const decoded = safeSync(() => {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        payload.subarray(space + 1, end - 1),
      );
    });
    if (!("ok" in decoded)) {
      fail("tar_pax_invalid");
    }
    const record = decoded.ok;
    const equals = record.indexOf("=");
    if (equals <= 0) {
      fail("tar_pax_invalid");
    }
    const key = record.slice(0, equals);
    if ((key !== "path" && key !== "size") || fields.has(key)) {
      fail("tar_pax_unsupported");
    }
    fields.set(key, record.slice(equals + 1));
    offset = end;
  }
  const sizeText = fields.get("size");
  if (sizeText !== undefined && !/^(?:0|[1-9][0-9]*)$/u.test(sizeText)) {
    fail("tar_pax_invalid");
  }
  return {
    ...(fields.has("path") ? { path: fields.get("path") } : {}),
    ...(sizeText === undefined ? {} : { size: Number(sizeText) }),
  };
}

interface TarParseState {
  pendingPath?: string;
  pendingSize?: number;
}

function tarPayload(
  tarBytes: Buffer,
  header: Buffer,
  offset: number,
): Readonly<{ payload: Buffer; nextOffset: number; headerSize: number }> {
  const headerSize = octalField(header, 124, 12);
  const paddedSize = Math.ceil(headerSize / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
  if (offset + paddedSize > tarBytes.length) {
    fail("tar_truncated");
  }
  const payload = tarBytes.subarray(offset, offset + headerSize);
  const padding = tarBytes.subarray(offset + headerSize, offset + paddedSize);
  if (!zeroBlock(padding)) {
    fail("tar_padding_invalid");
  }
  return { payload, nextOffset: offset + paddedSize, headerSize };
}

function consumePax(state: TarParseState, payload: Buffer): void {
  if (state.pendingPath !== undefined || state.pendingSize !== undefined) {
    fail("tar_metadata_ambiguous");
  }
  const pax = parsePax(payload);
  state.pendingPath = pax.path;
  state.pendingSize = pax.size;
  if (state.pendingPath === undefined && state.pendingSize === undefined) {
    fail("tar_pax_invalid");
  }
}

function consumeLongPath(state: TarParseState, payload: Buffer): void {
  if (
    state.pendingPath !== undefined ||
    state.pendingSize !== undefined ||
    payload.length < 2 ||
    payload.at(-1) !== 0
  ) {
    fail("tar_metadata_ambiguous");
  }
  const name = payload.subarray(0, -1);
  if (name.includes(0)) {
    fail("tar_metadata_ambiguous");
  }
  const decoded = safeSync(() => {
    return new TextDecoder("utf-8", { fatal: true }).decode(name);
  });
  if (!("ok" in decoded)) {
    fail("path_utf8_invalid");
  }
  state.pendingPath = decoded.ok;
}

function consumeRegularFile(args: {
  readonly state: TarParseState;
  readonly header: Buffer;
  readonly payload: Buffer;
  readonly headerSize: number;
  readonly files: ArchiveFile[];
}): void {
  if (args.files.length >= STORAGE_MANIFEST_MAX_FILES) {
    fail("file_count_exceeded");
  }
  const name = utf8Field(args.header, 0, 100);
  const prefix = utf8Field(args.header, 345, 155);
  const path =
    args.state.pendingPath ?? (prefix.length > 0 ? `${prefix}/${name}` : name);
  const size = args.state.pendingSize ?? args.headerSize;
  if (size !== args.headerSize) {
    fail("tar_size_mismatch");
  }
  args.files.push({
    path,
    hash: hashBytes(args.payload),
    size,
    bytes: Buffer.from(args.payload),
  });
  args.state.pendingPath = undefined;
  args.state.pendingSize = undefined;
}

function consumeTarEntry(args: {
  readonly state: TarParseState;
  readonly header: Buffer;
  readonly payload: Buffer;
  readonly headerSize: number;
  readonly files: ArchiveFile[];
}): void {
  const type = args.header.readUInt8(156);
  if (type === 120) {
    consumePax(args.state, args.payload);
    return;
  }
  if (type === 76) {
    consumeLongPath(args.state, args.payload);
    return;
  }
  if (type !== 0 && type !== 48) {
    fail("tar_type_unsupported");
  }
  consumeRegularFile(args);
}

function verifyTarEnd(
  tarBytes: Buffer,
  offset: number,
  state: TarParseState,
): void {
  const second = tarBytes.subarray(offset, offset + TAR_BLOCK_BYTES);
  if (second.length !== TAR_BLOCK_BYTES || !zeroBlock(second)) {
    fail("tar_truncated");
  }
  if (
    !zeroBlock(tarBytes.subarray(offset + TAR_BLOCK_BYTES)) ||
    state.pendingPath !== undefined ||
    state.pendingSize !== undefined
  ) {
    fail("tar_trailing_ambiguity");
  }
}

function parseTar(tarBytes: Buffer): readonly ArchiveFile[] {
  if (
    tarBytes.length < TAR_BLOCK_BYTES * 2 ||
    tarBytes.length > PI_MEMORY_PHASE2_TAR_MAX_BYTES ||
    tarBytes.length % TAR_BLOCK_BYTES !== 0
  ) {
    fail("tar_size_invalid");
  }
  const files: ArchiveFile[] = [];
  const state: TarParseState = {};
  let offset = 0;
  while (offset < tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + TAR_BLOCK_BYTES);
    offset += TAR_BLOCK_BYTES;
    if (zeroBlock(header)) {
      verifyTarEnd(tarBytes, offset, state);
      return validateFiles(files);
    }
    verifyHeader(header);
    const entry = tarPayload(tarBytes, header, offset);
    offset = entry.nextOffset;
    consumeTarEntry({ state, header, files, ...entry });
  }
  fail("tar_truncated");
}

function manifestFiles(files: readonly ArchiveFile[]) {
  return files.map((file) => {
    return { path: file.path, hash: file.hash, size: file.size };
  });
}

function assertManifestMatches(
  manifest: CanonicalManifest,
  files: readonly ArchiveFile[],
): void {
  const expected = manifestFiles(files);
  const actual = [...manifest.files].sort((left, right) => {
    return (
      compareText(left.path, right.path) || compareText(left.hash, right.hash)
    );
  });
  if (
    actual.length !== expected.length ||
    actual.some((file, index) => {
      const wanted = expected[index];
      return (
        wanted === undefined ||
        file.path !== wanted.path ||
        file.hash !== wanted.hash ||
        file.size !== wanted.size
      );
    })
  ) {
    fail("manifest_payload_mismatch");
  }
}

function writeOctal(
  block: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  const text = value.toString(8).padStart(length - 1, "0");
  if (text.length > length - 1) {
    fail("tar_header_overflow");
  }
  block.write(text, offset, length - 1, "ascii");
  block[offset + length - 1] = 0;
}

function pathFields(
  path: string,
): { readonly name: string; readonly prefix: string } | null {
  if (Buffer.byteLength(path, "utf8") <= 100) {
    return { name: path, prefix: "" };
  }
  const separators = [...path.matchAll(/\//gu)].map((match) => {
    return match.index;
  });
  for (let index = separators.length - 1; index >= 0; index -= 1) {
    const separator = separators[index];
    if (separator === undefined) {
      continue;
    }
    const prefix = path.slice(0, separator);
    const name = path.slice(separator + 1);
    if (
      Buffer.byteLength(prefix, "utf8") <= 155 &&
      Buffer.byteLength(name, "utf8") <= 100
    ) {
      return { name, prefix };
    }
  }
  return null;
}

function tarHeader(path: string, size: number, type: number): Buffer {
  const fields = pathFields(path);
  if (!fields) {
    fail("tar_path_too_long");
  }
  const block = Buffer.alloc(TAR_BLOCK_BYTES);
  block.write(fields.name, 0, 100, "utf8");
  writeOctal(block, 100, 8, 0o644);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, 0);
  block.fill(32, 148, 156);
  block[156] = type;
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  block.write(fields.prefix, 345, 155, "utf8");
  let checksum = 0;
  for (const byte of block) {
    checksum += byte;
  }
  const checksumText = checksum.toString(8).padStart(6, "0");
  block.write(checksumText, 148, 6, "ascii");
  block[154] = 0;
  block[155] = 32;
  return block;
}

function paxRecord(key: string, value: string): Buffer {
  let length = Buffer.byteLength(`${key}=${value}\n`, "utf8") + 2;
  while (true) {
    const record = `${length} ${key}=${value}\n`;
    const bytes = Buffer.from(record, "utf8");
    if (bytes.length === length) {
      return bytes;
    }
    length = bytes.length;
  }
}

function appendTarEntry(parts: Buffer[], path: string, bytes: Buffer): void {
  let headerPath = path;
  if (pathFields(path) === null) {
    const identity = hashBytes(Buffer.from(path, "utf8"));
    const pax = paxRecord("path", path);
    parts.push(
      tarHeader(`PaxHeaders/${identity}`, pax.length, 120),
      pax,
      Buffer.alloc(
        (TAR_BLOCK_BYTES - (pax.length % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES,
      ),
    );
    headerPath = `Files/${identity}`;
  }
  parts.push(
    tarHeader(headerPath, bytes.length, 48),
    bytes,
    Buffer.alloc(
      (TAR_BLOCK_BYTES - (bytes.length % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES,
    ),
  );
}

function buildTar(files: readonly ArchiveFile[]): Buffer {
  const parts: Buffer[] = [];
  for (const file of files) {
    appendTarEntry(parts, file.path, file.bytes);
  }
  parts.push(Buffer.alloc(TAR_BLOCK_BYTES * 2));
  const tar = Buffer.concat(parts);
  if (tar.length > PI_MEMORY_PHASE2_TAR_MAX_BYTES) {
    fail("tar_size_invalid");
  }
  return tar;
}

function archiveFilesFromPrepared(
  prepared: readonly PiMemoryPhase2PreparedFile[],
): readonly ArchiveFile[] {
  const files = prepared.map((file) => {
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        file.contentBase64,
      )
    ) {
      fail("prepared_base64_invalid");
    }
    return {
      path: file.path,
      hash: file.hash,
      size: file.size,
      bytes: Buffer.from(file.contentBase64, "base64"),
    };
  });
  return validateFiles(files);
}

function uint32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value);
  return result;
}

function preparedManifestDigest(files: readonly ArchiveFile[]): string {
  const parts: Buffer[] = [uint32(files.length)];
  for (const file of files) {
    const path = Buffer.from(file.path, "utf8");
    const hash = Buffer.from(file.hash, "utf8");
    parts.push(
      uint32(path.length),
      path,
      uint32(hash.length),
      hash,
      uint32(file.size),
    );
  }
  const version = Buffer.from(MANIFEST_DIGEST_ENCODING, "utf8");
  return createHash("sha256")
    .update(Buffer.concat([uint32(version.length), version, ...parts]))
    .digest("hex");
}

function skipGzipTextField(bytes: Buffer, offset: number): number {
  const end = bytes.indexOf(0, offset);
  if (end === -1) {
    fail("archive_decompression_failed");
  }
  return end + 1;
}

function gzipDeflateOffset(bytes: Buffer): number {
  if (
    bytes.length < 18 ||
    bytes[0] !== 0x1f ||
    bytes[1] !== 0x8b ||
    bytes[2] !== 8
  ) {
    fail("archive_decompression_failed");
  }
  const flags = bytes.readUInt8(3);
  if ((flags & 0xe0) !== 0) {
    fail("archive_decompression_failed");
  }
  let offset = 10;
  if ((flags & 0x04) !== 0) {
    if (offset + 2 > bytes.length) {
      fail("archive_decompression_failed");
    }
    const length = bytes.readUInt16LE(offset);
    offset += 2 + length;
  }
  if ((flags & 0x08) !== 0) {
    offset = skipGzipTextField(bytes, offset);
  }
  if ((flags & 0x10) !== 0) {
    offset = skipGzipTextField(bytes, offset);
  }
  if ((flags & 0x02) !== 0) {
    offset += 2;
  }
  if (offset > bytes.length - 8) {
    fail("archive_decompression_failed");
  }
  return offset;
}

function assertSingleGzipMember(bytes: Buffer): void {
  const offset = gzipDeflateOffset(bytes);
  const inflated = safeSync(() => {
    return inflateRawSync(bytes.subarray(offset), {
      info: true,
      maxOutputLength: PI_MEMORY_PHASE2_TAR_MAX_BYTES,
    }) as unknown as Readonly<{
      buffer: Buffer;
      engine: Readonly<{ bytesWritten: number }>;
    }>;
  });
  if (!("ok" in inflated)) {
    fail("archive_decompression_failed");
  }
  if (offset + inflated.ok.engine.bytesWritten + 8 !== bytes.length) {
    fail("archive_trailing_ambiguity");
  }
}

export function validatePiMemoryPhase2PreparedResult(
  storageId: string,
  result: PiMemoryPhase2ConsolidationResult,
): readonly ArchiveFile[] {
  const files = archiveFilesFromPrepared(result.files);
  const metadata = manifestFiles(files);
  const totalBytes = files.reduce((sum, file) => {
    return sum + file.size;
  }, 0);
  const pathBytes = files.reduce((sum, file) => {
    return sum + Buffer.byteLength(file.path, "utf8");
  }, 0);
  const versionId = computeContentHashFromHashes(storageId, metadata);
  if (
    result.contentIdentity !== versionId ||
    result.manifest.version !== 1 ||
    result.manifest.fileCount !== files.length ||
    result.manifest.pathBytes !== pathBytes ||
    result.manifest.totalBytes !== totalBytes ||
    result.manifest.digest !== preparedManifestDigest(files) ||
    JSON.stringify(result.manifest.files) !== JSON.stringify(metadata)
  ) {
    fail("prepared_identity_mismatch");
  }
  return files;
}

export function buildPiMemoryPhase2Archive(
  storageId: string,
  result: PiMemoryPhase2ConsolidationResult,
): PreparedPiMemoryPhase2Archive {
  const files = validatePiMemoryPhase2PreparedResult(storageId, result);
  if (files.length === 0) {
    fail("prepared_empty_invalid");
  }
  const manifest: CanonicalManifest = {
    version: 1,
    files: manifestFiles(files),
    createdAt: "1970-01-01T00:00:00.000Z",
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  if (manifestBytes.length > PI_MEMORY_PHASE2_MANIFEST_MAX_BYTES) {
    fail("manifest_size_invalid");
  }
  const archiveBytes = gzipSync(buildTar(files), { level: 9 });
  archiveBytes[9] = 255;
  if (archiveBytes.length > PI_MEMORY_PHASE2_ARCHIVE_MAX_BYTES) {
    fail("archive_size_invalid");
  }
  const size = files.reduce((sum, file) => {
    return sum + file.size;
  }, 0);
  return {
    files: files.map((file) => {
      return {
        type: "file",
        path: file.path,
        hash: file.hash,
        size: file.size,
        bytes: file.bytes,
      };
    }),
    versionId: computeContentHashFromHashes(storageId, manifest.files),
    size,
    archiveSize: archiveBytes.length,
    fileCount: files.length,
    manifestBytes,
    archiveBytes,
  };
}

export function verifyPiMemoryPhase2Archive(args: {
  readonly storageId: string;
  readonly versionId: string;
  readonly size: number;
  readonly archiveSize: number;
  readonly fileCount: number;
  readonly manifestBytes: Buffer;
  readonly archiveBytes: Buffer;
}): PiMemoryPhase2ArchiveIdentity {
  if (
    args.archiveBytes.length !== args.archiveSize ||
    args.archiveSize <= 0 ||
    args.archiveSize > PI_MEMORY_PHASE2_ARCHIVE_MAX_BYTES
  ) {
    fail("archive_size_mismatch");
  }
  assertSingleGzipMember(args.archiveBytes);
  const decompressed = safeSync(() => {
    return gunzipSync(args.archiveBytes, {
      maxOutputLength: PI_MEMORY_PHASE2_TAR_MAX_BYTES,
    });
  });
  if (!("ok" in decompressed)) {
    fail("archive_decompression_failed");
  }
  const tarBytes = decompressed.ok;
  const files = parseTar(tarBytes);
  const manifest = parseManifest(args.manifestBytes);
  assertManifestMatches(manifest, files);
  const size = files.reduce((sum, file) => {
    return sum + file.size;
  }, 0);
  const versionId = computeContentHashFromHashes(
    args.storageId,
    manifest.files,
  );
  if (
    args.versionId !== versionId ||
    args.size !== size ||
    args.fileCount !== files.length
  ) {
    fail("registered_identity_mismatch");
  }
  return {
    files: files.map((file) => {
      return {
        type: "file",
        path: file.path,
        hash: file.hash,
        size: file.size,
        bytes: file.bytes,
      };
    }),
    versionId,
    size,
    archiveSize: args.archiveSize,
    fileCount: files.length,
  };
}

export function verifyEmptyPiMemoryPhase2Version(args: {
  readonly storageId: string;
  readonly versionId: string;
  readonly size: number;
  readonly archiveSize: number;
  readonly fileCount: number;
}): PiMemoryPhase2ArchiveIdentity {
  const versionId = computeContentHashFromHashes(args.storageId, []);
  if (
    args.versionId !== versionId ||
    args.size !== 0 ||
    args.archiveSize !== 0 ||
    args.fileCount !== 0
  ) {
    fail("empty_version_identity_mismatch");
  }
  return { files: [], versionId, size: 0, archiveSize: 0, fileCount: 0 };
}
