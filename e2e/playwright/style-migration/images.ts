import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { PNG } from "pngjs";

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Exact decoded pixels, including alpha; no masks or perceptual tolerance. */
export function compareImages(before: Buffer, after: Buffer) {
  const left = PNG.sync.read(before);
  const right = PNG.sync.read(after);
  assert.equal(right.width, left.width, "Screenshot width changed");
  assert.equal(right.height, left.height, "Screenshot height changed");
  const diff = new PNG({ width: left.width, height: left.height });
  let changedPixels = 0;
  for (let offset = 0; offset < left.data.length; offset += 4) {
    const changed = [0, 1, 2, 3].some(
      (channel) => left.data[offset + channel] !== right.data[offset + channel],
    );
    if (changed) changedPixels += 1;
    diff.data[offset] = changed ? 255 : right.data[offset];
    diff.data[offset + 1] = changed ? 0 : right.data[offset + 1];
    diff.data[offset + 2] = changed ? 0 : right.data[offset + 2];
    diff.data[offset + 3] = 255;
  }
  return { changedPixels, diff: PNG.sync.write(diff) };
}
