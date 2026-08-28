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
const entryPath = path.join(packageRoot, "dist/mermaid.esm.tiny.min.mjs");
const chunkDirectory = path.join(
  packageRoot,
  "dist/chunks/mermaid.esm.tiny.min",
);

const expectedDigests = new Map([
  [
    "dist/mermaid.esm.tiny.min.mjs",
    "56525632e41663e4e57aab6cc94894b8a0773278c19f631d96c66a2b6f174b68",
  ],
  [
    "dist/chunks/mermaid.esm.tiny.min/chunk-GUGCH254.mjs",
    "75f76354779804a3c968c67cadb4c96dbc0308c20755adec28e9a1fa575a5a25",
  ],
  [
    "dist/chunks/mermaid.esm.tiny.min/chunk-TAHKRH63.mjs",
    "0555a9f9524e74f0d5d8696e21d1824580509f8101db17945b691975f33bb3a1",
  ],
  [
    "dist/chunks/mermaid.esm.tiny.min/dagre-QHMTOQ3A.mjs",
    "5a5835c70b778fff3a87f583518b9335c8d04b162ac161ba1c4dd6a747f1288c",
  ],
  [
    "dist/chunks/mermaid.esm.tiny.min/flowDiagram-ZIXFXPGV.mjs",
    "2ca4812d9d6d8476c4556f2cea299ca9ca87f04887d2090bf073670a4b270eac",
  ],
]);

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

await test("keeps the pinned flowchart-only distribution", async () => {
  const chunkFiles = (await readdir(chunkDirectory)).sort();
  assert.deepEqual(chunkFiles, [
    "chunk-GUGCH254.mjs",
    "chunk-TAHKRH63.mjs",
    "dagre-QHMTOQ3A.mjs",
    "flowDiagram-ZIXFXPGV.mjs",
  ]);

  for (const [relativePath, expectedDigest] of expectedDigests) {
    const contents = await readFile(path.join(packageRoot, relativePath));
    assert.equal(sha256(contents), expectedDigest, relativePath);
  }
});

await test("parses Flowchart and rejects other Mermaid diagram types", async () => {
  const { default: mermaid } = await import(pathToFileURL(entryPath).href);

  const flowchart = await mermaid.parse("flowchart TD\n  A --> B", {
    suppressErrors: true,
  });
  const graph = await mermaid.parse("graph LR\n  A --> B", {
    suppressErrors: true,
  });
  assert.equal(flowchart.diagramType, "flowchart-v2");
  assert.equal(graph.diagramType, "flowchart-v2");

  const unsupportedSources = [
    "sequenceDiagram\n  A->>B: hello",
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
