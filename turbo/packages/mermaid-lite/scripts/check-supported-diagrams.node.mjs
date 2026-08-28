import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const distDirectory = path.join(packageRoot, "dist");
const entryPath = path.join(distDirectory, "mermaid.esm.min.mjs");

const expectedDigests = new Map([
  [
    "dist/mermaid.esm.min.mjs",
    "98d350b1e1fcaf90fc1160df2257896fd3d27fcd421ee726e013407113ca7f7d",
  ],
]);

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

await test("keeps the pinned static supported-diagrams distribution", async () => {
  assert.deepEqual((await readdir(distDirectory)).sort(), [
    "index.d.ts",
    "mermaid.esm.min.mjs",
  ]);

  for (const [relativePath, expectedDigest] of expectedDigests) {
    const contents = await readFile(path.join(packageRoot, relativePath));
    assert.equal(sha256(contents), expectedDigest, relativePath);
  }

  const entry = await readFile(entryPath, "utf8");
  assert.doesNotMatch(entry, /\bimport\(/u);
  assert.doesNotMatch(entry, /(?:^|\n)import(?:\s|\{|\*|["'])/u);
});

await test("parses Flowchart and Sequence Diagram and rejects other types", async () => {
  const { default: mermaid } = await import(pathToFileURL(entryPath).href);

  const flowchart = await mermaid.parse("flowchart TD\n  A --> B", {
    suppressErrors: true,
  });
  const graph = await mermaid.parse("graph LR\n  A --> B", {
    suppressErrors: true,
  });
  assert.equal(flowchart.diagramType, "flowchart-v2");
  assert.equal(graph.diagramType, "flowchart-v2");

  const sequence = await mermaid.parse(
    "sequenceDiagram\n  Alice->>Bob: hello",
    { suppressErrors: true },
  );
  assert.equal(sequence.diagramType, "sequence");

  const unsupportedSources = [
    "classDiagram\n  A <|-- B",
    "stateDiagram-v2\n  [*] --> Ready",
    "erDiagram\n  USER ||--o{ ORDER : places",
    "gantt\n  title Schedule",
    "mindmap\n  root((vm0))",
    "architecture-beta\n  service api(server)[API]",
    "timeline\n  title Releases",
  ];
  for (const source of unsupportedSources) {
    assert.equal(
      await mermaid.parse(source, { suppressErrors: true }),
      false,
      source,
    );
  }
});
