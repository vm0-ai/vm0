#!/usr/bin/env node
/**
 * dump-rewind-chains.mjs
 *
 * Dumps the FULL call chains for a specific component's renderWithHooksAgain
 * samples. Shows exactly what's in the call stack, letting us trace the causal
 * path without guessing.
 *
 * Usage:
 *   node scripts/dump-rewind-chains.mjs <file.cpuprofile> --component ZeroSidebar [--max 5]
 */

import { readFileSync } from "fs";

const args = process.argv.slice(2);
const file = args.find((a) => a.endsWith(".cpuprofile"));
if (!file) {
  console.error(
    "Usage: node dump-rewind-chains.mjs <file.cpuprofile> --component Name [--max N]",
  );
  process.exit(1);
}

let filterComponent = "ZeroSidebar";
let maxChains = 10;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--component" && args[i + 1]) filterComponent = args[++i];
  if (args[i] === "--max" && args[i + 1]) maxChains = parseInt(args[++i], 10);
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

function getChain(leafId) {
  const chain = [];
  let id = leafId;
  while (id != null) {
    chain.push(id);
    id = parentOf.get(id);
  }
  chain.reverse();
  return chain;
}

const REACT_RENDER_INTERNALS = new Set([
  "renderWithHooksAgain",
  "renderWithHooks",
  "callComponentInDEV",
  "callComponent",
  "react_stack_bottom_frame",
  "runWithFiberInDEV",
]);

// ── Collect rewind samples for the target component ────────────────────────
const collected = [];

for (let i = 0; i < samples.length; i++) {
  const leafId = samples[i];
  const dt = (timeDeltas[i] ?? 0) / 1000;
  const chain = getChain(leafId);

  let rwhaPos = -1;
  for (let j = 0; j < chain.length; j++) {
    const n = nodeMap.get(chain[j]);
    if (n && nodeName(n) === "renderWithHooksAgain") {
      rwhaPos = j;
      break;
    }
  }
  if (rwhaPos === -1) continue;

  // Find the component
  let componentNode = null;
  let componentPos = -1;
  for (let j = rwhaPos + 1; j < chain.length; j++) {
    const n = nodeMap.get(chain[j]);
    if (!n) continue;
    const name = nodeName(n);
    if (!REACT_RENDER_INTERNALS.has(name) && name !== "Object.<anonymous>") {
      componentNode = n;
      componentPos = j;
      break;
    }
  }

  if (!componentNode) continue;
  const compLabel = nodeLabel(componentNode);
  if (!compLabel.includes(filterComponent)) continue;

  collected.push({ sampleIdx: i, dt, chain, rwhaPos, componentPos });
  if (collected.length >= maxChains) break;
}

// ── Output ─────────────────────────────────────────────────────────────────
const W = 140;
const line = "─".repeat(W);

console.log(`\n${line}`);
console.log(`🔎  Full Chain Dump for ${filterComponent} renderWithHooksAgain`);
console.log(`    First ${collected.length} samples`);
console.log(line);

// Highlight functions of interest
function highlight(label) {
  if (label.includes("renderWithHooksAgain")) return `🔴 ${label}`;
  if (label.includes("updateSyncExternalStore")) return `🟡 ${label}`;
  if (label.includes("ccstate")) return `🟢 ${label}`;
  if (
    label.includes("src/") ||
    label.includes("web/") ||
    label.includes("pkg/")
  )
    return `🔵 ${label}`;
  return `   ${label}`;
}

for (const { sampleIdx, dt, chain, rwhaPos } of collected) {
  console.log(`\n── Sample #${sampleIdx} (${dt.toFixed(1)}ms) ──`);

  // Print from rwhaPos-2 to leaf, skipping boring react/v8 frames
  const SKIP = new Set(["(root)", "Timer", "process", ""]);
  let depth = 0;
  let printedAny = false;
  for (let j = Math.max(0, rwhaPos - 2); j < chain.length; j++) {
    const n = nodeMap.get(chain[j]);
    if (!n) continue;
    const name = nodeName(n);
    if (SKIP.has(name) && j < rwhaPos) continue;

    const label = nodeLabel(n);
    const indent = "  ".repeat(depth);
    console.log(`${indent}${highlight(label)}`);
    depth++;
    printedAny = true;
  }
}

// ── Unique "interesting" subtrees: what's below renderWithHooksAgain ────────
console.log(`\n${line}`);
console.log(
  `\n── 📊 NON-REACT NODES IN CHAIN (after renderWithHooksAgain) — by frequency ──\n`,
);

const nodeFreq = new Map();
for (const { chain, rwhaPos } of collected) {
  for (let j = rwhaPos + 1; j < chain.length; j++) {
    const n = nodeMap.get(chain[j]);
    if (!n) continue;
    const url = n.callFrame.url || "";
    // Only count non-react-dom, non-scheduler nodes
    if (url.includes("react-dom/cjs") || url.includes("scheduler")) continue;
    const label = nodeLabel(n);
    nodeFreq.set(label, (nodeFreq.get(label) ?? 0) + 1);
  }
}

const freqSorted = [...nodeFreq.entries()].sort((a, b) => b[1] - a[1]);
console.log(`${"count".padStart(7)}  node`);
console.log(line);
for (const [label, count] of freqSorted.slice(0, 40)) {
  const marker = label.includes("ccstate")
    ? " 🟢"
    : label.includes("src/") || label.includes("pkg/")
      ? " 🔵"
      : "";
  console.log(`${String(count).padStart(7)}  ${label}${marker}`);
}

console.log(`\n${line}`);
