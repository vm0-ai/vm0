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
    "1b7360f53257614f150cb8c79aa31016047d8d65ddb07bd54405b8b4f48b98a1",
  ],
]);

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

await test("keeps the pinned static flowchart-only distribution", async () => {
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
