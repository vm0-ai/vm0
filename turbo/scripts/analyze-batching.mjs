#!/usr/bin/env node
/**
 * analyze-batching.mjs
 *
 * Investigates whether multiple ccstate signal updates from a single event
 * cause 1 or N React re-renders.
 *
 * For each renderWithHooksAgain occurrence:
 *   - Groups by the enclosing performSyncWorkOnRoot call (= one React work loop)
 *   - Within each work loop, counts how many renderWithHooksAgain calls happened
 *   - Breaks down by component
 *
 * If batching works correctly, N signal updates → 1 work loop with N rewinds
 * (all within the same React batch), not N separate work loops.
 *
 * Usage:
 *   node scripts/analyze-batching.mjs <file.cpuprofile> [--component ZeroSidebar]
 */

import { readFileSync } from "fs";

const args = process.argv.slice(2);
const file = args.find((a) => a.endsWith(".cpuprofile"));
if (!file) {
  console.error(
    "Usage: node analyze-batching.mjs <file.cpuprofile> [--component ComponentName]",
  );
  process.exit(1);
}

let filterComponent = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--component" && args[i + 1]) filterComponent = args[++i];
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
  chain.reverse(); // root first
  return chain;
}

const REACT_RENDER_INTERNALS = new Set([
  "renderWithHooksAgain",
  "renderWithHooks",
  "callComponentInDEV",
  "callComponent",
  "react_stack_bottom_frame",
  "runWithFiberInDEV",
  "Object.<anonymous>",
]);

// ── Scan samples ────────────────────────────────────────────────────────────
// Each entry: { sampleIdx, timeMs, workLoopNodeId, workLoopTimeMs, componentLabel, chainSummary }
const rewindSamples = [];

const WORK_LOOP_FNS = new Set([
  "performSyncWorkOnRoot",
  "performConcurrentWorkOnRoot",
  "renderRootSync",
  "renderRootConcurrent",
]);

for (let i = 0; i < samples.length; i++) {
  const leafId = samples[i];
  const dt = (timeDeltas[i] ?? 0) / 1000;
  const chain = getChain(leafId);

  // Check for renderWithHooksAgain in chain
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
  for (let j = rwhaPos + 1; j < chain.length; j++) {
    const n = nodeMap.get(chain[j]);
    if (!n) continue;
    const name = nodeName(n);
    if (!REACT_RENDER_INTERNALS.has(name) && name !== "(anonymous)") {
      componentNode = n;
      break;
    }
  }
  const compLabel = componentNode ? nodeLabel(componentNode) : "(unknown)";

  // Filter by component name if specified
  if (filterComponent && !compLabel.includes(filterComponent)) continue;

  // Find the outermost work-loop node
  let workLoopNodeId = null;
  for (let j = 0; j < chain.length; j++) {
    const n = nodeMap.get(chain[j]);
    if (n && WORK_LOOP_FNS.has(nodeName(n))) {
      workLoopNodeId = chain[j];
      break; // first (outermost) work loop
    }
  }

  // Find renderRootSync specifically
  let renderRootNodeId = null;
  for (let j = 0; j < chain.length; j++) {
    const n = nodeMap.get(chain[j]);
    if (n && nodeName(n) === "renderRootSync") {
      renderRootNodeId = chain[j];
      break;
    }
  }

  rewindSamples.push({
    sampleIdx: i,
    timeMs: dt,
    workLoopNodeId,
    renderRootNodeId,
    componentLabel: compLabel,
  });
}

// ── Group by work loop ───────────────────────────────────────────────────────
// A "work loop boundary" is a new workLoopNodeId that we haven't seen consecutively
// We track "runs" of consecutive samples within the same work loop
const workLoopGroups = new Map(); // workLoopNodeId → { count, ms, components: Map<label, count> }

let prevWorkLoopId = null;
let runId = 0; // synthetic run counter when same node appears non-consecutively

const runs = []; // { runId, workLoopNodeId, entries }
let currentRun = null;

for (const s of rewindSamples) {
  const wlId = s.workLoopNodeId ?? `sample_${s.sampleIdx}`;

  if (currentRun === null || currentRun.workLoopNodeId !== wlId) {
    // New run boundary
    currentRun = { runId: ++runId, workLoopNodeId: wlId, entries: [] };
    runs.push(currentRun);
  }
  currentRun.entries.push(s);
}

// Aggregate
for (const run of runs) {
  const wlId = run.workLoopNodeId;
  if (!workLoopGroups.has(wlId)) {
    workLoopGroups.set(wlId, {
      runs: 0,
      totalSamples: 0,
      totalMs: 0,
      components: new Map(),
    });
  }
  const g = workLoopGroups.get(wlId);
  g.runs++;
  g.totalSamples += run.entries.length;
  g.totalMs += run.entries.reduce((s, e) => s + e.timeMs, 0);
  for (const e of run.entries) {
    const c = g.components.get(e.componentLabel) ?? 0;
    g.components.set(e.componentLabel, c + 1);
  }
}

