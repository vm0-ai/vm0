#!/usr/bin/env node
/**
 * analyze-call-frequency.mjs
 *
 * Detects abnormally high-frequency function calls in a V8 .cpuprofile.
 * A function called 10,000 times × 0.1ms is more suspicious than one called
 * once for 1000ms. This script separates the two cases.
 *
 * Usage:
 *   node scripts/analyze-call-frequency.mjs <file.cpuprofile> [--top N] [--min-runs N]
 *
 * Output:
 *   - Functions sorted by number of distinct invocation "runs"
 *   - Shows: total_ms, run_count, avg_ms_per_run, max_run_ms
 *   - High run_count + low avg_ms = hot polling loop candidate
 */

import { readFileSync } from "fs";

const args = process.argv.slice(2);
const file = args.find((a) => a.endsWith(".cpuprofile"));
if (!file) {
  console.error(
    "Usage: node analyze-call-frequency.mjs <file.cpuprofile> [--top N] [--min-runs N]",
  );
  process.exit(1);
}

let topN = 60;
let minRuns = 5;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--top" && args[i + 1]) topN = parseInt(args[++i], 10);
  if (args[i] === "--min-runs" && args[i + 1])
    minRuns = parseInt(args[++i], 10);
}

const profile = JSON.parse(readFileSync(file, "utf8"));
const { nodes, samples, timeDeltas } = profile;

// Build node map and parent map
const nodeMap = new Map();
for (const n of nodes) nodeMap.set(n.id, n);

const parentOf = new Map();
for (const n of nodes) {
  for (const childId of n.children ?? []) {
    parentOf.set(childId, n.id);
  }
}

// Build full call stack for each sample (leaf → root)
function getStack(leafId) {
  const stack = new Set();
  let id = leafId;
  while (id != null) {
    stack.add(id);
    id = parentOf.get(id);
  }
  return stack;
}

