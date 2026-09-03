import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import type {
  PiMemoryPhase2ConsolidationResult,
  PiMemoryPhase2PreparedFile,
} from "@okouai/pi-agent-runtime/api";
import { describe, expect, it } from "vitest";

import {
  buildPiMemoryPhase2Archive,
  PiMemoryPhase2ArchiveError,
  validatePiMemoryPhase2PreparedResult,
  verifyPiMemoryPhase2Archive,
} from "../pi-memory-phase2-archive.service";
import { computeContentHashFromHashes } from "../storage-content-hash.service";

const STORAGE_ID = "92d1f947-21f0-46b7-a0e8-ddb0964103ee";
const DIGEST_ENCODING = "vm0.pi-memory.phase2.manifest.v1";

function uint32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value);
  return result;
}

function digest(files: readonly PiMemoryPhase2PreparedFile[]): string {
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
  const version = Buffer.from(DIGEST_ENCODING, "utf8");
  return createHash("sha256")
    .update(Buffer.concat([uint32(version.length), version, ...parts]))
    .digest("hex");
}

function preparedFile(
  path: string,
  content: string,
): PiMemoryPhase2PreparedFile {
  const bytes = Buffer.from(content, "utf8");
  return {
    path,
    hash: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    contentBase64: bytes.toString("base64"),
  };
}

function archiveWithFirstEntryType(archive: Buffer, type: number): Buffer {
  const tar = gunzipSync(archive);
  tar[156] = type;
  tar.fill(32, 148, 156);
  let checksum = 0;
  for (let index = 0; index < 512; index += 1) {
    checksum += tar.readUInt8(index);
  }
  tar.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  tar[154] = 0;
  tar[155] = 32;
  return gzipSync(tar, { level: 9 });
}

function result(
  input: readonly Readonly<{
    readonly path: string;
    readonly content: string;
  }>[],
): PiMemoryPhase2ConsolidationResult {
  const files = input
    .map((file) => {
      return preparedFile(file.path, file.content);
    })
    .sort((left, right) => {
      return left.path === right.path ? 0 : left.path < right.path ? -1 : 1;
    });
  const metadata = files.map((file) => {
    return { path: file.path, hash: file.hash, size: file.size };
  });
  return {
    status: "prepared",
    files,
    manifest: {
      version: 1,
      files: metadata,
      fileCount: files.length,
      pathBytes: files.reduce((sum, file) => {
        return sum + Buffer.byteLength(file.path, "utf8");
      }, 0),
      totalBytes: files.reduce((sum, file) => {
        return sum + file.size;
      }, 0),
      digest: digest(files),
    },
    contentIdentity: computeContentHashFromHashes(STORAGE_ID, metadata),
    diff: {
      added: 1,
      changed: 0,
      deleted: 0,
      renderedBytes: 0,
      truncated: false,
      digest: "0".repeat(64),
    },
    selectionDigest: "1".repeat(64),
    responseId: "response-31291",
    usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, reasoning: 1 },
  };
}

const PRESERVED_FILES = [
  { path: ".git/config", content: "codex git state" },
  { path: "MEMORY.md", content: "# Durable external fact" },
  { path: "memory_summary.md", content: "v1\n## User Profile\n- durable" },
  { path: "legacy-topic.md", content: "legacy flat topic" },
  { path: "unknown/data.bin", content: "unknown file" },
  {
    path: `unknown/${"long-segment/".repeat(24)}evidence.md`,
    content: "long path evidence",
  },
  { path: "rollout_summaries/codex.md", content: "codex evidence" },
  { path: "rollout_summaries/pi/nested.md", content: "nested pi evidence" },
] as const;

