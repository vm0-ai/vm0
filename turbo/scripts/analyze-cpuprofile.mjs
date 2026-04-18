#!/usr/bin/env node
/**
 * Analyze a V8 .cpuprofile and show a flame-style breakdown.
 *
 * Usage:
 *   node scripts/analyze-cpuprofile.mjs <file.cpuprofile> [--root <functionName>] [--top N]
 *
 * --root <fn>  : only count samples that pass through this function (default: show global top)
 * --top N      : show top N hot functions (default: 40)
 */

import { readFileSync } from "fs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--") && a.endsWith(".cpuprofile"));
if (!file) {
  console.error(
    "Usage: node analyze-cpuprofile.mjs <file.cpuprofile> [--root <fn>] [--top N]",
  );
  process.exit(1);
}

let rootFilter = null;
let topN = 40;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--root" && args[i + 1]) rootFilter = args[++i];
  if (args[i] === "--top" && args[i + 1]) topN = parseInt(args[++i], 10);
}

const profile = JSON.parse(readFileSync(file, "utf8"));
const { nodes, samples, timeDeltas } = profile;

// Build node map and parent map
const nodeMap = new Map();
for (const n of nodes) {
  nodeMap.set(n.id, n);
}

// Build parent lookup: childId → parentId
const parentOf = new Map();
for (const n of nodes) {
  for (const childId of n.children ?? []) {
    parentOf.set(childId, n.id);
  }
}

// For each sample, get the full call stack (bottom → top)
function getStack(leafId) {
  const stack = [];
  let id = leafId;
  while (id != null) {
    stack.push(id);
    id = parentOf.get(id);
  }
  return stack; // index 0 = leaf (hottest), last = root
}

function nodeLabel(n) {
  const f = n.callFrame;
  const name = f.functionName || "(anonymous)";
  const url = f.url || "";
  const short = url
    .replace(/.*\/node_modules\//, "nm/")
    .replace(/.*\/apps\/platform\/src\//, "src/")
    .replace(/.*\/packages\//, "pkg/")
    .replace(/\?.*/, "");
  return `${name}  [${short}:${f.lineNumber}]`;
}

// Accumulate self time and total time per node
// selfMs[nodeId] = ms where this node is the leaf
// totalMs[nodeId] = ms where this node appears anywhere in stack
const selfMs = new Map();
const totalMs = new Map();
let totalSampleMs = 0;

for (let i = 0; i < samples.length; i++) {
  const leafId = samples[i];
  const dt = (timeDeltas[i] ?? 0) / 1000; // μs → ms

  const stack = getStack(leafId);

  // Apply root filter: only count this sample if rootFilter appears in the stack
  if (rootFilter) {
    const inStack = stack.some((id) => {
      const n = nodeMap.get(id);
      return n?.callFrame.functionName === rootFilter;
    });
    if (!inStack) continue;
  }

  totalSampleMs += dt;

  // Self time: only the leaf
  selfMs.set(leafId, (selfMs.get(leafId) ?? 0) + dt);

  // Total time: every node in the stack (deduplicated per sample)
  const seen = new Set();
  for (const id of stack) {
    if (!seen.has(id)) {
      seen.add(id);
      totalMs.set(id, (totalMs.get(id) ?? 0) + dt);
    }
  }
}

// Sort by self time
const bySelf = [...selfMs.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);

// Sort by total time
const byTotal = [...totalMs.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, topN);

const W = 110;
const line = "─".repeat(W);

function pct(ms) {
  return totalSampleMs > 0 ? ((ms / totalSampleMs) * 100).toFixed(1) : "0.0";
}
function bar(ms, width = 20) {
  const filled = Math.round(Math.min(ms / totalSampleMs, 1) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

console.log(`\n${line}`);
console.log(`📊  CPU Profile: ${file}`);
if (rootFilter)
  console.log(
    `🔍  Root filter: ${rootFilter}  (only samples passing through this function)`,
  );
console.log(
  `⏱   Captured: ${totalSampleMs.toFixed(0)}ms  |  Samples: ${samples.length}`,
);
console.log(line);

console.log(
  "\n── TOP BY SELF TIME (where CPU actually was) ──────────────────────────────\n",
);
console.log(
  `${"self_ms".padStart(8)}  ${"pct".padStart(5)}  ${"bar".padEnd(20)}  function`,
);
console.log(line);
for (const [id, ms] of bySelf) {
  const n = nodeMap.get(id);
  if (!n) continue;
  console.log(
    `${ms.toFixed(1).padStart(8)}  ${pct(ms).padStart(4)}%  ${bar(ms)}  ${nodeLabel(n)}`,
  );
}

console.log(
  "\n── TOP BY TOTAL TIME (inclusive of callees) ────────────────────────────────\n",
);
console.log(
  `${"total_ms".padStart(8)}  ${"pct".padStart(5)}  ${"bar".padEnd(20)}  function`,
);
console.log(line);
for (const [id, ms] of byTotal) {
  const n = nodeMap.get(id);
  if (!n) continue;
  console.log(
    `${ms.toFixed(1).padStart(8)}  ${pct(ms).padStart(4)}%  ${bar(ms)}  function: ${nodeLabel(n)}`,
  );
}

console.log(`\n${line}`);
console.log(`  Full profile: ${file}`);
console.log(`  Load in Chrome: DevTools → Performance → Load Profile`);
console.log(line);