// ── Output ────────────────────────────────────────────────────────────────────
const W = 140;
const line = "─".repeat(W);
const totalCapturedMs = timeDeltas.reduce((s, d) => s + (d ?? 0) / 1000, 0);

console.log(`\n${line}`);
console.log(`📦  React Batching Analysis: ${file}`);
if (filterComponent)
  console.log(`🔍  Filtering for component: ${filterComponent}`);
console.log(
  `⏱   Total: ${totalCapturedMs.toFixed(0)}ms  |  renderWithHooksAgain samples: ${rewindSamples.length}`,
);
console.log(line);

// ── Per-run distribution ────────────────────────────────────────────────────
const runSizes = runs.map((r) => r.entries.length);
const singletonRuns = runSizes.filter((x) => x === 1).length;
const multiRuns = runSizes.filter((x) => x > 1).length;
const maxRun = Math.max(...runSizes, 0);

console.log(`\n── 📊 RENDER LOOP RUN DISTRIBUTION ──\n`);
console.log(`  Total renderWithHooksAgain samples: ${rewindSamples.length}`);
console.log(`  Distinct work-loop runs containing rewinds: ${runs.length}`);
console.log(`  Single-rewind runs (no stacking): ${singletonRuns}`);
console.log(`  Multi-rewind runs (batched stacking): ${multiRuns}`);
console.log(`  Max rewinds in one work loop run: ${maxRun}`);

if (runs.length > 0) {
  // Histogram of run sizes
  const hist = new Map();
  for (const s of runSizes) hist.set(s, (hist.get(s) ?? 0) + 1);
  console.log(`\n  Distribution of rewinds-per-run:`);
  for (const [size, count] of [...hist.entries()].sort((a, b) => a[0] - b[0])) {
    const bar = "█".repeat(Math.min(count, 50));
    console.log(
      `    ${String(size).padStart(4)} rewinds: ${String(count).padStart(4)} runs  ${bar}`,
    );
  }
}

// ── Top multi-rewind runs ───────────────────────────────────────────────────
const topRuns = [...runs]
  .sort((a, b) => b.entries.length - a.entries.length)
  .slice(0, 10);
if (topRuns.length > 0 && topRuns[0].entries.length > 1) {
  console.log(
    `\n── 🔥 TOP MULTI-REWIND RUNS (= potential batching opportunities) ──\n`,
  );
  for (const run of topRuns) {
    if (run.entries.length < 2) break;
    const wlNode = nodeMap.get(
      typeof run.workLoopNodeId === "number" ? run.workLoopNodeId : -1,
    );
    const wlLabel = wlNode ? nodeLabel(wlNode) : `(node ${run.workLoopNodeId})`;
    console.log(
      `  Run #${run.runId}: ${run.entries.length} rewinds  [${wlLabel}]`,
    );
    // Show component breakdown
    const compCounts = new Map();
    for (const e of run.entries) {
      compCounts.set(
        e.componentLabel,
        (compCounts.get(e.componentLabel) ?? 0) + 1,
      );
    }
    for (const [comp, cnt] of [...compCounts.entries()].sort(
      (a, b) => b[1] - a[1],
    )) {
      console.log(`      ${String(cnt).padStart(4)}× ${comp}`);
    }
  }
}

// ── Per-component rewind counts ─────────────────────────────────────────────
console.log(`\n── 🧩 PER-COMPONENT REWIND COUNTS ──\n`);
const byComp = new Map();
for (const s of rewindSamples) {
  const d = byComp.get(s.componentLabel) ?? { count: 0, ms: 0 };
  d.count++;
  d.ms += s.timeMs;
  byComp.set(s.componentLabel, d);
}
const compRows = [...byComp.entries()].sort((a, b) => b[1].count - a[1].count);
for (const [comp, d] of compRows) {
  console.log(
    `  ${String(d.count).padStart(5)} samples  ${d.ms.toFixed(1).padStart(7)}ms  ${comp}`,
  );
}

// ── renderRootSync grouping ──────────────────────────────────────────────────
// Count how many distinct renderRootSync nodes contain rewinds
const renderRootNodes = new Set(
  rewindSamples.map((s) => s.renderRootNodeId).filter(Boolean),
);
console.log(
  `\n── 🔄 renderRootSync INSTANCES containing rewinds: ${renderRootNodes.size} ──`,
);
if (renderRootNodes.size <= 20) {
  for (const nodeId of renderRootNodes) {
    const samplesInNode = rewindSamples.filter(
      (s) => s.renderRootNodeId === nodeId,
    );
    console.log(`  node ${nodeId}: ${samplesInNode.length} rewind samples`);
  }
}

console.log(`\n${line}`);
