import { gzipSync } from "node:zlib";
import { extractFileFromTarGz } from "../tar";

function makeTar(entries: { name: string; content: string }[]): Buffer {
  const blocks: Buffer[] = [];

  for (const { name, content } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");

    // File mode (644)
    header.write("0000644", 100, 7, "utf8");
    header.write("0000000", 108, 7, "utf8");
    header.write("0000000", 116, 7, "utf8");

    // Size in octal
    const sizeOctal = content.length.toString(8).padStart(11, "0");
    header.write(sizeOctal, 124, 11, "utf8");

    // Checksum placeholder (8 spaces)
    header.write("        ", 148, 8, "utf8");

    // Type flag (0 = regular file)
    header[156] = 0x30;

    // Compute checksum: sum of all bytes treating the 8-space checksum as spaces
    let checksum = 0;
    for (let i = 0; i < 512; i++) {
      checksum += i >= 148 && i < 156 ? 32 : header[i]!;
    }
    const checksumOctal = checksum.toString(8).padStart(6, "0") + "\0 ";
    header.write(checksumOctal, 148, 8, "utf8");

    blocks.push(header);

    // Content blocks padded to 512-byte boundary
    const contentBuffer = Buffer.from(content, "utf8");
    blocks.push(contentBuffer);

    const padding = 512 - (contentBuffer.length % 512);
    if (padding < 512) {
      blocks.push(Buffer.alloc(padding));
    }
  }

  // Two zero blocks to mark end of archive
  blocks.push(Buffer.alloc(512));
  blocks.push(Buffer.alloc(512));

  return Buffer.concat(blocks);
}

function makeTarGz(entries: { name: string; content: string }[]): Buffer {
  return gzipSync(makeTar(entries));
}

describe("extractFileFromTarGz", () => {
  it("extracts a file by exact name", () => {
    const tarGz = makeTarGz([
      { name: "hello.txt", content: "Hello, world!" },
      { name: "data.json", content: '{"key":"value"}' },
    ]);

    expect(extractFileFromTarGz(tarGz, "hello.txt")).toBe("Hello, world!");
    expect(extractFileFromTarGz(tarGz, "data.json")).toBe('{"key":"value"}');
  });

  it("strips leading ./ from targetPath", () => {
    const tarGz = makeTarGz([{ name: "./src/main.ts", content: "console.log(1);" }]);

    expect(extractFileFromTarGz(tarGz, "src/main.ts")).toBe("console.log(1);");
    expect(extractFileFromTarGz(tarGz, "./src/main.ts")).toBe("console.log(1);");
  });

  it("strips leading ./ from tar entry names", () => {
    const tarGz = makeTarGz([{ name: "./nested/file.txt", content: "nested content" }]);

    expect(extractFileFromTarGz(tarGz, "nested/file.txt")).toBe("nested content");
  });

  it("returns null for a file not in the archive", () => {
    const tarGz = makeTarGz([{ name: "a.txt", content: "a" }]);

    expect(extractFileFromTarGz(tarGz, "missing.txt")).toBeNull();
  });

  it("returns null for an empty archive", () => {
    const tarGz = gzipSync(Buffer.concat([Buffer.alloc(512), Buffer.alloc(512)]));

    expect(extractFileFromTarGz(tarGz, "anything.txt")).toBeNull();
  });

  it("handles long file content spanning multiple blocks", () => {
    const longContent = "x".repeat(2000);
    const tarGz = makeTarGz([{ name: "large.txt", content: longContent }]);

    expect(extractFileFromTarGz(tarGz, "large.txt")).toBe(longContent);
  });

  it("returns the first matching entry when duplicate names exist", () => {
    const tarGz = makeTarGz([
      { name: "dup.txt", content: "first" },
      { name: "dup.txt", content: "second" },
    ]);

    expect(extractFileFromTarGz(tarGz, "dup.txt")).toBe("first");
  });
});