function nodeLabel(n) {
  const f = n.callFrame;
  const name = f.functionName || "(anonymous)";
  const url = (f.url || "")
    .replace(/.*\/node_modules\//, "nm/")
    .replace(/.*\/apps\/platform\/src\//, "src/")
    .replace(/.*\/packages\//, "pkg/")
    .replace(/\?.*/, "");
  return `${name}  [${url}:${f.lineNumber}]`;
}

// ── Pass 1: Self-time run detection ────────────────────────────────────────
// For every function, count consecutive "runs" where it is the leaf (self-time).
// Each run = one unbroken sequence of samples where this function is the leaf.
const selfRuns = new Map(); // nodeId → { totalMs, runCount, maxRunMs, currentRunMs }

let prevLeaf = -1;

for (let i = 0; i < samples.length; i++) {
  const leafId = samples[i];
  const dt = (timeDeltas[i] ?? 0) / 1000;

  if (leafId !== prevLeaf) {
    // Close previous run
    if (prevLeaf !== -1) {
      const s = selfRuns.get(prevLeaf);
      s.maxRunMs = Math.max(s.maxRunMs, s.currentRunMs);
      s.currentRunMs = 0;
    }
    // Start or continue tracking for this node
    if (!selfRuns.has(leafId)) {
      selfRuns.set(leafId, {
        totalMs: 0,
        runCount: 0,
        maxRunMs: 0,
        currentRunMs: 0,
      });
    }
    const s = selfRuns.get(leafId);
    s.runCount++;
    prevLeaf = leafId;
  }

  const s = selfRuns.get(leafId);
  s.totalMs += dt;
  s.currentRunMs += dt;
}
// Close final run
if (prevLeaf !== -1) {
  const s = selfRuns.get(prevLeaf);
  s.maxRunMs = Math.max(s.maxRunMs, s.currentRunMs);
}

// ── Pass 2: Total-time run detection ───────────────────────────────────────
// For each function, detect every time it enters and exits the call stack.
// Entry = function was NOT in previous sample's stack, IS in current.
// Exit  = function WAS in previous sample's stack, is NOT in current.
// This is expensive (O(samples × stackDepth)) so we use Set diffing.

const totalRuns = new Map(); // nodeId → { totalMs, runCount, maxRunMs, currentRunMs, inStack }

let prevStack = new Set();

for (let i = 0; i < samples.length; i++) {
  const leafId = samples[i];
  const dt = (timeDeltas[i] ?? 0) / 1000;
  const curStack = getStack(leafId);

  // Functions that entered this sample
  for (const id of curStack) {
    if (!prevStack.has(id)) {
      if (!totalRuns.has(id)) {
        totalRuns.set(id, {
          totalMs: 0,
          runCount: 0,
          maxRunMs: 0,
          currentRunMs: 0,
        });
      }
      totalRuns.get(id).runCount++;
    }
  }

  // Accumulate time for all functions in current stack
  for (const id of curStack) {
    const t = totalRuns.get(id);
    if (t) {
      t.totalMs += dt;
      t.currentRunMs += dt;
    }
  }

  // Functions that exited this sample (close their current run)
  for (const id of prevStack) {
    if (!curStack.has(id)) {
      const t = totalRuns.get(id);
      if (t) {
        t.maxRunMs = Math.max(t.maxRunMs, t.currentRunMs);
        t.currentRunMs = 0;
      }
    }
  }

  prevStack = curStack;
}
// Close all still-open runs
for (const [, t] of totalRuns) {
  t.maxRunMs = Math.max(t.maxRunMs, t.currentRunMs);
}

const totalCapturedMs = timeDeltas.reduce((s, d) => s + (d ?? 0) / 1000, 0);

// ── Output ─────────────────────────────────────────────────────────────────
const W = 130;
const line = "─".repeat(W);

console.log(`\n${line}`);
console.log(`📊  Call Frequency Analysis: ${file}`);
console.log(
  `⏱   Total captured: ${totalCapturedMs.toFixed(0)}ms  |  Samples: ${samples.length}`,
);
console.log(line);

// Self-time frequency table
console.log(
  "\n── 🔥 SELF-TIME: sorted by run_count (high = called very frequently as CPU leaf) ──\n",
);
console.log(
  `${"self_ms".padStart(9)} ${"runs".padStart(7)} ${"avg_ms".padStart(8)} ${"max_ms".padStart(8)}  function`,
);
console.log(line);

const selfSorted = [...selfRuns.entries()]
  .filter(([, s]) => s.runCount >= minRuns && s.totalMs > 1)
  .sort((a, b) => b[1].runCount - a[1].runCount)
  .slice(0, topN);

for (const [id, s] of selfSorted) {
  const n = nodeMap.get(id);
  if (!n) continue;
  const avg = s.totalMs / s.runCount;
  const flag = s.runCount > 500 && avg < 1 ? " ⚠️ HOT-LOOP?" : "";
  console.log(
    `${s.totalMs.toFixed(1).padStart(9)} ${String(s.runCount).padStart(7)} ${avg.toFixed(2).padStart(8)} ${s.maxRunMs.toFixed(1).padStart(8)}  ${nodeLabel(n)}${flag}`,
  );
}

// Total-time frequency table
console.log(
  "\n── 🔁 TOTAL-TIME: sorted by run_count (high = re-entered call stack very often) ──\n",
);
console.log(
  `${"total_ms".padStart(9)} ${"entries".padStart(9)} ${"avg_ms".padStart(8)} ${"max_ms".padStart(8)}  function`,
);
console.log(line);

const totalSorted = [...totalRuns.entries()]
  .filter(([, t]) => t.runCount >= minRuns && t.totalMs > 2)
  .sort((a, b) => b[1].runCount - a[1].runCount)
  .slice(0, topN);

for (const [id, t] of totalSorted) {
  const n = nodeMap.get(id);
  if (!n) continue;
  const avg = t.totalMs / t.runCount;
  const flag = t.runCount > 200 && avg < 5 ? " ⚠️ FREQUENT?" : "";
  console.log(
    `${t.totalMs.toFixed(1).padStart(9)} ${String(t.runCount).padStart(9)} ${avg.toFixed(2).padStart(8)} ${t.maxRunMs.toFixed(1).padStart(8)}  ${nodeLabel(n)}${flag}`,
  );
}

console.log(`\n${line}`);
console.log(
  `  Flags: ⚠️ HOT-LOOP? = runCount>500 & avg<1ms  |  FREQUENT? = entries>200 & avg<5ms`,
);
console.log(line);
