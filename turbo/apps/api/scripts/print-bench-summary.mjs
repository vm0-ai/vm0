#!/usr/bin/env node
// Print a one-line-per-bench summary of vitest bench --outputJson output.
// Usage: node print-bench-summary.mjs <bench-results.json>

import { readFileSync, existsSync } from "node:fs";

const path = process.argv[2] ?? "bench-results.json";
if (!existsSync(path)) {
  console.warn(`::warning::${path} not found`);
  process.exit(0);
}

const report = JSON.parse(readFileSync(path, "utf-8"));
for (const file of report.files ?? []) {
  for (const group of file.groups ?? []) {
    console.log(`\n${group.fullName}`);
    for (const bench of group.benchmarks ?? []) {
      if (typeof bench.mean !== "number") {
        console.log(`  ${bench.name}: no samples`);
        continue;
      }
      const fmt = (n) => n.toFixed(2);
      console.log(
        `  ${bench.name}: hz=${fmt(bench.hz)} ops/s  mean=${fmt(bench.mean)}ms  p99=${fmt(bench.p99)}ms  rme=±${fmt(bench.rme)}%`,
      );
    }
  }
}
