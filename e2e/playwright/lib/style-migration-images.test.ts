import assert from "node:assert/strict";
import test from "node:test";

import { PNG } from "pngjs";

import { compareImages } from "../style-migration/images";

test("visual acceptance rejects even one changed channel and keeps a readable diff", () => {
  const before = new PNG({ width: 2, height: 1 });
  before.data.fill(255);
  const after = new PNG({ width: 2, height: 1 });
  after.data.fill(255);
  after.data[0] = 254;
  const result = compareImages(PNG.sync.write(before), PNG.sync.write(after));
  assert.equal(result.changedPixels, 1);
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
});