describe("Pi memory Phase 2 archive boundary", () => {
  it("creates deterministic bytes and completely verifies preserved files", () => {
    const first = buildPiMemoryPhase2Archive(
      STORAGE_ID,
      result(PRESERVED_FILES),
    );
    const second = buildPiMemoryPhase2Archive(
      STORAGE_ID,
      result([...PRESERVED_FILES].reverse()),
    );

    expect(second.versionId).toBe(first.versionId);
    expect(second.manifestBytes).toStrictEqual(first.manifestBytes);
    expect(second.archiveBytes).toStrictEqual(first.archiveBytes);

    const verified = verifyPiMemoryPhase2Archive({
      storageId: STORAGE_ID,
      versionId: first.versionId,
      size: first.size,
      archiveSize: first.archiveSize,
      fileCount: first.fileCount,
      manifestBytes: first.manifestBytes,
      archiveBytes: first.archiveBytes,
    });
    expect(
      verified.files.map((file) => {
        return [file.path, Buffer.from(file.bytes).toString("utf8")];
      }),
    ).toStrictEqual(
      [...PRESERVED_FILES]
        .sort((left, right) => {
          return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
        })
        .map((file) => {
          return [file.path, file.content];
        }),
    );
  });

  it("rejects non-adjacent ancestors and accepts valid near prefixes", () => {
    const collisions = [
      ["a", "a-", "a/b"],
      ["E\u0301", "é-", "É/child"],
    ] as const;
    for (const paths of collisions) {
      const prepared = result(
        paths.map((path, index) => {
          return { path, content: `collision-${index.toString()}` };
        }),
      );
      for (const files of [prepared.files, [...prepared.files].reverse()]) {
        expect(() => {
          validatePiMemoryPhase2PreparedResult(STORAGE_ID, {
            ...prepared,
            files,
          });
        }).toThrow(
          expect.objectContaining({
            name: "PiMemoryPhase2ArchiveError",
            errorClass: "path_invalid",
          }),
        );
      }
    }

    const nearPrefixes = result([
      { path: "a", content: "exact" },
      { path: "a-/child", content: "hyphen" },
      { path: "a.b", content: "dot" },
      { path: "a0/b", content: "suffix" },
      { path: "E\u0301", content: "decomposed" },
      { path: "é-/child", content: "normalized hyphen" },
    ]);
    const canonical = buildPiMemoryPhase2Archive(STORAGE_ID, nearPrefixes);
    const reordered = buildPiMemoryPhase2Archive(STORAGE_ID, {
      ...nearPrefixes,
      files: [...nearPrefixes.files].reverse(),
    });

    expect(reordered.versionId).toBe(canonical.versionId);
    expect(reordered.manifestBytes).toStrictEqual(canonical.manifestBytes);
    expect(reordered.archiveBytes).toStrictEqual(canonical.archiveBytes);
  });

  it("rejects API-returned path collisions and identity mismatches", () => {
    const collision = result([
      { path: "Topic.md", content: "first" },
      { path: "topic.md", content: "second" },
    ]);
    expect(() => {
      validatePiMemoryPhase2PreparedResult(STORAGE_ID, collision);
    }).toThrow(PiMemoryPhase2ArchiveError);

    const mismatched = result([{ path: "MEMORY.md", content: "durable" }]);
    const first = mismatched.files[0];
    if (!first) {
      throw new Error("Prepared fixture is missing");
    }
    const changed = {
      ...mismatched,
      files: [
        { ...first, contentBase64: Buffer.from("changed").toString("base64") },
      ],
    };
    expect(() => {
      validatePiMemoryPhase2PreparedResult(STORAGE_ID, changed);
    }).toThrow(PiMemoryPhase2ArchiveError);

    for (const path of [
      "/absolute.md",
      "../parent.md",
      "topic/../escape.md",
      String.raw`topic\ambiguous.md`,
      "topic//empty.md",
      "C:/drive.md",
    ]) {
      expect(() => {
        validatePiMemoryPhase2PreparedResult(
          STORAGE_ID,
          result([{ path, content: "rejected" }]),
        );
      }).toThrow(PiMemoryPhase2ArchiveError);
    }

    expect(() => {
      validatePiMemoryPhase2PreparedResult(
        STORAGE_ID,
        result([
          { path: "e\u0301.md", content: "first" },
          { path: "é.md", content: "second" },
        ]),
      );
    }).toThrow(PiMemoryPhase2ArchiveError);
  });

  it("rejects archive corruption, trailing tar data, and registered metadata drift", () => {
    const prepared = buildPiMemoryPhase2Archive(
      STORAGE_ID,
      result(PRESERVED_FILES),
    );
    const corrupted = Buffer.from(prepared.archiveBytes);
    const corruptedIndex = Math.floor(corrupted.length / 2);
    corrupted.writeUInt8(
      corrupted.readUInt8(corruptedIndex) ^ 1,
      corruptedIndex,
    );
    expect(() => {
      verifyPiMemoryPhase2Archive({
        storageId: STORAGE_ID,
        versionId: prepared.versionId,
        size: prepared.size,
        archiveSize: corrupted.length,
        fileCount: prepared.fileCount,
        manifestBytes: prepared.manifestBytes,
        archiveBytes: corrupted,
      });
    }).toThrow(PiMemoryPhase2ArchiveError);

    for (const type of ["2", "3", "4", "5", "7"]) {
      const unsupported = archiveWithFirstEntryType(
        prepared.archiveBytes,
        type.charCodeAt(0),
      );
      expect(() => {
        verifyPiMemoryPhase2Archive({
          storageId: STORAGE_ID,
          versionId: prepared.versionId,
          size: prepared.size,
          archiveSize: unsupported.length,
          fileCount: prepared.fileCount,
          manifestBytes: prepared.manifestBytes,
          archiveBytes: unsupported,
        });
      }).toThrow(PiMemoryPhase2ArchiveError);
    }

    expect(() => {
      verifyPiMemoryPhase2Archive({
        storageId: STORAGE_ID,
        versionId: prepared.versionId,
        size: prepared.size,
        archiveSize: prepared.archiveSize,
        fileCount: prepared.fileCount,
        manifestBytes: Buffer.from([0xff]),
        archiveBytes: prepared.archiveBytes,
      });
    }).toThrow(PiMemoryPhase2ArchiveError);

    const concatenated = Buffer.concat([
      prepared.archiveBytes,
      gzipSync(Buffer.alloc(1024)),
    ]);
    expect(() => {
      verifyPiMemoryPhase2Archive({
        storageId: STORAGE_ID,
        versionId: prepared.versionId,
        size: prepared.size,
        archiveSize: concatenated.length,
        fileCount: prepared.fileCount,
        manifestBytes: prepared.manifestBytes,
        archiveBytes: concatenated,
      });
    }).toThrow(PiMemoryPhase2ArchiveError);

    const tar = gunzipSync(prepared.archiveBytes);
    const trailingTar = Buffer.concat([tar, Buffer.alloc(512, 1)]);
    const trailingArchive = gzipSync(trailingTar, { level: 9 });
    expect(() => {
      verifyPiMemoryPhase2Archive({
        storageId: STORAGE_ID,
        versionId: prepared.versionId,
        size: prepared.size,
        archiveSize: trailingArchive.length,
        fileCount: prepared.fileCount,
        manifestBytes: prepared.manifestBytes,
        archiveBytes: trailingArchive,
      });
    }).toThrow(PiMemoryPhase2ArchiveError);

    expect(() => {
      verifyPiMemoryPhase2Archive({
        storageId: STORAGE_ID,
        versionId: "f".repeat(64),
        size: prepared.size,
        archiveSize: prepared.archiveSize,
        fileCount: prepared.fileCount,
        manifestBytes: prepared.manifestBytes,
        archiveBytes: prepared.archiveBytes,
      });
    }).toThrow(PiMemoryPhase2ArchiveError);
  });
});
