#!/usr/bin/env node
/**
 * analyze-react-renders.mjs
 *
 * Finds React component render counts from a V8 .cpuprofile.
 * For each sample, walks the dynamic call chain to find which
 * component function renderWithHooks / renderWithHooksAgain called.
 *
 * Usage:
 *   node scripts/analyze-react-renders.mjs <file.cpuprofile> [--top N]
 */

import { readFileSync } from "fs";

const args = process.argv.slice(2);
const file = args.find((a) => a.endsWith(".cpuprofile"));
if (!file) {
  console.error(
    "Usage: node analyze-react-renders.mjs <file.cpuprofile> [--top N]",
  );
  process.exit(1);
}

let topN = 50;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--top" && args[i + 1]) topN = parseInt(args[++i], 10);
}

const profile = JSON.parse(readFileSync(file, "utf8"));
const { nodes, samples, timeDeltas } = profile;

const nodeMap = new Map();
for (const n of nodes) nodeMap.set(n.id, n);

const parentOf = new Map();
for (const n of nodes) {
  for (const childId of n.children ?? []) {
    parentOf.set(childId, n.id);
  }
}

function nodeName(n) {
  return n?.callFrame?.functionName || "(anonymous)";
}

function nodeLabel(n) {
  const f = n.callFrame;
  const name = f.functionName || "(anonymous)";
  const url = (f.url || "")
    .replace(/.*\/node_modules\//, "nm/")
    .replace(/.*\/apps\/platform\/src\//, "src/")
    .replace(/.*\/apps\/web\/src\//, "web/")
    .replace(/.*\/packages\//, "pkg/")
    .replace(/\?.*/, "");
  return `${name}  [${url}:${f.lineNumber}]`;
}

// React internals to skip when walking towards the component
const REACT_INTERNALS = new Set([
  "renderWithHooks",
  "renderWithHooksAgain",
  "callComponentInDEV",
  "callComponent",
  "react_stack_bottom_frame",
  "Object.<anonymous>",
  "runWithFiberInDEV",
  "invokeGuardedCallbackImpl",
  "invokeGuardedCallback",
]);

// Build full call chain for a sample: [root, ..., parent, leaf]
function getChain(leafId) {
  const chain = [];
  let id = leafId;
  while (id != null) {
    chain.push(id);
    id = parentOf.get(id);
  }
  chain.reverse(); // root first, leaf last
  return chain;
}

// ── Scan all samples ─────────────────────────────────────────────────────────
// componentRenders: nodeId → { firstCount, reCount, firstMs, reMs }
const componentData = new Map();

// Track "in flight" state to detect run boundaries
const prevChainSet = new Set();
let prevChainArr = [];

for (let i = 0; i < samples.length; i++) {
  const leafId = samples[i];
  const dt = (timeDeltas[i] ?? 0) / 1000;
  const chain = getChain(leafId);
  const chainSet = new Set(chain);

  // For each node in the chain, check if it's renderWithHooks or renderWithHooksAgain
  for (let j = 0; j < chain.length; j++) {
    const nodeId = chain[j];
    const n = nodeMap.get(nodeId);
    if (!n) continue;
    const name = nodeName(n);

    const isFirst = name === "renderWithHooks";
    const isAgain = name === "renderWithHooksAgain";
    if (!isFirst && !isAgain) continue;

    // Find the first non-React-internal function BELOW this node in the chain
    let compNode = null;
    for (let k = j + 1; k < chain.length; k++) {
      const candidate = nodeMap.get(chain[k]);
      if (!candidate) continue;
      const cname = nodeName(candidate);
      if (!REACT_INTERNALS.has(cname) && cname !== "(anonymous)") {
        compNode = candidate;
        break;
      }
    }
    if (!compNode) continue;

    const compId = compNode.id;
    if (!componentData.has(compId)) {
      componentData.set(compId, {
        firstCount: 0,
        reCount: 0,
        firstMs: 0,
        reMs: 0,
      });
    }
    const d = componentData.get(compId);

    // Accumulate time regardless of entry/exit
    if (isFirst) d.firstMs += dt;
    else d.reMs += dt;

    // Count entries (new run started this sample)
    if (!prevChainSet.has(nodeId)) {
      if (isFirst) d.firstCount++;
      else d.reCount++;
    }
  }

  prevChainArr = chain;
  // Rebuild prevChainSet — only the renderWithHooks/Again nodes matter
  prevChainSet.clear();
  for (const id of chain) {
    const n = nodeMap.get(id);
    if (!n) continue;
    const name = nodeName(n);
    if (name === "renderWithHooks" || name === "renderWithHooksAgain") {
      prevChainSet.add(id);
    }
  }
}

const W = 130;
const line = "─".repeat(W);
const totalCapturedMs = timeDeltas.reduce((s, d) => s + (d ?? 0) / 1000, 0);

console.log(`\n${line}`);
console.log(`⚛️   React Render Analysis: ${file}`);
console.log(
  `⏱   Total: ${totalCapturedMs.toFixed(0)}ms  |  Samples: ${samples.length}`,
);
console.log(line);

// ── Combined table ───────────────────────────────────────────────────────────
const rows = [...componentData.entries()]
  .map(([id, d]) => ({
    id,
    total: d.firstCount + d.reCount,
    first: d.firstCount,
    re: d.reCount,
    ms: d.firstMs + d.reMs,
  }))
  .filter((r) => r.total > 0)
  .sort((a, b) => b.total - a.total)
  .slice(0, topN);

console.log("\n── 📊 COMPONENT RENDER COUNTS (first + re-renders) ──\n");
console.log(
  `${"total".padStart(7)} ${"first".padStart(7)} ${"re".padStart(6)} ${"total_ms".padStart(10)}  component`,
);
console.log(line);

for (const r of rows) {
  const n = nodeMap.get(r.id);
  if (!n) continue;
  const reRatio = r.total > 0 ? Math.round((r.re / r.total) * 100) : 0;
  let flag = "";
  if (reRatio > 40) flag = ` ⚠️ ${reRatio}% re-renders`;
  else if (r.total > 100) flag = " ⚠️ VERY HOT";
  else if (r.total > 50) flag = " HOT";
  console.log(
    `${String(r.total).padStart(7)} ${String(r.first).padStart(7)} ${String(r.re).padStart(6)} ${r.ms.toFixed(1).padStart(10)}  ${nodeLabel(n)}${flag}`,
  );
}

// ── Worst re-render ratios ───────────────────────────────────────────────────
const reRenderAbuse = rows
  .filter((r) => r.re > 5)
  .sort((a, b) => b.re - a.re)
  .slice(0, 20);
if (reRenderAbuse.length > 0) {
  console.log("\n── 🔴 TOP RE-RENDERS (renderWithHooksAgain) ──\n");
  console.log(
    `${"re-renders".padStart(11)} ${"first".padStart(7)} ${"ratio".padStart(7)}  component`,
  );
  console.log(line);
  for (const r of reRenderAbuse) {
    const n = nodeMap.get(r.id);
    if (!n) continue;
    const reRatio = r.total > 0 ? Math.round((r.re / r.total) * 100) : 0;
    const flag =
      reRatio > 40 ? " ⚠️ RE-RENDER STORM" : reRatio > 20 ? " FREQUENT" : "";
    console.log(
      `${String(r.re).padStart(11)} ${String(r.first).padStart(7)} ${(reRatio + "%").padStart(7)}  ${nodeLabel(n)}${flag}`,
    );
  }
}

console.log(`\n${line}`);
