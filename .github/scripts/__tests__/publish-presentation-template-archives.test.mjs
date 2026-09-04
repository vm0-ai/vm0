import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { computeVersionId } from "../publish-presentation-template-archives.mjs";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("content version ids are independent of manifest order", () => {
  const files = [
    { path: "example/b.txt", hash: digest("b") },
    { path: "example/a.txt", hash: digest("a") },
  ];
  const reversed = [...files].reverse();

  assert.equal(
    computeVersionId("storage-id", files),
    computeVersionId("storage-id", reversed),
  );
});

test("the workflow publishes Template-artifact main directly to storage HEAD", async () => {
  const workflow = await readFile(
    new URL(
      "../../workflows/publish-presentation-template-archives.yml",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(workflow, /repository: vm0-ai\/Template-artifact/u);
  assert.match(workflow, /ref: main/u);
  assert.ok(
    workflow.indexOf("Build deterministic archives") <
      workflow.indexOf("Publish immutable R2 archives and register versions"),
  );
  assert.doesNotMatch(workflow, /presentation-template-latest-pull/u);
  assert.doesNotMatch(workflow, /archive-pins|apply-pins|render-pins/u);
  assert.doesNotMatch(workflow, /^  update-pins:/mu);
  assert.doesNotMatch(workflow, /gh pr create/u);
});
