import assert from "node:assert/strict";
import test from "node:test";

import { PNG } from "pngjs";

import { compareImages } from "../style-migration/images";

test("visual acceptance rejects changes larger than calibrated rounding and keeps a readable diff", () => {
  const before = new PNG({ width: 2, height: 1 });
  before.data.fill(255);
  const after = new PNG({ width: 2, height: 1 });
  after.data.fill(255);
  after.data[0] = 253;
  const result = compareImages(PNG.sync.write(before), PNG.sync.write(after));
  assert.equal(result.changedPixels, 1);
  assert.equal(result.contentChangedPixels, 1);
  const diff = PNG.sync.read(result.diff);
  assert.deepEqual([...diff.data.slice(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...diff.data.slice(4)], [255, 255, 255, 255]);
  assert.equal(
    compareImages(PNG.sync.write(before), PNG.sync.write(before)).changedPixels,
    0,
  );
});

test("visual acceptance rejects dimension changes and transparent pixel changes", () => {
  const before = new PNG({ width: 1, height: 1 });
  const wider = new PNG({ width: 2, height: 1 });
  assert.throws(
    () => compareImages(PNG.sync.write(before), PNG.sync.write(wider)),
    /width changed/,
  );
  const after = new PNG({ width: 1, height: 1 });
  after.data[3] = 1;
  assert.equal(
    compareImages(PNG.sync.write(before), PNG.sync.write(after)).changedPixels,
    1,
  );
  assert.equal(
    compareImages(PNG.sync.write(before), PNG.sync.write(after))
      .contentChangedPixels,
    1,
  );
});

test("rounding is bounded to eight opaque pixels, never a whole surface", () => {
  const before = new PNG({ width: 9, height: 1 });
  before.data.fill(255);
  const after = new PNG({ width: 9, height: 1 });
  after.data.fill(255);
  for (let pixel = 0; pixel < 8; pixel += 1) after.data[pixel * 4] = 254;
  const calibrated = compareImages(
    PNG.sync.write(before),
    PNG.sync.write(after),
  );
  assert.equal(calibrated.changedPixels, 8);
  assert.equal(calibrated.roundingPixels, 8);
  assert.equal(calibrated.contentChangedPixels, 0);
  after.data[8 * 4] = 254;
  const dense = compareImages(PNG.sync.write(before), PNG.sync.write(after));
  assert.equal(dense.roundingPixels, 0);
  assert.equal(dense.contentChangedPixels, 9);
});
