import { Readable, type Transform } from "node:stream";
import { createGunzip, createZstdDecompress } from "node:zlib";

import { S3ObjectSizeLimitError } from "../external/s3";

async function decompressSessionHistoryBufferWithMaxBytes(
  key: string,
  buffer: Buffer,
  maxBytes: number,
  createDecompressor: () => Transform,
  codec: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalLength = 0;
  const decompressor = createDecompressor();
  for await (const chunk of Readable.from([buffer]).pipe(decompressor)) {
    if (!(chunk instanceof Uint8Array)) {
      decompressor.destroy();
      throw new Error(`${codec} stream yielded a non-byte chunk`);
    }
    const data = Buffer.from(chunk);
    totalLength += data.length;
    if (totalLength > maxBytes) {
      decompressor.destroy();
      throw new S3ObjectSizeLimitError(key, totalLength, maxBytes);
    }
    chunks.push(data);
  }
  return Buffer.concat(chunks, totalLength);
}

export async function gunzipSessionHistoryBufferWithMaxBytes(
  key: string,
  buffer: Buffer,
  maxBytes: number,
): Promise<Buffer> {
  return await decompressSessionHistoryBufferWithMaxBytes(
    key,
    buffer,
    maxBytes,
    createGunzip,
    "gzip",
  );
}

export async function unzstdSessionHistoryBufferWithMaxBytes(
  key: string,
  buffer: Buffer,
  maxBytes: number,
): Promise<Buffer> {
  return await decompressSessionHistoryBufferWithMaxBytes(
    key,
    buffer,
    maxBytes,
    createZstdDecompress,
    "zstd",
  );
}
