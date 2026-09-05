import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Test-only reference generation; Node is not shipped in the native application.
// Pass an installed @modelcontextprotocol/server-filesystem@2026.1.14 package directory.
if (!process.argv[2])
  throw new Error(
    "Usage: node generate-filesystem-fixtures.mjs <reference-package-dir>",
  );
const reference = pathToFileURL(path.resolve(process.argv[2]) + path.sep);
const { minimatch } = await import(
  new URL("node_modules/minimatch/dist/esm/index.js", reference)
);
const { applyFileEdits } = await import(new URL("dist/lib.js", reference));
const patterns = [
  "*.txt",
  "**/*.txt",
  "**",
  "**/node_modules/**",
  "node_modules",
  "src/{a,b}.swift",
  "a?.[ch]",
  "[!a-c]*.txt",
  "@(a|b).txt",
  "!(a).txt",
  "+(ab).txt",
  "*.{js,ts}",
  "!**/*.log",
  "\\*.txt",
  "#comment",
  "!(*.test).ts",
  "src/!(a).swift",
  "src/!(*.test).ts",
];
const paths = [
  "a.txt",
  "A.TXT",
  ".hidden.txt",
  "sub/a.txt",
  "a.log",
  "sub/a.log",
  "node_modules",
  "node_modules/a.js",
  "src/node_modules/a.js",
  "src/a.swift",
  "src/b.swift",
  "src/c.swift",
  "ab.c",
  "a2.h",
  "b.txt",
  "z.txt",
  "ab.txt",
  "abab.txt",
  "main.ts",
  "main.test.ts",
  "*.txt",
  "src/main.test.ts",
  "src/main.ts",
];
const globs = patterns.flatMap((pattern) =>
  paths.map((file) => ({
    pattern,
    path: file,
    expected: minimatch(file, pattern, { dot: true }),
  })),
);
for (const pattern of [
  "file{01..05}.txt",
  "file{5..1..2}.txt",
  "file{-3..3..2}.txt",
  "{a..e..2}.txt",
  "file{1..5..0}.txt",
  "{a..Z}.txt",
  "${a,b}.txt",
  "file{001..5}.txt",
]) {
  for (const file of [
    "file1.txt",
    "file3.txt",
    "file5.txt",
    "file01.txt",
    "file02.txt",
    "file05.txt",
    "file001.txt",
    "file005.txt",
    "file-3.txt",
    "file-1.txt",
    "a.txt",
    "b.txt",
    "c.txt",
    "e.txt",
    "Z.txt",
    "[.txt",
    "${a,b}.txt",
  ])
    globs.push({
      pattern,
      path: file,
      expected: minimatch(file, pattern, { dot: true }),
    });
}
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "okou-fs-baseline-"));
const cases = [
  {
    name: "exact first occurrence",
    original: "hello hello\n",
    edits: [{ oldText: "hello", newText: "changed" }],
  },
  {
    name: "whitespace relative indentation",
    original: "  function run() {\n    return true;\n  }\n",
    edits: [
      {
        oldText: "function run() {\n  return true;\n}",
        newText: "function run() {\n    return false;\n}",
      },
    ],
  },
  {
    name: "line ending normalization",
    original: "one\r\ntwo\r\n",
    edits: [{ oldText: "one\r\ntwo", newText: "three\r\nfour" }],
  },
  {
    name: "empty insertion",
    original: "existing",
    edits: [{ oldText: "", newText: "prefix " }],
  },
  {
    name: "sequential edits",
    original: "one two",
    edits: [
      { oldText: "one", newText: "three" },
      { oldText: "three two", newText: "done" },
    ],
  },
  {
    name: "delete content",
    original: "hello",
    edits: [{ oldText: "hello", newText: "" }],
  },
];
const long =
  Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n";
cases.push({
  name: "separate context hunks",
  original: long,
  edits: [
    { oldText: "line 2\n", newText: "changed 2\n" },
    { oldText: "line 23\n", newText: "changed 23\n" },
  ],
});
cases.push({
  name: "overlapping context hunks",
  original: long,
  edits: [
    { oldText: "line 2\n", newText: "changed 2\n" },
    { oldText: "line 8\n", newText: "changed 8\n" },
  ],
});
cases.push({
  name: "identical content",
  original: "same\n",
  edits: [{ oldText: "same", newText: "same" }],
});
let seed = 731;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed;
};
const tokens = ["a", "b", "c", "", "```", "alpha beta", "é"];
for (let i = 0; i < 60; i++) {
  const before =
    Array.from(
      { length: random() % 18 },
      () => tokens[random() % tokens.length],
    ).join("\n") + (random() % 2 ? "\n" : "");
  const after =
    Array.from(
      { length: random() % 18 },
      () => tokens[random() % tokens.length],
    ).join("\n") + (random() % 2 ? "\n" : "");
  cases.push({
    name: "line diff sample " + i,
    original: before,
    edits: [{ oldText: before, newText: after }],
  });
}
for (const [index, item] of cases.entries()) {
  const file = path.join(directory, String(index));
  await fs.writeFile(file, item.original);
  item.expectedDiff = (await applyFileEdits(file, item.edits, true))
    .split(file)
    .join("<file>");
  await applyFileEdits(file, item.edits);
  item.expected = await fs.readFile(file, "utf8");
}
await fs.rm(directory, { recursive: true });
const output = {
  source:
    "@modelcontextprotocol/server-filesystem@2026.1.14 and minimatch@" +
    JSON.parse(
      await fs.readFile(
        new URL("node_modules/minimatch/package.json", reference),
      ),
    ).version,
  globs,
  edits: cases,
};
await fs.writeFile(
  new URL(
    "../Tests/DesktopCoreTests/Fixtures/filesystem.json",
    import.meta.url,
  ),
  JSON.stringify(output, null, 2) + "\n",
);
