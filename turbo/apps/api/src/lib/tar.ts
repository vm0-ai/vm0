import { gunzipSync } from "node:zlib";

const BLOCK_SIZE = 512;

export function extractFileFromTarGz(
  gzBuffer: Buffer,
  targetPath: string,
): string | null {
  const tarBuffer = gunzipSync(gzBuffer);
  const normalized = targetPath.replace(/^\.\//, "");

  let offset = 0;
  while (offset + BLOCK_SIZE <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + BLOCK_SIZE);

    if (
      header.every((b) => {
        return b === 0;
      })
    ) {
      break;
    }

    const nameEnd = header.indexOf(0);
    const name = header
      .subarray(0, nameEnd > 0 && nameEnd < 100 ? nameEnd : 100)
      .toString("utf8");

    const sizeStr = header.subarray(124, 136).toString("utf8").trim();
    const size = Number.parseInt(sizeStr, 8) || 0;

    offset += BLOCK_SIZE;

    const entryName = name.replace(/^\.\//, "");
    if (entryName === normalized) {
      return tarBuffer.subarray(offset, offset + size).toString("utf8");
    }

    offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }
  return null;
}
