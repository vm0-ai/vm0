#!/usr/bin/env node
/**
 * analyze-rewind.mjs
 *
 * Traces the exact trigger of React's renderWithHooksAgain ("rewind").
 *
 * renderWithHooksAgain is fired when useSyncExternalStore detects that the
 * store snapshot changed mid-render (updateSyncExternalStore sets
 * didScheduleRenderPhaseUpdate = true). This script finds:
 *
 *   renderWithHooksAgain → component → useSyncExternalStore → getSnapshot → [signal getter]
 *
 * Usage:
 *   node scripts/analyze-rewind.mjs <file.cpuprofile> [--top N]
 */

import { readFileSync } from "fs";

const args = process.argv.slice(2);
const file = args.find((a) => a.endsWith(".cpuprofile"));
if (!file) {
  console.error("Usage: node analyze-rewind.mjs <file.cpuprofile> [--top N]");
  process.exit(1);
}

let topN = 40;
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

// Build root→leaf chain for a sample
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
  "Object.<anonymous>",
]);

const APP_URL_PREFIXES = ["src/", "web/", "pkg/"];
function isAppCode(n) {
  const url = n?.callFrame?.url || "";
  const shortUrl = url
    .replace(/.*\/apps\/platform\/src\//, "src/")
    .replace(/.*\/apps\/web\/src\//, "web/")
    .replace(/.*\/packages\//, "pkg/");
  return APP_URL_PREFIXES.some((p) => shortUrl.startsWith(p));
}

// ── Collect rewind samples ───────────────────────────────────────────────────
// A "rewind sample" = renderWithHooksAgain is in the ancestor chain.
// For each such sample, extract:
//   component = first non-internal app function after renderWithHooksAgain in chain
//   trigger   = what's happening in the leaf (the getSnapshot or store.get being called)

// Key: "component::trigger" → count
const rewindKey = new Map(); // key → { count, ms, componentLabel, triggerLabel }

for (let i = 0; i < samples.length; i++) {
  const leafId = samples[i];
  const dt = (timeDeltas[i] ?? 0) / 1000;
  const chain = getChain(leafId); // root first, leaf last

  // Find renderWithHooksAgain positions in the chain
  let rwhaPos = -1;
  for (let j = 0; j < chain.length; j++) {
    const n = nodeMap.get(chain[j]);
    if (n && nodeName(n) === "renderWithHooksAgain") {
      rwhaPos = j;
      break; // take the first one (outermost)
    }
  }
  if (rwhaPos === -1) continue;

  // Find the component: first non-internal function after renderWithHooksAgain
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

  // Find the "trigger": look for updateSyncExternalStore in the chain
  // and then what's below it (the getSnapshot function)
  let syncStorePos = -1;
  for (let j = 0; j < chain.length; j++) {
    const n = nodeMap.get(chain[j]);
    if (n && nodeName(n) === "updateSyncExternalStore") {
      syncStorePos = j;
      break;
    }
  }

  // Find the leaf-side snapshot function (what's being called when snapshot is read)
  // This is the first app-code function OR the last few nodes heading toward the leaf
  let snapshotNode = null;
  if (syncStorePos !== -1) {
    // Find first non-react-dom function after updateSyncExternalStore
    for (let j = syncStorePos + 1; j < chain.length; j++) {
      const n = nodeMap.get(chain[j]);
      if (!n) continue;
      const url = n.callFrame.url || "";
      if (!url.includes("react-dom") && !url.includes("react/cjs")) {
        snapshotNode = n;
        break;
      }
    }
  }

  // Also capture the leaf itself to see what self-time is in
  const leafNode = nodeMap.get(leafId);

  const compLabel = componentNode
    ? nodeLabel(componentNode)
    : "(unknown component)";
  const snapLabel = snapshotNode
    ? nodeLabel(snapshotNode)
    : leafNode
      ? nodeLabel(leafNode)
      : "(unknown snapshot)";

  const key = `${compLabel}||${snapLabel}`;
  if (!rewindKey.has(key)) {
    rewindKey.set(key, {
      count: 0,
      ms: 0,
      componentLabel: compLabel,
      triggerLabel: snapLabel,
    });
  }
  const r = rewindKey.get(key);
  r.count++;
  r.ms += dt;
}

// ── Output ───────────────────────────────────────────────────────────────────
const W = 150;
const line = "─".repeat(W);
const totalCapturedMs = timeDeltas.reduce((s, d) => s + (d ?? 0) / 1000, 0);
const rewindSampleCount = [...rewindKey.values()].reduce(
  (s, r) => s + r.count,
  0,
);

console.log(`\n${line}`);
console.log(`🔄  Rewind (renderWithHooksAgain) Trigger Analysis: ${file}`);
console.log(
  `⏱   Total: ${totalCapturedMs.toFixed(0)}ms  |  Rewind samples: ${rewindSampleCount}`,
);
console.log(line);

// Group by component
const byComponent = new Map();
for (const [, r] of rewindKey) {
  if (!byComponent.has(r.componentLabel)) {
    byComponent.set(r.componentLabel, []);
  }
  byComponent.get(r.componentLabel).push(r);
}

const componentTotals = [...byComponent.entries()]
  .map(([comp, rows]) => ({
    comp,
    total: rows.reduce((s, r) => s + r.count, 0),
    ms: rows.reduce((s, r) => s + r.ms, 0),
    rows,
  }))
  .sort((a, b) => b.total - a.total)
  .slice(0, topN);

console.log(`\n── 🔍 REWIND triggers by component ──\n`);

for (const { comp, total, ms, rows } of componentTotals) {
  console.log(
    `\n  [${"samples".padStart(6)}: ${String(total).padStart(4)}  ms: ${ms.toFixed(1).padStart(7)}]  ${comp}`,
  );
  const sortedRows = [...rows].sort((a, b) => b.count - a.count);
  for (const r of sortedRows) {
    console.log(
      `      ${"→".padStart(3)} ${String(r.count).padStart(4)} samples  ${r.triggerLabel}`,
    );
  }
}

console.log(`\n${line}`);

// ── Also: find all distinct getSnapshot functions called during rewinding ────
console.log(
  `\n── 📋 ALL SNAPSHOT FUNCTIONS triggered during rewind (sorted by sample count) ──\n`,
);
console.log(`${"samples".padStart(9)} ${"ms".padStart(8)}  snapshot function`);
console.log(line);

const bySnapshot = new Map();
for (const [, r] of rewindKey) {
  if (!bySnapshot.has(r.triggerLabel)) {
    bySnapshot.set(r.triggerLabel, { count: 0, ms: 0 });
  }
  const s = bySnapshot.get(r.triggerLabel);
  s.count += r.count;
  s.ms += r.ms;
}

const snapshotSorted = [...bySnapshot.entries()]
  .sort((a, b) => b[1].count - a[1].count)
  .slice(0, topN);

for (const [label, s] of snapshotSorted) {
  console.log(
    `${String(s.count).padStart(9)} ${s.ms.toFixed(1).padStart(8)}  ${label}`,
  );
}

console.log(`\n${line}`);
