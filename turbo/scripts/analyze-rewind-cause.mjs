#!/usr/bin/env node
/**
 * analyze-rewind-cause.mjs
 *
 * Finds the CAUSAL snapshot function for renderWithHooksAgain.
 *
 * The key insight: renderWithHooksAgain is caused by useSyncExternalStore
 * detecting a changed snapshot *during* the render. This shows up as a
 * sample where the call chain is:
 *
 *   renderWithHooksAgain → Component → useSyncExternalStore hooks
 *     → updateSyncExternalStore → (getSnapshot fn) → store.get(atom)
 *
 * Only samples where BOTH renderWithHooksAgain AND updateSyncExternalStore
 * are in the chain pinpoint the moment React is re-checking a snapshot and
 * finding it stale — this is the actual cause.
 *
 * Usage:
 *   node scripts/analyze-rewind-cause.mjs <file.cpuprofile> [--component ZeroSidebar]
 */

import { readFileSync } from "fs";

const args = process.argv.slice(2);
const file = args.find((a) => a.endsWith(".cpuprofile"));
if (!file) {
  console.error(
    "Usage: node analyze-rewind-cause.mjs <file.cpuprofile> [--component Name]",
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

// ── Scan for causal samples ──────────────────────────────────────────────────
// A "causal sample" = renderWithHooksAgain AND updateSyncExternalStore in chain.
// The snapshot function is the first non-react-dom node after updateSyncExternalStore.

// Key: "component::snapshotFn" → { count, ms }
const causalMap = new Map();

for (let i = 0; i < samples.length; i++) {
  const leafId = samples[i];
  const dt = (timeDeltas[i] ?? 0) / 1000;
  const chain = getChain(leafId);

  // Must have renderWithHooksAgain in chain
  let rwhaPos = -1;
  for (let j = 0; j < chain.length; j++) {
    const n = nodeMap.get(chain[j]);
    if (n && nodeName(n) === "renderWithHooksAgain") {
      rwhaPos = j;
      break;
    }
  }
  if (rwhaPos === -1) continue;

  // Find the component (first non-internal after renderWithHooksAgain)
  let componentNode = null;
  for (let j = rwhaPos + 1; j < chain.length; j++) {
    const n = nodeMap.get(chain[j]);
    if (!n) continue;
    if (
      !REACT_RENDER_INTERNALS.has(nodeName(n)) &&
      nodeName(n) !== "(anonymous)"
    ) {
      componentNode = n;
      break;
    }
  }
  const compLabel = componentNode ? nodeLabel(componentNode) : "(unknown)";

  if (filterComponent && !compLabel.includes(filterComponent)) continue;

  // Must also have updateSyncExternalStore in chain — this is the key filter
  // that proves we're in the snapshot re-check, not just somewhere during re-render
  let syncStorePos = -1;
  for (let j = 0; j < chain.length; j++) {
    const n = nodeMap.get(chain[j]);
    if (n && nodeName(n) === "updateSyncExternalStore") {
      syncStorePos = j;
      break;
    }
  }
  if (syncStorePos === -1) continue; // Not a causal sample — skip

  // Find the snapshot function: first non-react-dom node after updateSyncExternalStore
  let snapshotNode = null;
  for (let j = syncStorePos + 1; j < chain.length; j++) {
    const n = nodeMap.get(chain[j]);
    if (!n) continue;
    const url = n.callFrame.url || "";
    if (!url.includes("react-dom") && !url.includes("react/cjs")) {
      snapshotNode = n;
      break;
    }
  }

  // Also find the deepest app-code node in the snapshot call (the actual atom's read fn)
  let deepestAppNode = null;
  if (snapshotNode) {
    // Walk from snapshotNode's position toward the leaf
    const snapshotPos = chain.indexOf(snapshotNode.id);
    for (let j = chain.length - 1; j >= snapshotPos; j--) {
      const n = nodeMap.get(chain[j]);
      if (!n) continue;
      const url = n.callFrame.url || "";
      const shortUrl = url
        .replace(/.*\/node_modules\//, "nm/")
        .replace(/.*\/apps\/platform\/src\//, "src/")
        .replace(/.*\/apps\/web\/src\//, "web/")
        .replace(/.*\/packages\//, "pkg/");
      if (
        shortUrl.startsWith("src/") ||
        shortUrl.startsWith("web/") ||
        shortUrl.startsWith("pkg/")
      ) {
        deepestAppNode = n;
        break;
      }
    }
  }

  const snapLabel = snapshotNode
    ? nodeLabel(snapshotNode)
    : "(no snapshot fn found)";
  const deepLabel = deepestAppNode ? `  → ${nodeLabel(deepestAppNode)}` : "";

  const key = `${compLabel}||${snapLabel}||${deepLabel}`;
  if (!causalMap.has(key)) {
    causalMap.set(key, { count: 0, ms: 0, compLabel, snapLabel, deepLabel });
  }
  const r = causalMap.get(key);
  r.count++;
  r.ms += dt;
}

// ── Output ────────────────────────────────────────────────────────────────────
const W = 150;
const line = "─".repeat(W);
const totalCapturedMs = timeDeltas.reduce((s, d) => s + (d ?? 0) / 1000, 0);
const total = [...causalMap.values()].reduce((s, r) => s + r.count, 0);

console.log(`\n${line}`);
console.log(
  `🔬  Causal Rewind Analysis (renderWithHooksAgain + updateSyncExternalStore): ${file}`,
);
if (filterComponent)
  console.log(`🔍  Filtering for component: ${filterComponent}`);
console.log(
  `⏱   Total: ${totalCapturedMs.toFixed(0)}ms  |  Causal samples (have updateSyncExternalStore): ${total}`,
);
console.log(
  `    (These are the exact moments React detects a stale snapshot and decides to re-render)`,
);
console.log(line);

// Group by component
const byComp = new Map();
for (const [, r] of causalMap) {
  if (!byComp.has(r.compLabel)) byComp.set(r.compLabel, []);
  byComp.get(r.compLabel).push(r);
}

const compTotals = [...byComp.entries()]
  .map(([comp, rows]) => ({
    comp,
    total: rows.reduce((s, r) => s + r.count, 0),
    ms: rows.reduce((s, r) => s + r.ms, 0),
    rows,
  }))
  .sort((a, b) => b.total - a.total);

for (const { comp, total: ct, ms, rows } of compTotals) {
  console.log(
    `\n  [${"samples".padStart(6)}: ${String(ct).padStart(4)}  ms: ${ms.toFixed(1).padStart(7)}]  ${comp}`,
  );
  const sorted = [...rows].sort((a, b) => b.count - a.count);
  for (const r of sorted) {
    console.log(
      `      ${String(r.count).padStart(4)} samples  snapshot fn: ${r.snapLabel}`,
    );
    if (r.deepLabel) {
      console.log(`                    app code:    ${r.deepLabel.trim()}`);
    }
  }
}

// Also: all snapshot functions sorted by causal frequency
console.log(`\n── 📋 ALL CAUSAL SNAPSHOT FUNCTIONS (sorted by frequency) ──\n`);
const bySnap = new Map();
for (const [, r] of causalMap) {
  const k = r.snapLabel + (r.deepLabel || "");
  if (!bySnap.has(k))
    bySnap.set(k, {
      count: 0,
      ms: 0,
      snapLabel: r.snapLabel,
      deepLabel: r.deepLabel,
    });
  const s = bySnap.get(k);
  s.count += r.count;
  s.ms += r.ms;
}
const snapSorted = [...bySnap.values()].sort((a, b) => b.count - a.count);
console.log(`${"samples".padStart(9)} ${"ms".padStart(8)}  snapshot fn`);
console.log(line);
for (const s of snapSorted) {
  console.log(
    `${String(s.count).padStart(9)} ${s.ms.toFixed(1).padStart(8)}  ${s.snapLabel}`,
  );
  if (s.deepLabel)
    console.log(
      `${"".padStart(9)} ${"".padStart(8)}  app code: ${s.deepLabel.trim()}`,
    );
}
console.log(`\n${line}`);
