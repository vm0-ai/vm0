import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

import { S3ObjectSizeLimitError } from "../external/s3";

export async function gunzipSessionHistoryBufferWithMaxBytes(
  key: string,
  buffer: Buffer,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalLength = 0;
  const gunzip = createGunzip();
  for await (const chunk of Readable.from([buffer]).pipe(gunzip)) {
    if (!(chunk instanceof Uint8Array)) {
      throw new Error("gzip stream yielded a non-byte chunk");
    }
    const data = Buffer.from(chunk);
    totalLength += data.length;
    if (totalLength > maxBytes) {
      gunzip.destroy();
      throw new S3ObjectSizeLimitError(key, totalLength, maxBytes);
    }
    chunks.push(data);
  }
  return Buffer.concat(chunks, totalLength);
}
