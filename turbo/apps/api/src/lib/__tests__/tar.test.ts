import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { extractBinaryFilesFromTarGz } from "../tar";

describe("TAR extraction", () => {
  it("accepts a canonical empty archive", () => {
    const archive = gzipSync(Buffer.alloc(1024));

    expect(extractBinaryFilesFromTarGz(archive)).toStrictEqual([]);
  });

  it("rejects an incomplete empty archive", () => {
    const archive = gzipSync(Buffer.alloc(512));

    expect(() => {
      return extractBinaryFilesFromTarGz(archive);
    }).toThrow(/TAR_BAD_ARCHIVE/u);
  });
});
