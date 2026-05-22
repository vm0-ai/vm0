const BLOCK_SIZE = 512;

function createFileHeader(filename: string, content: Buffer): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE, 0);
  header.write(filename, 0, Math.min(filename.length, 100), "utf-8");
  header.write("0000644\0", 100, 8, "utf-8");
  header.write("0000000\0", 108, 8, "utf-8");
  header.write("0000000\0", 116, 8, "utf-8");
  header.write(content.length.toString(8).padStart(11, "0") + "\0", 124, 12);
  header.write(
    Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, "0") + "\0",
    136,
    12,
  );
  header.write("        ", 148, 8, "utf-8");
  header.write("0", 156, 1, "utf-8");
  header.write("ustar\0", 257, 6, "utf-8");
  header.write("00", 263, 2, "utf-8");

  let checksum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    checksum += header.readUInt8(i);
  }
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return header;
}

export function createSingleFileTar(filename: string, content: Buffer): Buffer {
  const padding = BLOCK_SIZE - (content.length % BLOCK_SIZE);
  return Buffer.concat([
    createFileHeader(filename, content),
    content,
    ...(padding < BLOCK_SIZE ? [Buffer.alloc(padding, 0)] : []),
    Buffer.alloc(BLOCK_SIZE * 2, 0),
  ]);
}
